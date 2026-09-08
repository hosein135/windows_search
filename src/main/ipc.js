'use strict';

/**
 * IPC surface between the Node main process and the renderer.
 *
 * GPU work runs in Chromium renderers via WebGPU. The main window registers
 * itself as a GpuPool GPU endpoint (gpu:state) and, separately, as a CPU
 * endpoint (the same window's worker pool). Helper processes register through
 * gpuHelpers.js. Importers ask the pool to fold text; search asks the pool
 * to rank candidates. The pool shards both over every GPU + the CPU workers
 * and returns null / CPU-rank on failure (buildPerson is idempotent).
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { getHardware } = require('./hardware');
const { scanCsvFiles, importFile, importAll } = require('./importer');
const { parallelImport, DEFAULT_WORKERS, DEFAULT_INFLIGHT } = require('./parallelImporter');
const { search, cpuRank } = require('./search');

function registerIpc({ databasesDir, getWindow, pool, getHelperStatus, gpuFlags }) {
  let importAbort = null;

  /* ------------------------- renderer as a GPU endpoint ------------------ */
  let opSeq = 0;
  const pendingOps = new Map(); // id -> { resolve, reject, timer }

  const rendererOp = (op, payload, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const win = getWindow();
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (!wc) { reject(new Error('main window gone')); return; }
    const id = ++opSeq;
    const timer = setTimeout(() => { pendingOps.delete(id); reject(new Error(`renderer ${op} timed out`)); }, timeoutMs);
    pendingOps.set(id, { resolve, reject, timer });
    wc.send('gpu:op', { id, op, payload });
  });

  ipcMain.on('gpu:op:result', (_e, { id, result, error }) => {
    const entry = pendingOps.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingOps.delete(id);
    if (error) entry.reject(new Error(error)); else entry.resolve(result);
  });

  ipcMain.on('gpu:state', (_e, state) => {
    if (!pool) return;
    pool.unregister('renderer');
    pool.unregister('cpu');
    const primary = state && state.devices && state.devices[0];
    const rendererSend = async (op, payload) => {
      const out = await rendererOp(op, { ...payload, units: 'gpu' });
      if (op === 'fold') {
        // 'gpu' or 'gpu+cpu' (one local device fell back) are both real
        // results; a pure CPU answer means this endpoint has no working GPU.
        if (!out || !Array.isArray(out.strings) || !/^gpu/.test(String(out.device))) {
          throw new Error(`renderer fold did not run on the GPU (${out && out.device})`);
        }
        return out.strings;
      }
      return out;
    };
    pool.register({
      id: 'renderer',
      kind: 'renderer',
      label: 'main window',
      adapter: primary ? {
        vendor: primary.vendor, architecture: primary.architecture, device: primary.device,
        description: primary.description, isFallbackAdapter: !!primary.isFallbackAdapter,
      } : null,
      meta: {
        reason: state && state.reason, localDevices: state ? state.devices.length : 0,
        cpuWorkers: state ? state.cpuWorkers : 0, rejected: state ? state.rejected : [],
        forceHighPerformanceGpu: !!(gpuFlags && gpuFlags.forceHighPerformanceGpu),
      },
      send: rendererSend,
    });
    const cpuWorkers = state && state.cpuWorkers ? state.cpuWorkers : 0;
    if (cpuWorkers > 0) {
      pool.register({
        id: 'cpu',
        kind: 'cpu',
        label: `CPU (${cpuWorkers} workers)`,
        meta: { cpuWorkers, hardwareConcurrency: state.hardwareConcurrency || cpuWorkers },
        send: async (op, payload) => {
          const out = await rendererOp(op, { ...payload, units: 'cpu' });
          if (op === 'fold') {
            if (!out || !Array.isArray(out.strings)) throw new Error('cpu fold malformed');
            return out.strings;
          }
          return out;
        },
      });
    }
  });

  const gpuFoldBroker = pool ? (strings) => pool.fold(strings) : null;

  /* ------------------------------ queries -------------------------------- */

  ipcMain.handle('hardware:get', async (_e, opts) => getHardware(opts || {}));
  ipcMain.handle('gpu:flags', async () => gpuFlags || {});
  ipcMain.handle('gpu:plan', async () => ({
    pool: pool ? pool.plan() : null,
    helpers: getHelperStatus ? getHelperStatus() : null,
    flags: gpuFlags || {},
    importDefaults: { workers: DEFAULT_WORKERS, inflight: DEFAULT_INFLIGHT },
  }));

  ipcMain.handle('db:status', async () => db.status());

  function mapScanFiles(files, imported) {
    return files.map((f) => {
      if (!f.known) {
        return { ...f, imported: false, importedPersons: 0, importTag: null };
      }
      const tag = `${f.source}:${f.name}`;
      const persons = Object.prototype.hasOwnProperty.call(imported.byTag, tag)
        ? imported.byTag[tag]
        : 0;
      // persons: number = count, null = present (count unknown), 0 = not imported
      const importedFlag = persons == null || persons > 0;
      return {
        ...f,
        imported: importedFlag,
        importedPersons: persons == null ? null : persons,
        importTag: tag,
      };
    });
  }

  /** Disk-only listing — no Mongo. Used to paint the Import tab immediately. */
  ipcMain.handle('files:list', async () => {
    const files = scanCsvFiles(databasesDir);
    return files.map((f) => ({
      ...f,
      imported: false,
      importedPersons: null,
      importTag: f.known ? `${f.source}:${f.name}` : null,
      statusPending: true,
    }));
  });

  ipcMain.handle('files:scan', async () => {
    const files = scanCsvFiles(databasesDir);
    const tags = files.filter((f) => f.known).map((f) => `${f.source}:${f.name}`);
    const imported = await db.importedSourceStats(tags);
    return mapScanFiles(files, imported);
  });

  ipcMain.handle('databases:imported', async () => {
    const files = scanCsvFiles(databasesDir);
    const tags = files.filter((f) => f.known).map((f) => `${f.source}:${f.name}`);
    return db.importedDatabases(tags);
  });

  ipcMain.handle('search:run', async (_e, payload) => {
    const raw = typeof payload === 'string' ? payload : (payload && payload.q);
    const sourceId = typeof payload === 'object' && payload ? (payload.sourceId || null) : null;
    try {
      await db.connect();
      await db.ensureIndexes();
    } catch (err) {
      return { error: `MongoDB not reachable: ${err.message}`, candidates: [], candidateCount: 0, tookMs: 0 };
    }
    const mongo = await search(db.persons(), raw, { sourceId });
    const tRank = process.hrtime.bigint();
    let ranked;
    try {
      if (pool && typeof pool.rank === 'function') {
        ranked = await pool.rank(mongo.candidates, mongo.query, 50);
      } else {
        ranked = {
          results: cpuRank(mongo.candidates, mongo.query, 50),
          device: 'cpu',
          shards: [{ unit: 'main-thread', docs: mongo.candidates.length }],
        };
      }
    } catch (err) {
      ranked = {
        results: cpuRank(mongo.candidates, mongo.query, 50),
        device: 'cpu',
        shards: [{ unit: 'main-thread', docs: mongo.candidates.length }],
      };
      ranked.error = err && err.message;
    }
    const rankMs = Number(process.hrtime.bigint() - tRank) / 1e6;
    return {
      query: mongo.query,
      candidateCount: mongo.candidates.length,
      tookMs: mongo.tookMs,
      rankMs,
      capped: mongo.capped,
      sourceId: mongo.sourceId,
      ranked,
    };
  });

  /* ------------------------------ imports -------------------------------- */

  const progressSender = () => {
    const win = getWindow();
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    return (payload) => {
      // Cache per-file person counts so the next Import/Search load is instant.
      if (payload && (payload.phase === 'file-done' || payload.phase === 'done')) {
        const source = payload.source;
        const file = payload.file;
        const persons = payload.persons;
        if (source && file && persons != null) {
          db.recordSourceStat(`${source}:${file}`, persons).catch(() => {});
        }
      }
      if (wc && !wc.isDestroyed()) wc.send('import:progress', payload);
    };
  };

  async function runParallel({ files, gpuNormalize, workers, inflight, send }) {
    const totals = await parallelImport(databasesDir, {
      files: files && files.length ? files : null,
      workers: workers || DEFAULT_WORKERS,
      inflight: inflight || DEFAULT_INFLIGHT,
      mongoUrl: db.DEFAULT_URL,
      dbName: db.DB_NAME,
      collection: db.PERSONS_COLLECTION,
      gpuFold: gpuNormalize && gpuFoldBroker && pool && pool.hasGpu() ? gpuFoldBroker : null,
      signal: importAbort.signal,
      onProgress: send,
    });
    return totals;
  }

  ipcMain.handle('import:start', async (_e, { files, gpuNormalize, parallel, workers, inflight } = {}) => {
    if (importAbort) return { error: 'An import is already running.' };
    try {
      await db.connect();
      await db.ensureIndexes();
    } catch (err) {
      return { error: `MongoDB not reachable: ${err.message}` };
    }
    const send = progressSender();
    importAbort = new AbortController();
    try {
      if (parallel) {
        // === PARALLEL MODE: every core parses a chunk + writes; fold sharded over GPUs + CPU ===
        const totals = await runParallel({ files, gpuNormalize, workers, inflight, send });
        return { ok: true, totals, cancelled: importAbort.signal.aborted, mode: 'parallel' };
      }
      // === SEQUENTIAL MODE: one thread, pipelined writes, optional GPU+CPU fold ===
      const totals = await importAll(databasesDir, {
        col: db.persons(),
        only: files && files.length ? files : null,
        inflight: inflight || DEFAULT_INFLIGHT,
        signal: importAbort.signal,
        gpuFold: gpuNormalize && gpuFoldBroker && pool && pool.hasGpu() ? gpuFoldBroker : null,
        onProgress: send,
      });
      return { ok: true, totals, cancelled: importAbort.signal.aborted, mode: 'sequential' };
    } catch (err) {
      return { error: err.message };
    } finally {
      importAbort = null;
      db.invalidateSourceStatsCache();
      send({ phase: 'all-done' });
    }
  });

  ipcMain.handle('import:file', async (_e, { file, gpuNormalize, parallel, workers, inflight } = {}) => {
    // Import a single file (file-by-file mode). With `parallel` the file is
    // split into byte-range chunks so every core works on it.
    if (importAbort) return { error: 'An import is already running.' };
    try {
      await db.connect();
      await db.ensureIndexes();
    } catch (err) {
      return { error: `MongoDB not reachable: ${err.message}` };
    }
    const send = progressSender();
    importAbort = new AbortController();
    try {
      if (parallel) {
        const totals = await runParallel({ files: [file.path || file], gpuNormalize, workers, inflight, send });
        const stats = { rows: totals.rows, persons: totals.persons, skipped: totals.skipped, errors: totals.errors };
        return { ok: true, stats, totals, cancelled: importAbort.signal.aborted, mode: 'parallel' };
      }
      const stats = await importFile(file, {
        col: db.persons(),
        inflight: inflight || DEFAULT_INFLIGHT,
        signal: importAbort.signal,
        gpuFold: gpuNormalize && gpuFoldBroker && pool && pool.hasGpu() ? gpuFoldBroker : null,
        onProgress: send,
      });
      return { ok: true, stats, cancelled: importAbort.signal.aborted, mode: 'sequential' };
    } catch (err) {
      return { error: err.message };
    } finally {
      importAbort = null;
      db.invalidateSourceStatsCache();
      send({ phase: 'all-done' });
    }
  });

  ipcMain.handle('import:cancel', async () => {
    if (importAbort) importAbort.abort();
    return { ok: true };
  });

  /* ------------------------------ storage -------------------------------- */

  /** Recursively sum bytes under dir; list top-level names (files + dirs). */
  function readMongoDataDir(mongoDir) {
    const dirInfo = {
      path: mongoDir,
      exists: false,
      sizeMB: 0,
      fileCount: 0,
      entries: [], // top-level: { name, kind: 'file'|'dir', sizeMB }
      files: [], // flat names for older UI; kept as entry names
    };
    try {
      if (!fs.existsSync(mongoDir)) return dirInfo;
      dirInfo.exists = true;

      let totalBytes = 0;
      let fileCount = 0;
      const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) {
            fileCount += 1;
            try { totalBytes += fs.statSync(p).size; } catch { /* ignore */ }
          }
        }
      };
      walk(mongoDir);
      dirInfo.sizeMB = Math.round(totalBytes / 1048576 * 10) / 10;
      dirInfo.fileCount = fileCount;

      const top = fs.readdirSync(mongoDir, { withFileTypes: true });
      for (const e of top) {
        const p = path.join(mongoDir, e.name);
        let size = 0;
        try {
          if (e.isDirectory()) {
            // size of this subtree
            const stack = [p];
            while (stack.length) {
              const cur = stack.pop();
              let kids;
              try { kids = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
              for (const k of kids) {
                const kp = path.join(cur, k.name);
                if (k.isDirectory()) stack.push(kp);
                else if (k.isFile()) {
                  try { size += fs.statSync(kp).size; } catch { /* ignore */ }
                }
              }
            }
          } else if (e.isFile()) {
            size = fs.statSync(p).size;
          }
        } catch { /* ignore */ }
        dirInfo.entries.push({
          name: e.name,
          kind: e.isDirectory() ? 'dir' : 'file',
          sizeMB: Math.round(size / 1048576 * 10) / 10,
        });
      }
      dirInfo.entries.sort((a, b) => a.name.localeCompare(b.name));
      dirInfo.files = dirInfo.entries.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name));
    } catch { /* ignore */ }
    return dirInfo;
  }

  ipcMain.handle('storage:info', async () => {
    const mongoDir = path.resolve(path.join(databasesDir, '..', 'mongo'));
    const dirInfo = readMongoDataDir(mongoDir);
    const base = {
      mongoUrl: db.DEFAULT_URL,
      dbName: db.DB_NAME,
      collection: db.PERSONS_COLLECTION,
      dataDir: mongoDir,
      dirInfo,
    };

    // Prefer the same probe the status chip uses (connect + ping). A failed
    // collStats/listDatabases must not mark the whole tab "offline" when mongod
    // is actually reachable - mongodb driver v6 removed collection.stats().
    const st = await db.status();
    if (!st.ok) {
      return { ok: false, error: st.error || 'Cannot reach mongod', ...base };
    }

    try {
      await db.connect();
      const d = db.rawDb();
      const col = db.persons();
      const count = await col.estimatedDocumentCount().catch(() => st.persons || 0);
      // collStats replaces removed Collection#stats() in mongodb@6
      const stats = await d.command({ collStats: db.PERSONS_COLLECTION }).catch(() => ({}));
      const indexes = await col.indexes().catch(() => []);
      const allDbs = await d.admin().listDatabases().catch(() => ({ databases: [] }));

      return {
        ok: true,
        ...base,
        documentCount: count,
        storageSizeMB: stats.storageSize ? Math.round(stats.storageSize / 1048576 * 10) / 10 : 0,
        dataSizeMB: stats.size ? Math.round(stats.size / 1048576 * 10) / 10 : 0,
        indexSizeMB: stats.totalIndexSize ? Math.round(stats.totalIndexSize / 1048576 * 10) / 10 : 0,
        indexes: indexes.map((ix) => ({
          name: ix.name, keys: JSON.stringify(ix.key), unique: !!ix.unique, sparse: !!ix.sparse,
        })),
        allDatabases: allDbs.databases || [],
      };
    } catch (err) {
      // Connected (status chip would be green) but a secondary query failed —
      // still report online with whatever we have, plus the error as a warning.
      return {
        ok: true,
        ...base,
        documentCount: st.persons || 0,
        storageSizeMB: 0,
        dataSizeMB: 0,
        indexSizeMB: 0,
        indexes: [],
        allDatabases: [],
        warning: err.message,
      };
    }
  });
}

module.exports = { registerIpc };
