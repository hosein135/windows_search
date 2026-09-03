'use strict';

/**
 * Worker thread for the parallel importer (one worker per CPU core).
 *
 * A task is a BYTE RANGE ("chunk") of one CSV file, not a whole file, so a
 * single multi-GB dump is parsed by every core at once. Each worker owns its
 * own MongoDB connection and writes its batches directly - nothing is funnelled
 * through the main thread - keeping up to `inflight` bulkWrites in the air
 * while it keeps parsing (batch k+1 is parsed while k and k-1 are written).
 * Backpressure: the file stream is paused when the in-flight limit is hit and
 * when csv-parse's buffer is full.
 *
 * Optional GPU fold: text cells of a batch are sent to the main thread, which
 * shards them across every WebGPU endpoint it knows (main window adapter +
 * pinned helper-process GPUs). If the GPU path fails or times out the worker
 * simply lets buildPerson() fold on the CPU (the fold is idempotent).
 *
 * Chunk boundary rule (every byte of the file is handled exactly once):
 *   - chunk i owns the lines that START in [start, end)
 *   - a reader for start > 0 begins at start-1 and discards through the first '\n'
 *   - every reader stops after the first '\n' at absolute offset >= end-1
 * '\n' (0x0A) never occurs inside a UTF-8 multi-byte sequence, so byte-level
 * alignment is safe for these UTF-8 dumps.
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parse } = require('csv-parse');
const { MongoClient } = require('mongodb');
const { resolveSource } = require('./schemas');
const { collectFoldCells, applyFoldedCells, rowsToPersons, writePersons } = require('./importerHelpers');

const cfg = Object.assign({
  batchSize: 5000,
  inflight: 2,
  mongoUrl: 'mongodb://127.0.0.1:27017',
  dbName: 'windows_search',
  collection: 'persons',
  gpuFold: false,
  foldTimeoutMs: 30_000,
  readHighWaterMark: 1 << 20,
}, workerData || {});

/* ------------------------------------------------------------------ */
/* MongoDB connection owned by this worker                              */
/* ------------------------------------------------------------------ */

let client = null;
let col = null;

