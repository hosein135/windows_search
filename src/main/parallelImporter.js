'use strict';

/**
 * Parallel importer: every CPU core parses and writes at the same time.
 *
 * Architecture:
 *   - Files are split into byte-range CHUNKS aligned on line boundaries, so
 *     one huge dump is spread over every core instead of one worker per file.
 *   - A persistent pool of N worker threads (default: all logical CPUs) pulls
 *     chunks from a queue (largest first for a balanced tail).
 *   - Each worker owns a MongoDB connection and bulkWrites directly with a
 *     bounded number of in-flight writes; parse and write overlap per worker,
 *     and N workers write concurrently.
 *   - The main thread only aggregates progress per file and brokers optional
 *     GPU fold requests to the WebGPU endpoints (main window + helper GPUs).
 *
 * Also runs under Bun (worker_threads + mongodb) for an extra I/O speedup with
 * zero code changes.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { scanCsvFiles } = require('./importer');

const DEFAULT_WORKERS = Math.max(1, os.cpus().length);
const DEFAULT_INFLIGHT = 2;
const MIN_AUTO_CHUNK = 8 * 1024 * 1024;
const MAX_AUTO_CHUNK = 256 * 1024 * 1024;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Split files into chunk tasks.
 * opts: { workers, chunkBytes (override), split (default true) }
 * Returns { tasks, chunkBytes }.
 */
function planTasks(files, { workers = DEFAULT_WORKERS, chunkBytes = 0, split = true } = {}) {
  const sized = files.map((f) => {
    let size = f.sizeBytes || 0;
    if (!size) { try { size = fs.statSync(f.path).size; } catch { size = 0; } }
    return { ...f, sizeBytes: size };
  });
  const total = sized.reduce((a, f) => a + f.sizeBytes, 0);
  // Aim for ~2 tasks per worker so the queue stays balanced until the end.
  const target = chunkBytes > 0
    ? Math.max(1024, Math.floor(chunkBytes))
    : clamp(Math.ceil(total / Math.max(1, workers * 2)), MIN_AUTO_CHUNK, MAX_AUTO_CHUNK);

  const tasks = [];
  for (const f of sized) {
    const n = split && f.sizeBytes > target * 1.5 ? Math.ceil(f.sizeBytes / target) : 1;
    for (let i = 0; i < n; i++) {
      tasks.push({
        id: tasks.length,
        file: f.path,
        name: f.name || path.basename(f.path),
        sizeBytes: f.sizeBytes,
        chunkIndex: i,
        chunks: n,
        start: Math.floor((f.sizeBytes * i) / n),
        end: i === n - 1 ? f.sizeBytes : Math.floor((f.sizeBytes * (i + 1)) / n),
      });
    }
  }
  tasks.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  return { tasks, chunkBytes: target };
}

/**
 * Import files in parallel.
 *
 * opts: {
 *   files        absolute paths to import (default: every known CSV under dir)
 *   workers      worker threads (default: all logical CPUs)
 *   inflight     concurrent bulkWrites per worker (default 2)
 *   batchSize    rows per bulkWrite (default 5000)
 *   chunkBytes   force a chunk size (default: auto from total size / workers)
 *   split        false = one task per file (default true)
 *   mongoUrl, dbName, collection
 *   gpuFold      async (strings) => strings|null - optional GPU fold broker
 *   onProgress, signal
 * }
 * Returns totals: { files, done, tasks, tasksDone, rows, persons, skipped, errors, workers, chunkBytes }
 */
