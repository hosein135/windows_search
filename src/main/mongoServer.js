'use strict';

/**
 * Ensure a local standalone mongod is listening on 127.0.0.1:27017.
 *
 * setup.ps1 starts mongod as a hidden process (not a Windows service). After a
 * reboot or if that process exited, the GUI/CLI get ECONNREFUSED. This module
 * probes the port and, if needed, starts mongod against the project's mongo/
 * data directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 27017;
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'mongo');

let starting = null;

function dataDir() {
  return process.env.WS_MONGO_DBPATH
    ? path.resolve(process.env.WS_MONGO_DBPATH)
    : DEFAULT_DATA_DIR;
}

function portOpen(timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT, family: 4 });
    const done = (ok) => {
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

function walkFind(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) {
      const hit = walkFind(p, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function findMongod() {
  const exeName = process.platform === 'win32' ? 'mongod.exe' : 'mongod';
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mongod'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* not on PATH */ }

  const home = os.homedir();
  const roots = [
    path.join(home, '.version-fox', 'sdks'),
    path.join(home, '.vfox', 'sdks'),
    path.resolve(__dirname, '..', '..', '.tmp-mongo'),
    'C:\\Program Files\\MongoDB\\Server',
    'C:\\Program Files\\MongoDB',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = walkFind(root, exeName.toLowerCase(), 7);
    if (hit) return hit;
  }
  return null;
}

async function waitUntilUp(ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function spawnMongod(exe, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'mongod.log');
  const args = [
    '--dbpath', dir,
    '--port', String(PORT),
    '--bind_ip', HOST,
    '--logpath', logFile,
    '--logappend',
  ];
  console.log(`[mongo] starting ${exe} ${args.join(' ')}`);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => console.warn('[mongo] spawn error:', err.message));
  child.unref();
}

async function ensureMongod() {
  if (await portOpen()) return { ok: true, alreadyRunning: true, dataDir: dataDir() };
  if (starting) return starting;

  starting = (async () => {
    const dir = dataDir();
    const exe = findMongod();
    if (!exe) {
      throw new Error(
        `mongod not found (nothing listening on ${HOST}:${PORT}). `
        + `Install MongoDB via setup.cmd, or put mongod on PATH, then retry.`,
      );
    }
    spawnMongod(exe, dir);
    const up = await waitUntilUp(20_000);
    if (!up) {
      throw new Error(
        `started ${exe} with dbpath ${dir} but ${HOST}:${PORT} still refused. `
        + `Check ${path.join(dir, 'mongod.log')} (another process may hold mongod.lock).`,
      );
    }
    return { ok: true, alreadyRunning: false, exe, dataDir: dir };
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

module.exports = { ensureMongod, findMongod, dataDir, HOST, PORT };
