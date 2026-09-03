'use strict';

/**
 * Electron main process (Node.js):
 * owns the MongoDB connection, the importer, and all file/DB access.
 * The renderer owns the GPU (WebGPU) and the UI.
 *
 * GPU strategy (Windows facts, verified in Chromium source):
 *   - Chromium gives WebGPU ONE adapter per process and ignores powerPreference
 *     on Windows, defaulting to the integrated GPU on laptops. We pass
 *     --force-high-performance-gpu so the main window lands on the discrete GPU.
 *   - Every additional adapter gets its own hidden helper Electron process,
 *     pinned with --use-adapter-luid (see gpuHelpers.js). The GpuPool shards
 *     GPU work across the main window + helpers.
 *
 * Flags (also as env vars):
 *   --gpu-unsafe           WS_GPU_UNSAFE=1          bypass the WebGPU adapter blocklist
 *   --gpu-allow-software   WS_GPU_ALLOW_SOFTWARE=1  allow SwiftShader/WARP adapters
 *   --gpu-helpers=N        WS_GPU_HELPERS=N         force N helper processes (testing)
 *   --no-gpu-helpers       WS_GPU_HELPERS=0         never spawn helper processes
 *   --gpu-helper           (internal) run as a helper process
 */

const path = require('path');
const net = require('net');
const { app, BrowserWindow, ipcMain } = require('electron');

const argv = process.argv;
const hasFlag = (f) => argv.includes(f);
const flagValue = (name) => {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : null;
};

const IS_HELPER = hasFlag('--gpu-helper');
const GPU_UNSAFE = hasFlag('--gpu-unsafe') || process.env.WS_GPU_UNSAFE === '1';
const GPU_ALLOW_SOFTWARE = hasFlag('--gpu-allow-software') || process.env.WS_GPU_ALLOW_SOFTWARE === '1';
const NO_HELPERS = hasFlag('--no-gpu-helpers') || process.env.WS_GPU_HELPERS === '0';
const FORCE_HELPERS = (() => {
  const v = flagValue('gpu-helpers') || process.env.WS_GPU_HELPERS;
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : null;
})();

// --- GPU selection switches: must be appended before app is ready -----------
if (!IS_HELPER) {
  // Main window: bind Chromium's GPU process to the high-performance adapter
  // instead of the laptop default (integrated).
  app.commandLine.appendSwitch('force-high-performance-gpu');
}
const gpuSwitches = [];
if (GPU_UNSAFE) {
  gpuSwitches.push('--enable-unsafe-webgpu', '--ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
if (GPU_ALLOW_SOFTWARE) {
  gpuSwitches.push('--enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

const GPU_FLAGS = {
  unsafe: GPU_UNSAFE,
  allowSoftware: GPU_ALLOW_SOFTWARE,
  helpersDisabled: NO_HELPERS,
  helpersForced: FORCE_HELPERS,
  forceHighPerformanceGpu: !IS_HELPER,
  isHelper: IS_HELPER,
  useAdapterLuid: flagValue('use-adapter-luid'),
};

const PRELOAD = path.join(__dirname, '..', 'renderer', 'preload.js');

/* ========================================================================== */
/* Helper-process mode: one hidden window on the adapter this process got     */
/* ========================================================================== */

async function runHelper() {
  const helperId = flagValue('helper-id') || `helper-${process.pid}`;
  const pipeName = flagValue('helper-pipe');
  const log = (...a) => console.log(`[${helperId}]`, ...a);
  if (!pipeName) { console.error('helper started without --helper-pipe'); app.exit(2); return; }

  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 320, height: 200,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });

  // Renderer <-> this process
  let seq = 0;
  const pending = new Map();
  ipcMain.handle('gpu:flags', () => GPU_FLAGS);
  ipcMain.on('gpu:op:result', (_e, { id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });
  const runOp = (op, payload) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    win.webContents.send('gpu:op', { id, op, payload });
  });
  const stateP = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 30_000);
    ipcMain.once('gpu:state', (_e, st) => { clearTimeout(t); resolve(st); });
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'helper.html'));
  const state = await stateP;
  log('webgpu:', state && state.ok ? `${state.devices.length} device(s) ${state.devices.map((d) => `${d.vendor}/${d.architecture}`).join(',')}` : `none (${state && state.reason})`);

  // This process <-> parent over the named pipe (newline-delimited JSON)
  const { jsonLines } = require('./gpuHelpers');
  const socket = net.connect(pipeName);
  const send = jsonLines(socket, async (msg) => {
    if (msg.type === 'req') {
      try {
        const result = await runOp(msg.op, msg.payload);
        send({ type: 'res', id: msg.id, ok: true, result });
      } catch (err) {
        send({ type: 'res', id: msg.id, ok: false, error: String(err && err.message || err) });
      }
    } else if (msg.type === 'shutdown') {
      log('shutdown requested');
      app.quit();
    }
  });
  socket.on('connect', () => {
    send({ type: 'hello', helperId, pid: process.pid, state, flags: GPU_FLAGS });
  });
  socket.on('error', (err) => { log('pipe error', err.message); app.quit(); });
  socket.on('close', () => { log('parent gone'); app.quit(); });
}

