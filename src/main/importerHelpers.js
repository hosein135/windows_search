'use strict';

/**
 * Shared helpers used by both the single-threaded importer and the
 * parallel (worker-thread) importer. Extracted here so importWorker.js,
 * importer.js and parallelImporter.js can all use them without circular deps.
 */

const { buildPerson } = require('./normalize');

/** Build a MongoDB bulkWrite updateOne op from a person object. */
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

/**
 * Collect the text cells of a batch that the GPU fold kernel should process.
 * Returns { strings, refs } where refs[i] = [rowIndex, colIndex] of strings[i].
 */
function collectFoldCells(rows, source) {
  const strings = [];
  const refs = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length && c < source.columns.length; c++) {
      const target = source.columns[c];
      if (!target || !GPU_TEXT_TARGETS.has(target)) continue;
      const v = row[c];
      if (typeof v === 'string' && v !== '') {
        refs.push(r, c);
        strings.push(v);
      }
    }
  }
  return { strings, refs };
}

/** Write folded strings back into the rows (refs from collectFoldCells). */
function applyFoldedCells(rows, refs, folded) {
  const n = Math.min(folded.length, refs.length / 2);
  for (let i = 0; i < n; i++) {
    const v = folded[i];
    if (typeof v === 'string') rows[refs[i * 2]][refs[i * 2 + 1]] = v;
  }
}

/**
 * Turn a batch of raw CSV rows into deduplicated person objects.
 * Mutates stats (skipped / errors). Returns [] when nothing is storable.
 */
function rowsToPersons(rows, source, sourceTag, stats) {
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
  return byKey.size ? [...byKey.values()] : [];
}

/**
 * bulkWrite a list of persons with duplicate-key retry.
 * Concurrent upserts of the same key (two workers, two chunks of one file)
 * race on the unique `key` index; the losers are retried one by one.
 * Returns the number of persons written (upserted + matched).
 */
async function writePersons(col, persons, stats) {
  const ops = persons.map(toUpdateOp);
  try {
    const res = await col.bulkWrite(ops, { ordered: false });
    return res.upsertedCount + res.matchedCount;
  } catch (err) {
    if (!(err && err.writeErrors)) throw err;
    let written = 0;
    for (const we of err.writeErrors) {
      const op = ops[we.index];
      try {
        await col.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: true });
        written++;
      } catch { stats.errors++; }
    }
    return written;
  }
}

module.exports = {
  toUpdateOp,
  mergePerson,
  GPU_TEXT_TARGETS,
  collectFoldCells,
  applyFoldedCells,
  rowsToPersons,
  writePersons,
};
