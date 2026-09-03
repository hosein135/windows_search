'use strict';

/** MongoDB connection + collection/index management. */

const { MongoClient } = require('mongodb');
const fs = require('fs');

const DEFAULT_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGO_DB || 'windows_search';
const PERSONS_COLLECTION = 'persons';
// The main-process pool serves searches + the sequential importer's in-flight
// writes; parallel-import workers open their own per-thread connections.
const POOL_SIZE = Math.max(4, Number(process.env.MONGO_POOL_SIZE) || 16);

let client = null;
let db = null;

async function connect(url = DEFAULT_URL) {
  if (db) return db;
  client = new MongoClient(url, {
    maxPoolSize: POOL_SIZE,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
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

/** Ping helper for the GUI status bar. */
async function status() {
  try {
    const d = await connect();
    await d.command({ ping: 1 });
    const count = await persons().estimatedDocumentCount();
    return { ok: true, url: DEFAULT_URL, db: DB_NAME, persons: count };
  } catch (err) {
    return { ok: false, url: DEFAULT_URL, db: DB_NAME, error: err.message, persons: 0 };
  }
}

module.exports = { connect, close, persons, rawDb, ensureIndexes, status, DEFAULT_URL, DB_NAME, PERSONS_COLLECTION };
