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
 * Map of import source tags -> person counts.
 * Tags are written as `${sourceId}:${basename}` on each person (see normalize.buildPerson).
 * Returns {} when mongod is unreachable.
 */
async function importedSourceStats() {
  try {
    await connect();
    const rows = await persons().aggregate([
      { $match: { sources: { $exists: true, $ne: [] } } },
      { $unwind: '$sources' },
      { $group: { _id: '$sources', persons: { $sum: 1 } } },
    ], { allowDiskUse: true }).toArray();
    const byTag = {};
    const byFile = {}; // basename -> { persons, tags: [] } (fallback if layout id differs)
    for (const r of rows) {
      const tag = r._id;
      if (typeof tag !== 'string' || !tag) continue;
      byTag[tag] = r.persons;
      const colon = tag.indexOf(':');
      const fileName = colon >= 0 ? tag.slice(colon + 1) : tag;
      if (!byFile[fileName]) byFile[fileName] = { persons: 0, tags: [] };
      byFile[fileName].persons += r.persons;
      byFile[fileName].tags.push(tag);
    }
    return { ok: true, byTag, byFile };
  } catch (err) {
    return { ok: false, error: err.message, byTag: {}, byFile: {} };
  }
}

/**
 * Imported CSV "databases" (source layouts) present in MongoDB, with person counts.
 * Source tags look like `${sourceId}:${filename}`; we group by sourceId.
 * Uses distinct()+count rather than a full unwind aggregate so large DBs stay responsive.
 */
async function importedDatabases() {
  const { SOURCES } = require('./schemas');
  try {
    await connect();
    const col = persons();
    const tags = await col.distinct('sources');
    const byId = {};
    for (const tag of tags) {
      if (typeof tag !== 'string' || !tag) continue;
      const colon = tag.indexOf(':');
      const id = colon >= 0 ? tag.slice(0, colon) : tag;
      if (!id) continue;
      if (!byId[id]) byId[id] = { tags: [], persons: 0 };
      byId[id].tags.push(tag);
    }

    // Person counts per source (one countDocuments each — indexed on sources)
    await Promise.all(Object.keys(byId).map(async (id) => {
      const re = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
      byId[id].persons = await col.countDocuments({ sources: re });
    }));

    const labelById = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
    const databases = Object.keys(byId)
      .sort((a, b) => (labelById[a] || a).localeCompare(labelById[b] || b))
      .map((id) => ({
        id,
        label: labelById[id] || id,
        persons: byId[id].persons,
      }));

    return { ok: true, databases };
  } catch (err) {
    return { ok: false, error: err.message, databases: [] };
  }
}

module.exports = {
  connect, close, persons, rawDb, ensureIndexes, status, importedSourceStats,
  importedDatabases,
  DEFAULT_URL, DB_NAME, PERSONS_COLLECTION,
};