async function getCollection() {
  if (col) return col;
  client = new MongoClient(cfg.mongoUrl, {
    maxPoolSize: Math.max(2, cfg.inflight + 1),
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  col = client.db(cfg.dbName).collection(cfg.collection);
  return col;
}

/* ------------------------------------------------------------------ */
/* GPU fold broker (worker -> main -> WebGPU endpoints -> main -> worker) */
/* ------------------------------------------------------------------ */

let foldSeq = 0;
const pendingFold = new Map();

function foldViaMain(strings) {
  return new Promise((resolve) => {
    const id = ++foldSeq;
    const timer = setTimeout(() => { pendingFold.delete(id); resolve(null); }, cfg.foldTimeoutMs);
    pendingFold.set(id, { resolve, timer });
    parentPort.postMessage({ type: 'fold', id, strings });
  });
}

/* ------------------------------------------------------------------ */
/* Chunk reader                                                         */
/* ------------------------------------------------------------------ */

/**
 * Stream the lines owned by [start, end) of filePath (see the boundary rule
 * in the header). Emits 'data' (Buffer), 'end', 'error'; supports
 * pause()/resume() for backpressure.
 */
function openChunkStream(filePath, start, end) {
  const out = new EventEmitter();
  const first = start === 0;
  const rs = fs.createReadStream(filePath, {
    start: first ? 0 : start - 1,
    highWaterMark: cfg.readHighWaterMark,
  });
  let pos = first ? 0 : start - 1; // absolute offset of buf[0]
  let skipping = !first;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    rs.destroy();
    out.emit('end');
  };

  rs.on('data', (buf) => {
    if (done) return;
    let off = 0;
    if (skipping) {
      const nl = buf.indexOf(10);
      if (nl < 0) { pos += buf.length; return; }
      skipping = false;
      off = nl + 1;
      // The partial line we skipped ended at/after the stop boundary: this
      // chunk owns nothing (a single line longer than the whole chunk).
      if (pos + nl >= end - 1) { finish(); return; }
    }
    // Stop after the first '\n' at absolute offset >= end - 1.
    const boundaryIdx = (end - 1) - pos; // may be negative (boundary already passed)
    let cut = -1;
    if (boundaryIdx < buf.length) {
      const nl = buf.indexOf(10, Math.max(off, boundaryIdx));
      if (nl >= 0) cut = nl + 1;
    }
    const slice = cut >= 0 ? buf.subarray(off, cut) : (off ? buf.subarray(off) : buf);
    pos += buf.length;
    if (slice.length) out.emit('data', slice);
    if (cut >= 0) finish();
  });
  rs.on('end', finish);
  rs.on('error', (err) => { if (!done) { done = true; out.emit('error', err); } });

  out.pause = () => rs.pause();
  out.resume = () => { if (!done) rs.resume(); };
  return out;
}

/* ------------------------------------------------------------------ */
/* Task execution                                                       */
/* ------------------------------------------------------------------ */

async function runTask(task) {
  const { id, file, start, end, chunkIndex, chunks } = task;
  const source = resolveSource(file);
  if (!source) {
    parentPort.postMessage({ type: 'error', taskId: id, file: path.basename(file), error: 'Unknown CSV layout' });
    return;
  }

  const fileName = path.basename(file);
  const sourceTag = `${source.id}:${fileName}`;
  const stats = { rows: 0, persons: 0, skipped: 0, errors: 0 };
  const started = Date.now();
  const batchSize = task.batchSize || cfg.batchSize;
  let bytesRead = 0;
  let batch = [];
  let headerDone = chunkIndex !== 0; // only the first chunk can carry header rows
  let firstError = null;

  const emit = (phase) => {
    parentPort.postMessage({
      type: 'progress', taskId: id, file: fileName, chunkIndex, chunks, phase,
      rows: stats.rows, persons: stats.persons, skipped: stats.skipped,
      errors: stats.errors, bytes: bytesRead, elapsedMs: Date.now() - started,
    });
  };

  const src = openChunkStream(file, start, end);
  const parser = parse({
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
    skip_records_with_error: true,
  });

  // Two independent reasons to pause the file stream; resume only when both clear.
  let parserFull = false;
  let flushFull = false;
  const maybeResume = () => { if (!parserFull && !flushFull) src.resume(); };

  const inflight = new Set();
  let ended = false;
  let resolveDone;
  const doneP = new Promise((r) => { resolveDone = r; });
  const checkFinished = () => { if (ended && inflight.size === 0) resolveDone(); };

  const flushRows = async (rows) => {
    if (cfg.gpuFold) {
      const cells = collectFoldCells(rows, source);
      if (cells.strings.length) {
        const folded = await foldViaMain(cells.strings);
        if (folded) applyFoldedCells(rows, cells.refs, folded);
      }
    }
    const persons = rowsToPersons(rows, source, sourceTag, stats);
    if (!persons.length) return;
    const c = await getCollection();
    stats.persons += await writePersons(c, persons, stats);
  };

  const startFlush = () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    const p = flushRows(rows)
      .catch((err) => { if (!firstError) firstError = err; stats.errors += rows.length; })
      .finally(() => {
        inflight.delete(p);
        flushFull = inflight.size >= cfg.inflight;
        maybeResume();
        emit('progress');
        checkFinished();
      });
    inflight.add(p);
    if (inflight.size >= cfg.inflight) { flushFull = true; src.pause(); }
  };

  parser.on('data', (row) => {
    if (!headerDone && stats.rows < 3 && source.isHeaderRow(row)) return;
    headerDone = true;
    stats.rows++;
    batch.push(row);
    if (batch.length >= batchSize) startFlush();
  });
  parser.on('drain', () => { parserFull = false; maybeResume(); });
  parser.on('end', () => { startFlush(); ended = true; checkFinished(); });
  parser.on('error', (err) => { if (!firstError) firstError = err; ended = true; checkFinished(); });

  src.on('data', (buf) => {
    bytesRead += buf.length;
    if (!parser.write(buf)) { parserFull = true; src.pause(); }
  });
  src.on('end', () => parser.end());
  src.on('error', (err) => { if (!firstError) firstError = err; parser.end(); });

  emit('start');
  await doneP;

  if (firstError && stats.rows === 0) {
    parentPort.postMessage({ type: 'error', taskId: id, file: fileName, chunkIndex, chunks, error: firstError.message, stats, bytes: bytesRead });
    return;
  }
  parentPort.postMessage({
    type: 'done', taskId: id, file: fileName, chunkIndex, chunks, stats, bytes: bytesRead,
    elapsedMs: Date.now() - started, warning: firstError ? firstError.message : null,
  });
}

/* ------------------------------------------------------------------ */
/* Message loop                                                         */
/* ------------------------------------------------------------------ */

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'task') {
    runTask(msg.task).catch((err) => {
      parentPort.postMessage({ type: 'error', taskId: msg.task.id, file: path.basename(msg.task.file), error: err.message });
    });
  } else if (msg.type === 'fold-result') {
    const entry = pendingFold.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingFold.delete(msg.id);
    entry.resolve(Array.isArray(msg.strings) ? msg.strings : null);
  } else if (msg.type === 'shutdown') {
    const p = client ? client.close().catch(() => {}) : Promise.resolve();
    p.then(() => parentPort.postMessage({ type: 'bye' }));
  }
});