/* ========================================================================== */
/* Normal app mode                                                            */
/* ========================================================================== */

async function runApp() {
  const db = require('./db');
  const { registerIpc } = require('./ipc');
  const { getHardware } = require('./hardware');
  const { GpuPool } = require('./gpuPool');
  const { HelperManager } = require('./gpuHelpers');

  const DATABASES_DIR = path.join(app.getAppPath(), 'databases');
  let win = null;
  let helpers = null;

  const pool = new GpuPool();
  pool.allowSoftware = GPU_ALLOW_SOFTWARE;

  const broadcastPlan = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('gpu:plan:changed', {
        pool: pool.plan(), helpers: helpers ? helpers.status() : null, flags: GPU_FLAGS,
      });
    }
  };
  pool.on('change', broadcastPlan);

  async function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 980,
      minHeight: 640,
      backgroundColor: '#101418',
      title: 'Windows Search (demo) - MongoDB + GPU',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false, // keep GPU fold requests flowing while minimised
      },
    });

    registerIpc({
      databasesDir: DATABASES_DIR,
      getWindow: () => win,
      pool,
      getHelperStatus: () => (helpers ? helpers.status() : null),
      gpuFlags: GPU_FLAGS,
    });

    // Mongo is required for search/import but the GUI still opens without it,
    // so the user can see the hardware inventory and the setup instructions.
    try {
      await db.connect();
      await db.ensureIndexes();
      console.log('[mongo] connected:', db.DEFAULT_URL, 'db:', db.DB_NAME);
    } catch (err) {
      console.warn('[mongo] not reachable yet:', err.message);
    }

    // Armed before the page loads so the renderer's first adapter report cannot
    // be missed; helpers wait for it (or 4 s) so the main window's GPU is known
    // when they report and any helper on the same adapter is the one dropped.
    const rendererReported = new Promise((resolve) => {
      const t = setTimeout(resolve, 4000);
      ipcMain.once('gpu:state', () => { clearTimeout(t); resolve(); });
    });

    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Extra GPUs -> helper processes. The CIM inventory (slow PowerShell) is
    // passed as a promise and probed concurrently with the LUID/Chromium
    // probes - it never delays the window or the other probes.
    helpers = new HelperManager({
      app, pool, appPath: app.getAppPath(), isPackaged: app.isPackaged,
      extraSwitches: gpuSwitches, log: (...a) => console.log(...a),
    });
    helpers.on('change', broadcastPlan);
    const cimGpuCount = getHardware()
      .then((hw) => hw.gpus.filter((g) => g.kind !== 'other').length)
      .catch(() => null);
    helpers.start({ force: FORCE_HELPERS, disabled: NO_HELPERS, cimGpuCount, ready: rendererReported })
      .catch((err) => console.warn('[gpu-helper] start failed:', err.message));
  }

  app.whenReady().then(createWindow);

  app.on('window-all-closed', async () => {
    if (helpers) await helpers.stopAll().catch(() => {});
    await db.close().catch(() => {});
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { if (helpers) helpers.stopAll().catch(() => {}); });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (IS_HELPER) runHelper().catch((err) => { console.error('[gpu-helper] fatal:', err); app.exit(1); });
else runApp();
