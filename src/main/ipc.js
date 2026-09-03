'use strict';

/**
 * IPC surface between the Node main process and the renderer.
 *
 * GPU work (ranking + optional import normalization) runs in the renderer
 * via WebGPU; the main process delegates through 'gpu:normalize' round-trips
 * during import, with a CPU fallback when the GPU path fails or times out.
 */

const { ipcMain } = require('electron');
const db = require('./db');
const { getHardware } = require('./hardware');
const { scanCsvFiles, importAll } = require('./importer');
const { search } = require('./search');

function registerIpc({ databasesDir, getWindow }) {
  let importAbort = null;
  let gpuSeq = 0;
  const pendingGpu = new Map(); // id -> { resolve, timer }

  ipcMain.handle('hardware:get', async (_e, opts) => getHardware(opts || {}));

  ipcMain.handle('db:status', async () => db.status());

  ipcMain.handle('files:scan', async () => scanCsvFiles(databasesDir));

  ipcMain.handle('search:run', async (_e, raw) => {
    try {
      await db.connect();
      await db.ensureIndexes();
    } catch (err) {
      return { error: `MongoDB not reachable: ${err.message}`, candidates: [], tookMs: 0 };
    }
    const out = await search(db.persons(), raw);
    return out;
  });

  ipcMain.handle('import:start', async (_e, { files, gpuNormalize } = {}) => {
    if (importAbort) return { error: 'An import is already running.' };
    try {
      await db.connect();
      await db.ensureIndexes();
    } catch (err) {
      return { error: `MongoDB not reachable: ${err.message}` };
    }

    const wc = getWindow() && getWindow().webContents;
    const send = (payload) => { if (wc && !wc.isDestroyed()) wc.send('import:progress', payload); };

    // Renderer-side GPU normalize round-trip (idempotent Persian fold).
    const normalizeHook = gpuNormalize && wc
      ? (strings) => new Promise((resolve, reject) => {
          const id = ++gpuSeq;
          const timer = setTimeout(() => {
            pendingGpu.delete(id);
            reject(new Error('GPU normalize timed out'));
          }, 30_000);
          pendingGpu.set(id, { resolve, timer });
          wc.send('gpu:normalize', { id, strings });
        })
      : null;

    importAbort = new AbortController();
    try {
      const totals = await importAll(databasesDir, {
        col: db.persons(),
        only: files && files.length ? files : null,
        signal: importAbort.signal,
        gpuNormalize: normalizeHook,
        onProgress: send,
      });
      return { ok: true, totals, cancelled: importAbort.signal.aborted };
    } catch (err) {
      return { error: err.message };
    } finally {
      importAbort = null;
      send({ phase: 'all-done' });
    }
  });

  ipcMain.handle('import:cancel', async () => {
    if (importAbort) importAbort.abort();
    return { ok: true };
  });

  ipcMain.on('gpu:normalize:result', (_e, { id, strings, error }) => {
    const entry = pendingGpu.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingGpu.delete(id);
    if (error) entry.resolve(null); // importer falls back to CPU folding
    else entry.resolve(strings);
  });
}

module.exports = { registerIpc };
