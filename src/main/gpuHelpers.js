'use strict';

/**
 * GPU helper processes - how this app uses MORE THAN ONE GPU on Windows.
 *
 * Chromium binds a whole process tree to a single DXGI adapter, so the only
 * way to put a second GPU to work from Electron is a second Electron process
 * whose GPU process is pinned to that adapter. Chromium has a switch for
 * exactly that:  --use-adapter-luid=<high>,<low>  (ui/gl/gl_display.cc), and
 * Windows exposes every adapter LUID through the "GPU Adapter Memory"
 * performance counters (instance names like luid_0x00000000_0x0000C8A5_phys_0)
 * - no native code needed.
 *
 * Flow:
 *   1. enumerate LUIDs (perf counters) and Chromium's own GPU list (getGPUInfo)
 *   2. spawn one hidden helper Electron process per LUID (or one unpinned
 *      helper when LUIDs are unavailable but >1 hardware GPU is reported)
 *   3. each helper loads renderer/helper.html (same gpuRank.js kernels),
 *      connects back over a named pipe and reports its WebGPU adapter
 *   4. the GpuPool registers it; a helper that landed on the SAME adapter as
 *      the main window is redundant and is shut down again (runtime detection)
 *
 * Everything degrades gracefully: no counters, no second GPU, or a helper that
 * fails to start simply means fewer endpoints in the pool.
 */

const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_HELPERS = 4;
const HELLO_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;

