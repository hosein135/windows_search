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

module.exports = { connect, close, persons, rawDb, ensureIndexes, status, DEFAULT_URL, DB_NAME, PERSONS_COLLECTION };