async function parallelImport(dir, opts) {
  const {
    workers = DEFAULT_WORKERS,
    inflight = DEFAULT_INFLIGHT,
    batchSize = 5000,
    chunkBytes = 0,
    split = true,
    mongoUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
    dbName = process.env.MONGO_DB || 'windows_search',
    collection = 'persons',
    gpuFold = null,
    onProgress,
    signal,
  } = opts;

  const allFiles = scanCsvFiles(dir).filter((f) => f.known);
  const files = opts.files && opts.files.length
    ? allFiles.filter((f) => opts.files.includes(f.path))
    : allFiles;

  const totals = {
    files: files.length, done: 0, tasks: 0, tasksDone: 0,
    rows: 0, persons: 0, skipped: 0, errors: 0, workers: 0, chunkBytes: 0,
  };
  if (!files.length) return totals;

  const { tasks, chunkBytes: chosenChunk } = planTasks(files, { workers, chunkBytes, split });
  const numWorkers = Math.max(1, Math.min(workers, tasks.length));
  totals.tasks = tasks.length;
  totals.workers = numWorkers;
  totals.chunkBytes = chosenChunk;

  // Per-file aggregation (a file's chunks run on different workers).
  const perFile = new Map();
  for (const f of files) {
    perFile.set(path.basename(f.path), {
      file: path.basename(f.path), sizeBytes: f.sizeBytes, source: f.source,
      rows: 0, persons: 0, skipped: 0, errors: 0, bytes: 0,
      chunks: tasks.filter((t) => t.file === f.path).length, chunksDone: 0,
      started: 0, live: new Map(), // taskId -> last progress
    });
  }
  const emit = (payload) => { if (onProgress) onProgress(payload); };

  emit({
    phase: 'plan', files: files.length, tasks: tasks.length, workers: numWorkers,
    inflight, chunkBytes: chosenChunk, gpuFold: !!gpuFold,
  });

  const workerPath = path.join(__dirname, 'importWorker.js');
  const workerData = { batchSize, inflight, mongoUrl, dbName, collection, gpuFold: !!gpuFold };

  return new Promise((resolve, reject) => {
    const pool = new Set();
    const queue = [...tasks];
    const running = new Map(); // worker -> task
    let settled = false;
    let aborted = false;

    const aggregate = (agg, msg, final) => {
      agg.live.set(msg.taskId, { rows: msg.rows || (msg.stats && msg.stats.rows) || 0, bytes: msg.bytes || 0 });
      if (final) {
        const s = msg.stats || { rows: 0, persons: 0, skipped: 0, errors: 0 };
        agg.rows += s.rows; agg.persons += s.persons; agg.skipped += s.skipped; agg.errors += s.errors;
        agg.bytes += msg.bytes || 0;
        agg.live.delete(msg.taskId);
        agg.chunksDone++;
      }
    };
    const fileSnapshot = (agg) => {
      let rows = agg.rows; let bytes = agg.bytes;
      for (const l of agg.live.values()) { rows += l.rows; bytes += l.bytes; }
      const secs = agg.started ? (Date.now() - agg.started) / 1000 : 0;
      return {
        file: agg.file, source: agg.source, rows, persons: agg.persons, skipped: agg.skipped,
        errors: agg.errors, bytes: Math.min(bytes, agg.sizeBytes || bytes), bytesTotal: agg.sizeBytes,
        rowsPerSec: secs > 0 ? Math.round(rows / secs) : 0,
        chunks: agg.chunks, chunksDone: agg.chunksDone,
      };
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      const exits = [];
      for (const w of pool) {
        exits.push(new Promise((r) => {
          const t = setTimeout(() => { w.terminate().catch(() => {}); r(); }, 3000);
          w.once('exit', () => { clearTimeout(t); r(); });
          w.once('message', (m) => { if (m && m.type === 'bye') w.terminate().catch(() => {}); });
          try { w.postMessage({ type: 'shutdown' }); } catch { w.terminate().catch(() => {}); }
        }));
      }
      Promise.all(exits).then(() => (err ? reject(err) : resolve(totals)));
    };

    const dispatch = (worker) => {
      if (settled || aborted) return;
      const task = queue.shift();
      if (!task) {
        if (running.size === 0) finish();
        return;
      }
      running.set(worker, task);
      const agg = perFile.get(task.name);
      if (agg && !agg.started) agg.started = Date.now();
      emit({ phase: 'task-start', file: task.name, chunkIndex: task.chunkIndex, chunks: task.chunks, bytes: task.end - task.start });
      worker.postMessage({ type: 'task', task });
    };

    const onTaskEnd = (worker, msg, failed) => {
      const task = running.get(worker);
      running.delete(worker);
      const agg = task ? perFile.get(task.name) : null;
      totals.tasksDone++;
      if (failed) {
        totals.errors++;
        emit({ phase: 'task-error', file: msg.file || (task && task.name), chunkIndex: msg.chunkIndex, error: msg.error });
      }
      if (agg) {
        aggregate(agg, msg, true);
        if (msg.stats) {
          totals.rows += msg.stats.rows; totals.persons += msg.stats.persons;
          totals.skipped += msg.stats.skipped; totals.errors += msg.stats.errors;
        }
        if (agg.chunksDone >= agg.chunks) {
          totals.done++;
          const snap = fileSnapshot(agg);
          emit({ ...snap, phase: 'file-done', stats: { rows: snap.rows, persons: snap.persons, skipped: snap.skipped, errors: snap.errors }, totals });
        } else {
          emit({ ...fileSnapshot(agg), phase: 'progress' });
        }
      }
    };

    const spawnWorker = () => {
      const w = new Worker(workerPath, { workerData });
      pool.add(w);
      w.on('message', (msg) => {
        if (settled || !msg) return;
        switch (msg.type) {
          case 'progress': {
            const agg = perFile.get(msg.file);
            if (agg) { aggregate(agg, msg, false); emit({ ...fileSnapshot(agg), phase: 'progress' }); }
            break;
          }
          case 'fold': {
            const reply = (strings) => { try { w.postMessage({ type: 'fold-result', id: msg.id, strings }); } catch { /* worker gone */ } };
            if (!gpuFold) { reply(null); break; }
            Promise.resolve().then(() => gpuFold(msg.strings)).then(reply, () => reply(null));
            break;
          }
          case 'done': onTaskEnd(w, msg, false); dispatch(w); break;
          case 'error': onTaskEnd(w, msg, true); dispatch(w); break;
          default: break;
        }
      });
      w.on('error', (err) => {
        if (settled) return;
        // The thread died mid-task: retry the chunk once on a fresh worker,
        // otherwise count it as failed; the rest of the import keeps going.
        pool.delete(w);
        const task = running.get(w);
        if (task && !task.retried) {
          task.retried = true;
          running.delete(w);
          queue.unshift(task);
          emit({ phase: 'task-retry', file: task.name, chunkIndex: task.chunkIndex, error: err.message });
        } else {
          onTaskEnd(w, { file: task && task.name, chunkIndex: task && task.chunkIndex, error: err.message, stats: null }, true);
        }
        if (queue.length) dispatch(spawnWorker());
        else if (running.size === 0) finish();
      });
      w.on('exit', () => { pool.delete(w); });
      return w;
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        queue.length = 0;
        for (const w of pool) w.terminate().catch(() => {});
        pool.clear();
        finish(new Error('Cancelled'));
      }, { once: true });
    }

    for (let i = 0; i < numWorkers; i++) dispatch(spawnWorker());
  });
}

module.exports = { parallelImport, planTasks, DEFAULT_WORKERS, DEFAULT_INFLIGHT };
