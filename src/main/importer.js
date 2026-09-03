'use strict';

/**
 * Streaming CSV importer (sequential mode: one file at a time, one thread).
 *
 * Scans the databases/ folder, resolves each file's layout from the report
 * schemas, cleans every cell (placeholders -> never stored), and upserts
 * ONE Mongo document per person (keyed by national code, falling back to
 * the source account number). Empty rows are skipped entirely.
 *
 * Parsing overlaps with writing: up to `inflight` bulkWrites are in the air
 * while the next batch is parsed (the parallel importer does the same per
 * worker thread, on every core - see parallelImporter.js).
 *
 * GPU hook: when the GUI enables "GPU normalize", each batch's text cells
 * (names/addresses) are Persian-folded by WebGPU compute shaders (sharded over
 * every GPU endpoint the main process knows) before the CPU builds the
 * documents. normalizePersianChars is idempotent, so a GPU-pre-folded cell
 * passes the CPU path unchanged.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { resolveSource } = require('./schemas');
const { collectFoldCells, applyFoldedCells, rowsToPersons, writePersons } = require('./importerHelpers');

const DEFAULT_BATCH = 5000;
const DEFAULT_INFLIGHT = 2;
const GPU_CHUNK = 16384;

/** Recursively list *.csv files under dir, newest schema match first. */
function scanCsvFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.csv$/i.test(e.name)) {
        const source = resolveSource(p);
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(p).size; } catch { /* ignore */ }
        out.push({
          path: p,
          name: path.basename(p),
          folder: path.basename(path.dirname(p)),
          sizeBytes,
          source: source ? source.id : null,
          sourceLabel: source ? source.label : 'unknown (skipped)',
          known: !!source,
        });
      }
    }
  })(dir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Fold the text cells of a batch on the GPU endpoints (best effort). */
async function gpuFoldBatch(rows, source, gpuFold) {
  const { strings, refs } = collectFoldCells(rows, source);
  if (!strings.length) return;
  for (let i = 0; i < strings.length; i += GPU_CHUNK) {
    const chunk = strings.slice(i, i + GPU_CHUNK);
    const folded = await gpuFold(chunk); // -> array of folded strings, or null
    if (!folded) continue;
    applyFoldedCells(rows, refs.slice(i * 2, (i + chunk.length) * 2), folded);
  }
}

/**
 * Import one CSV file.
 * opts: { col, batchSize, inflight, onProgress, signal, gpuFold (alias gpuNormalize) }
 * Progress events: { phase, file, rows, persons, skipped, bytes, bytesTotal, rowsPerSec }
 */
async function importFile(file, opts) {
  const { col, batchSize = DEFAULT_BATCH, inflight = DEFAULT_INFLIGHT, onProgress, signal } = opts;
  const gpuFold = opts.gpuFold || opts.gpuNormalize || null;
  const source = resolveSource(file.path || file);
  if (!source) throw new Error(`Unknown CSV layout: ${file.path || file}`);
  const filePath = file.path || file;
  const fileName = path.basename(filePath);
  const sourceTag = `${source.id}:${fileName}`;
  const bytesTotal = file.sizeBytes || fs.statSync(filePath).size;

  const stats = { rows: 0, persons: 0, skipped: 0, errors: 0 };
  const started = Date.now();
  let batchRows = [];
  let bytesRead = 0;

  const emit = (phase) => {
    if (!onProgress) return;
    const secs = (Date.now() - started) / 1000;
    onProgress({
      phase, file: fileName, source: source.id,
      rows: stats.rows, persons: stats.persons, skipped: stats.skipped,
      errors: stats.errors, bytes: bytesRead, bytesTotal,
      rowsPerSec: secs > 0 ? Math.round(stats.rows / secs) : 0,
    });
  };

  const flushRows = async (rows) => {
    if (gpuFold) {
      try { await gpuFoldBatch(rows, source, gpuFold); }
      catch { /* GPU fold is best-effort; buildPerson folds on the CPU anyway */ }
    }
    const persons = rowsToPersons(rows, source, sourceTag, stats);
    if (!persons.length) return;
    stats.persons += await writePersons(col, persons, stats);
  };

  // Pipelined writes: parsing continues while up to `inflight` batches are
  // being written. Errors are captured and re-thrown after the loop so a
  // rejected write never becomes an unhandled rejection.
  const pending = new Set();
  let firstError = null;
  const startFlush = () => {
    if (!batchRows.length) return;
    const rows = batchRows;
    batchRows = [];
    const p = flushRows(rows)
      .catch((err) => { if (!firstError) firstError = err; })
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  const parser = fs.createReadStream(filePath)
    .on('data', (chunk) => { bytesRead += chunk.length; })
    .pipe(parse({
      relax_column_count: true,   // tolerate rare messy rows
      relax_quotes: true,
      bom: true,
      skip_records_with_error: true,
    }));

  emit('start');
  try {
    for await (const row of parser) {
      if ((signal && signal.aborted) || firstError) break;
      stats.rows++;
      // Header rows: named ('NATIONAL_CODE' / 'MOBL_NUM_VOICE_V' / ...) or
      // generic ('Field1'). Some irancell files carry two header rows; both
      // match isHeaderRow and are skipped. (Report: 1-2 header rows per file.)
      if (stats.rows <= 3 && source.isHeaderRow(row)) { stats.rows--; continue; }
      batchRows.push(row);
      if (batchRows.length >= batchSize) {
        startFlush();
        emit('progress');
        if (pending.size >= inflight) await Promise.race(pending);
      }
    }
  } finally {
    startFlush();
    await Promise.all(pending);
    emit(signal && signal.aborted ? 'cancelled' : 'done');
  }
  if (firstError) throw firstError;
  return stats;
}

/**
 * Import every known CSV under dir sequentially.
 * opts: { col, onProgress, signal, gpuFold, only }
 */
async function importAll(dir, opts) {
  const files = scanCsvFiles(dir).filter((f) => f.known);
  const selected = opts.only ? files.filter((f) => opts.only.includes(f.path)) : files;
  const totals = { files: selected.length, done: 0, rows: 0, persons: 0, skipped: 0, errors: 0 };
  for (const f of selected) {
    if (opts.signal && opts.signal.aborted) break;
    const stats = await importFile(f, opts);
    totals.rows += stats.rows;
    totals.persons += stats.persons;
    totals.skipped += stats.skipped;
    totals.errors += stats.errors;
    totals.done++;
    if (opts.onProgress) opts.onProgress({ phase: 'file-done', file: f.name, ...stats, totals });
  }
  return totals;
}

module.exports = { scanCsvFiles, importFile, importAll, DEFAULT_BATCH, DEFAULT_INFLIGHT };