function runPowerShell(script, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * Adapter LUIDs from the "GPU Adapter Memory" perf counters.
 * Returns [{ high, low, hex, physIndex }] (unique by LUID), or [] when unavailable.
 */
async function enumerateAdapterLuids() {
  if (process.platform !== 'win32') return [];
  const out = await runPowerShell("(Get-Counter -ListSet 'GPU Adapter Memory' -ErrorAction Stop).PathsWithInstances");
  if (!out) return [];
  const seen = new Map();
  const re = /luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_(\d+)/gi;
  let m;
  while ((m = re.exec(out))) {
    const high = parseInt(m[1], 16) | 0;   // LONG  (signed)
    const low = parseInt(m[2], 16) >>> 0;  // DWORD (unsigned)
    const hex = `0x${m[1].toUpperCase()}_0x${m[2].toUpperCase()}`;
    if (!seen.has(hex)) seen.set(hex, { high, low, hex, physIndex: Number(m[3]) });
  }
  return [...seen.values()];
}

/** Chromium's view of the GPUs (Electron main process only). */
async function chromiumGpuInfo(app) {
  if (!app || typeof app.getGPUInfo !== 'function') return null;
  try {
    const info = await app.getGPUInfo('complete');
    const devices = (info && info.gpuDevice) || [];
    const PREF = { 0: 'default', 1: 'low-power', 2: 'high-performance' };
    return {
      devices: devices.map((d) => ({
        vendorId: d.vendorId, deviceId: d.deviceId, active: !!d.active,
        vendor: d.vendorString || null, device: d.deviceString || null,
        driverVersion: d.driverVersion || null, gpuPreference: PREF[d.gpuPreference] || String(d.gpuPreference),
        software: d.vendorId === 0 || d.vendorId === 0xffff || d.vendorId === 0x15ad || (d.vendorId === 0x1414 && d.deviceId === 0x8c),
      })),
      optimus: !!(info && info.auxAttributes && info.auxAttributes.optimus),
      amdSwitchable: !!(info && info.auxAttributes && info.auxAttributes.amdSwitchable),
      glRenderer: (info && info.auxAttributes && info.auxAttributes.glRenderer) || null,
    };
  } catch (err) {
    return { error: err.message, devices: [] };
  }
}

/** Newline-delimited JSON over a socket. */
function jsonLines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch { /* ignore malformed */ }
    }
  });
  return (obj) => { if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`); };
}

class HelperManager extends EventEmitter {
  /**
   * opts: { app, pool, appPath, isPackaged, execPath, extraSwitches: [] , log }
   */
  constructor(opts) {
    super();
    this.app = opts.app;
    this.pool = opts.pool;
    this.appPath = opts.appPath;
    this.isPackaged = !!opts.isPackaged;
    this.execPath = opts.execPath || process.execPath;
    this.extraSwitches = opts.extraSwitches || [];
    this.log = opts.log || (() => {});
    this.pipeName = `\\\\.\\pipe\\windows-search-gpu-${process.pid}`;
    this.server = null;
    this.helpers = new Map(); // id -> { id, child, socket, send, pending, luid, hello, status }
    this.seq = 0;
    this.discovery = { luids: [], chromium: null, cimGpuCount: null, decision: null };
    // A helper that reported before the main window and landed on the same
    // adapter gets demoted by the pool once the window registers - stop it.
    this.pool.on('demoted', (rec) => {
      const helper = this.helpers.get(rec.id);
      if (!helper || helper.status !== 'active') return;
      helper.status = 'skipped';
      this.log(`[gpu-helper] ${helper.id}: ${rec.reason}; shutting it down`);
      this._stopHelper(helper, rec.reason);
      this.emit('change');
    });
  }

  async listen() {
    if (this.server) return;
    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.pipeName, resolve);
    });
  }

  _onConnection(socket) {
    let helper = null;
    const send = jsonLines(socket, (msg) => {
      if (msg.type === 'hello') {
        helper = this.helpers.get(msg.helperId);
        if (!helper) { socket.destroy(); return; }
        clearTimeout(helper.helloTimer);
        helper.socket = socket;
        helper.send = send;
        helper.hello = msg;
        this._register(helper, msg);
      } else if (msg.type === 'res' && helper) {
        const p = helper.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        helper.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'helper error'));
      }
    });
    socket.on('close', () => {
      if (!helper) return;
      for (const p of helper.pending.values()) { clearTimeout(p.timer); p.reject(new Error('helper disconnected')); }
      helper.pending.clear();
      helper.status = helper.status === 'skipped' ? 'skipped' : 'gone';
      this.pool.unregister(helper.id);
      this.emit('change');
    });
    socket.on('error', () => {});
  }

  _register(helper, hello) {
    const state = hello.state || {};
    const primary = (state.devices && state.devices[0]) || null;
    const adapter = primary ? {
      vendor: primary.vendor, architecture: primary.architecture, device: primary.device,
      description: primary.description, isFallbackAdapter: !!primary.isFallbackAdapter,
    } : null;
    const rec = this.pool.register({
      id: helper.id,
      kind: 'helper',
      label: `GPU helper ${helper.index}${helper.luid ? ` (LUID ${helper.luid.hex})` : ''}`,
      adapter,
      meta: {
        pid: helper.child ? helper.child.pid : null,
        luid: helper.luid ? helper.luid.hex : null,
        switches: helper.switches,
        reason: state.reason || null,
        cpuWorkers: state.cpuWorkers || 0,
      },
      send: (op, payload) => this._request(helper, op, payload),
    });
    helper.status = rec.status;
    if (rec.status !== 'active') {
      // Redundant (same adapter as another endpoint) or GPU-less: free the RAM.
      this.log(`[gpu-helper] ${helper.id}: ${rec.status} - ${rec.reason}; shutting it down`);
      this._stopHelper(helper, rec.reason);
    } else {
      this.log(`[gpu-helper] ${helper.id}: active on ${adapter.vendor}/${adapter.architecture} (${rec.adapterClass})`);
    }
    this.emit('change');
  }

  _request(helper, op, payload) {
    return new Promise((resolve, reject) => {
      if (!helper.send || !helper.socket || helper.socket.destroyed) { reject(new Error('helper not connected')); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { helper.pending.delete(id); reject(new Error('helper request timed out')); }, REQUEST_TIMEOUT_MS);
      helper.pending.set(id, { resolve, reject, timer });
      helper.send({ type: 'req', id, op, payload });
    });
  }

  _spawnHelper(index, luid, switches) {
    const id = `helper-${index}`;
    const args = [];
    if (!this.isPackaged) args.push(this.appPath);
    args.push('--gpu-helper', `--helper-id=${id}`, `--helper-pipe=${this.pipeName}`);
    if (luid) args.push(`--use-adapter-luid=${luid.high},${luid.low}`);
    for (const s of switches) args.push(s);

    const env = { ...process.env, WS_GPU_HELPER: '1' };
    delete env.ELECTRON_RUN_AS_NODE; // the helper must be a full Electron app (it needs a GPU process)
    const child = spawn(this.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    const helper = {
      id, index, child, luid, switches: args.filter((a) => a.startsWith('--') && !a.startsWith('--helper-') && a !== '--gpu-helper'),
      socket: null, send: null, hello: null, pending: new Map(), status: 'starting', log: [],
    };
    const tail = (buf) => {
      const s = String(buf).trim();
      if (!s) return;
      helper.log.push(s);
      if (helper.log.length > 40) helper.log.shift();
    };
    child.stdout.on('data', tail);
    child.stderr.on('data', tail);
    child.on('exit', (code) => {
      helper.status = helper.status === 'skipped' ? 'skipped' : 'exited';
      helper.exitCode = code;
      this.pool.unregister(id);
      this.emit('change');
    });
    helper.helloTimer = setTimeout(() => {
      if (!helper.hello) {
        this.log(`[gpu-helper] ${id} did not report within ${HELLO_TIMEOUT_MS / 1000}s; killing it`);
        helper.status = 'timeout';
        this._stopHelper(helper, 'no handshake');
      }
    }, HELLO_TIMEOUT_MS);
    this.helpers.set(id, helper);
    this.log(`[gpu-helper] spawned ${id} pid=${child.pid} ${luid ? `pinned to LUID ${luid.hex}` : '(unpinned)'}`);
    return helper;
  }

  _stopHelper(helper, reason) {
    helper.stopReason = reason || null;
    try { if (helper.send) helper.send({ type: 'shutdown' }); } catch { /* ignore */ }
    const kill = () => { try { if (helper.child && !helper.child.killed) helper.child.kill(); } catch { /* ignore */ } };
    setTimeout(kill, 1500);
  }

  /**
   * Decide how many helpers to start and start them.
   * opts: {
   *   force (number|null), disabled (bool),
   *   cimGpuCount (number | Promise<number|null> | null)  - Win32_VideoController hint; may resolve late,
   *   ready (Promise|null) - resolved once the main window has reported its adapter (so a helper that
   *                          lands on the same GPU is the one dropped, never the main window)
   * }
   * All probes (LUID perf counters, Chromium GPU info, CIM inventory) run concurrently; none of them
   * blocks the others, so a slow PowerShell query only delays the decision, never the app.
   */
  async start(opts = {}) {
    if (opts.disabled) {
      this.discovery.decision = 'disabled by --no-gpu-helpers';
      this.emit('change');
      return;
    }
    this.discovery.decision = 'probing adapters (LUID perf counters + Chromium GPU info + CIM)...';
    this.emit('change');
    const settle = (p, fallback) => Promise.resolve(p).catch(() => fallback);
    const [, luids, chromium, cimGpuCount] = await Promise.all([
      this.listen(),
      settle(enumerateAdapterLuids(), []),
      settle(chromiumGpuInfo(this.app), null),
      settle(opts.cimGpuCount, null),
      settle(opts.ready, null),
    ]);
    this.discovery.luids = luids;
    this.discovery.chromium = chromium;
    this.discovery.cimGpuCount = cimGpuCount == null ? null : cimGpuCount;

    const hwFromChromium = chromium && chromium.devices ? chromium.devices.filter((d) => !d.software).length : 0;
    const hwCount = Math.max(luids.length, hwFromChromium, cimGpuCount || 0);

    let plan = [];
    if (opts.force != null && opts.force > 0) {
      const n = Math.min(MAX_HELPERS, opts.force);
      plan = Array.from({ length: n }, (_, i) => ({ luid: luids[i] || null }));
      this.discovery.decision = `forced ${n} helper(s) via --gpu-helpers`;
    } else if (luids.length >= 2) {
      plan = luids.slice(0, MAX_HELPERS).map((luid) => ({ luid }));
      this.discovery.decision = `${luids.length} adapter LUIDs found -> one pinned helper per adapter (the one matching the main window is dropped after handshake)`;
    } else if (hwCount >= 2) {
      plan = [{ luid: null }];
      this.discovery.decision = `${hwCount} GPUs reported but LUIDs unavailable -> one unpinned helper (kept only if Chromium gives it a different adapter)`;
    } else {
      this.discovery.decision = `single GPU adapter detected (${luids.length} LUID, ${hwFromChromium} Chromium device(s), ${cimGpuCount == null ? '?' : cimGpuCount} CIM adapter(s)) -> no helper processes`;
    }
    this.log(`[gpu-helper] ${this.discovery.decision}`);
    this.emit('change');
    plan.forEach((p, i) => this._spawnHelper(i + 1, p.luid, this.extraSwitches));
  }

  /** Snapshot for the GUI/CLI plan. */
  status() {
    return {
      pipe: this.pipeName,
      discovery: this.discovery,
      helpers: [...this.helpers.values()].map((h) => ({
        id: h.id, pid: h.child ? h.child.pid : null, status: h.status, luid: h.luid ? h.luid.hex : null,
        switches: h.switches, stopReason: h.stopReason || null, exitCode: h.exitCode == null ? null : h.exitCode,
        adapter: h.hello && h.hello.state && h.hello.state.devices ? h.hello.state.devices[0] || null : null,
        log: h.log.slice(-5),
      })),
    };
  }

  async stopAll() {
    for (const h of this.helpers.values()) this._stopHelper(h, 'app quit');
    await new Promise((r) => setTimeout(r, 200));
    for (const h of this.helpers.values()) { try { h.child.kill(); } catch { /* ignore */ } }
    if (this.server) { this.server.close(); this.server = null; }
  }
}

module.exports = { HelperManager, enumerateAdapterLuids, chromiumGpuInfo, jsonLines, MAX_HELPERS };
