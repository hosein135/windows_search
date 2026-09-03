'use strict';

/**
 * Streaming CSV importer.
 *
 * Scans the databases/ folder, resolves each file's layout from the report
 * schemas, cleans every cell (placeholders -> never stored), and upserts
 * ONE Mongo document per person (keyed by national code, falling back to
 * the source account number). Empty rows are skipped entirely.
 *
 * GPU hook: when the GUI enables "GPU normalize", each batch's text cells
 * (names/addresses) are Persian-folded by a WebGPU compute shader in the
 * renderer before the CPU builds the documents. normalizePersianChars is
 * idempotent, so a GPU-pre-folded cell passes the CPU path unchanged.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { resolveSource } = require('./schemas');
const { buildPerson, normalizePersianChars } = require('./normalize');

const DEFAULT_BATCH = 5000;
const GPU_CHUNK = 8192;

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

/** Merge person parts b into a (used to dedupe equal keys inside one batch). */
function mergePerson(a, b) {
  Object.assign(a.set, b.set);
  for (const [k, vals] of Object.entries(b.addToSet)) {
    a.addToSet[k] = [...new Set([...(a.addToSet[k] || []), ...vals])];
  }
  if (!a.searchName && b.searchName) a.searchName = b.searchName;
}

/** Text cells that benefit from GPU Persian folding. */
const GPU_TEXT_TARGETS = new Set([
  'fullName', 'firstName', 'lastName', 'fatherName',
  'city', 'province', 'birthCity', 'birthProvince', 'address',
]);

async function gpuFoldBatch(rows, source, gpuNormalize) {
  if (!gpuNormalize) return;
  const cells = [];
  const refs = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length && c < source.columns.length; c++) {
      const target = source.columns[c];
      if (!target || !GPU_TEXT_TARGETS.has(target)) continue;
      const v = row[c];
      if (typeof v === 'string' && v !== '') {
        refs.push([r, c]);
        cells.push(v);
      }
    }
  }
  for (let i = 0; i < cells.length; i += GPU_CHUNK) {
    const chunk = cells.slice(i, i + GPU_CHUNK);
    const folded = await gpuNormalize(chunk); // -> array of folded strings
    for (let j = 0; j < folded.length; j++) {
      const [r, c] = refs[i + j];
      if (typeof folded[j] === 'string') rows[r][c] = folded[j];
    }
  }
}

function toUpdateOp(person) {
  const now = new Date();
  const $set = { ...person.set, updatedAt: now };
  if (person.searchName) $set.searchName = person.searchName;
  const $addToSet = {};
  for (const [k, vals] of Object.entries(person.addToSet)) {
    if (vals && vals.length) $addToSet[k] = { $each: vals };
  }
  const update = { $set, $setOnInsert: { key: person.key, createdAt: now } };
  if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
  return {
    updateOne: { filter: { key: person.key }, update, upsert: true },
  };
}

/**
 * Import one CSV file.
 * opts: { col, batchSize, onProgress, signal, gpuNormalize }
 * Progress events: { phase, file, rows, persons, skipped, bytes, bytesTotal, rowsPerSec }
 */
async function importFile(file, opts) {
  const { col, batchSize = DEFAULT_BATCH, onProgress, signal, gpuNormalize } = opts;
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

  const flush = async () => {
    if (!batchRows.length) return;
    const rows = batchRows;
    batchRows = [];

    if (gpuNormalize) {
      try { await gpuFoldBatch(rows, source, gpuNormalize); }
      catch { /* GPU normalize is best-effort; CPU folding inside buildPerson */ }
    }

    const byKey = new Map();
    for (const row of rows) {
      let person = null;
      try { person = buildPerson(source, row, sourceTag); }
      catch { stats.errors++; continue; }
      if (!person) { stats.skipped++; continue; }
      const prev = byKey.get(person.key);
      if (prev) mergePerson(prev, person);
      else byKey.set(person.key, person);
    }
    if (!byKey.size) return;

    const ops = [...byKey.values()].map(toUpdateOp);
    try {
      const res = await col.bulkWrite(ops, { ordered: false });
      // matchedCount covers both modified and matched-but-identical docs.
      stats.persons += res.upsertedCount + res.matchedCount;
    } catch (err) {
      // Duplicate-key races inside a batch are retried one-by-one.
      if (err && err.writeErrors) {
        for (const we of err.writeErrors) {
          const op = ops[we.index];
          try {
            await col.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: true });
            stats.persons++;
          } catch { stats.errors++; }
        }
      } else {
        throw err;
      }
    }
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
      if (signal && signal.aborted) break;
      stats.rows++;
      // Header rows: named ('NATIONAL_CODE' / 'MOBL_NUM_VOICE_V' / ...) or
      // generic ('Field1'). Some irancell files carry two header rows; both
      // match isHeaderRow and are skipped. (Report: 1-2 header rows per file.)
      if (stats.rows <= 3 && source.isHeaderRow(row)) { stats.rows--; continue; }
      batchRows.push(row);
      if (batchRows.length >= batchSize) {
        await flush();
        emit('progress');
      }
    }
  } finally {
    await flush();
    emit(signal && signal.aborted ? 'cancelled' : 'done');
  }
  return stats;
}

/**
 * Import every known CSV under dir sequentially.
 * opts: { col, onProgress, signal, gpuNormalize, only }
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

module.exports = { scanCsvFiles, importFile, importAll, DEFAULT_BATCH };
