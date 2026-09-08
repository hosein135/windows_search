'use strict';

/** MongoDB connection + collection/index management. */

const { MongoClient } = require('mongodb');
const { ensureMongod } = require('./mongoServer');

const DEFAULT_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGO_DB || 'windows_search';
const PERSONS_COLLECTION = 'persons';
// The main-process pool serves searches + the sequential importer's in-flight
// writes; parallel-import workers open their own per-thread connections.
const POOL_SIZE = Math.max(4, Number(process.env.MONGO_POOL_SIZE) || 16);

let client = null;
let db = null;
/** In-flight connect promise so concurrent callers (startup + status chip) share one attempt. */
let connecting = null;

function clientOptions() {
  return {
    maxPoolSize: POOL_SIZE,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    // Standalone mongod from setup.ps1 is not a replica set; without this the
    // driver can fail server selection even when the port is accepting.
    directConnection: true,
    // Prefer IPv4 — avoids ::1 vs 127.0.0.1 mismatches on Windows.
    family: 4,
  };
}

async function resetClient() {
  const c = client;
  client = null;
  db = null;
  if (c) {
    try { await c.close(); } catch { /* ignore */ }
  }
}

async function connect(url = DEFAULT_URL) {
  if (db && client) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    await resetClient();
    try {
      const started = await ensureMongod();
      if (started && !started.alreadyRunning) {
        console.log('[mongo] mongod is listening on 127.0.0.1:27017, dbpath:', started.dataDir);
      }
    } catch (err) {
      console.warn('[mongo] ensure mongod:', err.message);
    }
    const c = new MongoClient(url, clientOptions());
    try {
      await c.connect();
      client = c;
      db = c.db(DB_NAME);
      return db;
    } catch (err) {
      try { await c.close(); } catch { /* ignore */ }
      if (client === c) {
        client = null;
        db = null;
      }
      throw err;
    }
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function close() {
  connecting = null;
  await resetClient();
}

function persons() {
  if (!db) throw new Error('Not connected to MongoDB');
  return db.collection(PERSONS_COLLECTION);
}

function rawDb() {
  if (!db) throw new Error('Not connected to MongoDB');
  return db;
}

/**
 * Indexes that narrow candidates BEFORE the GPU ranker runs:
 *  - key           unique person key (one document per person)
 *  - nationalCode  exact national-id lookup
 *  - mobiles/cards multikey exact lookups
 *  - searchName    normalized name for token search
 */
async function ensureIndexes() {
  const col = persons();
  await col.createIndex({ key: 1 }, { unique: true, name: 'uniq_person_key' });
  await col.createIndex({ nationalCode: 1 }, { name: 'national_code', sparse: true });
  await col.createIndex({ mobiles: 1 }, { name: 'mobiles', sparse: true });
  await col.createIndex({ cards: 1 }, { name: 'cards', sparse: true });
  await col.createIndex({ accounts: 1 }, { name: 'accounts', sparse: true });
  await col.createIndex({ searchName: 1 }, { name: 'search_name', sparse: true });
  // Used by the Import tab to mark CSVs already present in the DB (sources tags).
  await col.createIndex({ sources: 1 }, { name: 'sources', sparse: true });
}

async function probe() {
  const d = await connect();
  await d.command({ ping: 1 });
  const count = await persons().estimatedDocumentCount();
  return { ok: true, url: DEFAULT_URL, db: DB_NAME, persons: count };
}

/** Ping helper for the GUI status bar. Retries once after resetting a stale client. */
async function status() {
  try {
    return await probe();
  } catch (first) {
    await resetClient().catch(() => {});
    try {
      return await probe();
    } catch (err) {
      return { ok: false, url: DEFAULT_URL, db: DB_NAME, error: err.message, persons: 0 };
    }
  }
}

/**
 * Fast import-status lookup for known source tags (`sourceId:filename`).
 *
 * Avoids a full-collection $unwind/$group (that was dominating Import/Search
 * load time on large DBs). Instead:
 *   1. Read cached counts from the tiny `source_stats` collection (written at
 *      import time).
 *   2. For tags with no cache row, one indexed findOne({ sources: tag }) to
 *      detect presence (no full count).
 *
 * byTag values: number (>=0) = person count, null = present but count unknown.
 */
const SOURCE_STATS_COLLECTION = 'source_stats';
let sourceStatsMem = { key: '', at: 0, value: null };
const SOURCE_STATS_TTL_MS = 30_000;

function sourceStatsCol() {
  return rawDb().collection(SOURCE_STATS_COLLECTION);
}

function invalidateSourceStatsCache() {
  sourceStatsMem = { key: '', at: 0, value: null };
}

async function recordSourceStat(tag, persons) {
  if (!tag) return;
  try {
    await connect();
    await sourceStatsCol().updateOne(
      { _id: tag },
      { $set: { persons: Number(persons) || 0, updatedAt: new Date() } },
      { upsert: true },
    );
    invalidateSourceStatsCache();
  } catch { /* best-effort cache */ }
}

async function importedSourceStats(knownTags = []) {
  const tags = [...new Set((knownTags || []).filter((t) => typeof t === 'string' && t))];
  const key = tags.slice().sort().join('\0');
  if (
    sourceStatsMem.value
    && sourceStatsMem.key === key
    && Date.now() - sourceStatsMem.at < SOURCE_STATS_TTL_MS
  ) {
    return sourceStatsMem.value;
  }

  try {
    await connect();
    const col = persons();
    const byTag = {};
    const byFile = {};

    if (!tags.length) {
      const empty = { ok: true, byTag, byFile };
      sourceStatsMem = { key, at: Date.now(), value: empty };
      return empty;
    }

    // Batch-read cached counts (tiny collection — instant)
    const cachedRows = await sourceStatsCol()
      .find({ _id: { $in: tags } }, { projection: { persons: 1 } })
      .toArray();
    const cached = Object.fromEntries(cachedRows.map((r) => [r._id, r.persons]));

    await Promise.all(tags.map(async (tag) => {
      if (cached[tag] != null) {
        byTag[tag] = cached[tag];
      } else {
        // Indexed equality probe — does not count millions of docs
        const hit = await col.findOne({ sources: tag }, { projection: { _id: 1 } });
        byTag[tag] = hit ? null : 0;
      }
      const colon = tag.indexOf(':');
      const fileName = colon >= 0 ? tag.slice(colon + 1) : tag;
      if (!byFile[fileName]) byFile[fileName] = { persons: 0, tags: [], present: false };
      const n = byTag[tag];
      if (n == null) byFile[fileName].present = true;
      else if (n > 0) {
        byFile[fileName].persons += n;
        byFile[fileName].present = true;
      }
      byFile[fileName].tags.push(tag);
    }));

    const out = { ok: true, byTag, byFile };
    sourceStatsMem = { key, at: Date.now(), value: out };
    return out;
  } catch (err) {
    return { ok: false, error: err.message, byTag: {}, byFile: {} };
  }
}

/**
 * Imported CSV databases grouped by source id, derived from known tags + fast stats.
 * @param {string[]} knownTags tags like `mellat:file.csv`
 */
async function importedDatabases(knownTags = []) {
  const { SOURCES } = require('./schemas');
  const stats = await importedSourceStats(knownTags);
  if (!stats.ok) return { ok: false, error: stats.error, databases: [] };

  const byId = {};
  for (const [tag, count] of Object.entries(stats.byTag)) {
    const colon = tag.indexOf(':');
    const id = colon >= 0 ? tag.slice(0, colon) : tag;
    if (!id) continue;
    if (!byId[id]) byId[id] = { persons: 0, imported: false };
    if (count == null) byId[id].imported = true;
    else if (count > 0) {
      byId[id].imported = true;
      byId[id].persons += count;
    }
  }

  const labelById = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
  const databases = Object.keys(byId)
    .filter((id) => byId[id].imported)
    .sort((a, b) => (labelById[a] || a).localeCompare(labelById[b] || b))
    .map((id) => ({
      id,
      label: labelById[id] || id,
      persons: byId[id].persons,
    }));

  return { ok: true, databases };
}

module.exports = {
  connect, close, persons, rawDb, ensureIndexes, status, importedSourceStats,
  importedDatabases, recordSourceStat, invalidateSourceStatsCache,
  DEFAULT_URL, DB_NAME, PERSONS_COLLECTION,
};
