'use strict';

/**
 * Host hardware inventory + "pipeline involvement", ported from the
 * PowerShell bootstrap (Show-HostHardwareInventory / Show-PipelineInvolvement):
 * runtime detection, never hardcoded.
 *
 *  - CPU via Win32_Processor / Win32_ComputerSystem (cores, threads, vendor class)
 *  - Display adapters via Win32_VideoController, classified as
 *    discrete NVIDIA / Intel iGPU / AMD / other with the same regexes
 *  - nvidia-smi -L probe for the CUDA-capable path
 *  - an involvement report: which device does what in THIS app and why, plus
 *    the concrete parallel plan (worker threads, in-flight writes, GPU processes)
 */

const os = require('os');
const { execFile } = require('child_process');

const CACHE_TTL_MS = 60_000;
let cache = null;
let cacheAt = 0;

function run(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function queryCimJson(className, props) {
  // PowerShell is always present on Windows; ConvertTo-Json gives clean parsing.
  const ps = [
    'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance ${className} | Select-Object ${props.join(',')} | ConvertTo-Json -Compress`,
  ];
  const out = await run(ps[0], ps.slice(1));
  if (!out || !out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function classifyGpu(name) {
  if (/nvidia|geforce|quadro|rtx |gtx /i.test(name)) {
    return { kind: 'nvidia', label: 'External / discrete NVIDIA GPU' };
  }
  if (/intel/i.test(name)) return { kind: 'intel', label: 'Internal Intel GPU (iGPU / Arc)' };
  if (/amd|radeon/i.test(name)) return { kind: 'amd', label: 'AMD GPU' };
  return { kind: 'other', label: 'Other GPU' };
}

function classifyCpu(name, vendor) {
  const blob = `${name} ${vendor}`;
  if (/intel/i.test(blob)) return 'Intel';
  if (/amd|authenticamd/i.test(blob)) return 'AMD';
  if (/arm|qualcomm|snapdragon/i.test(blob)) return 'ARM';
  return 'Other';
}

async function detectNvidiaSmi() {
  const out = await run('nvidia-smi', ['-L'], 8_000);
  if (!out) return { available: false, gpus: [] };
  const gpus = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^GPU \d+:/.test(l));
  return { available: gpus.length > 0, gpus };
}

/** GPU adapter LUIDs from the perf counters (the handle --use-adapter-luid needs). */
async function detectAdapterLuids() {
  if (process.platform !== 'win32') return [];
  const out = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "(Get-Counter -ListSet 'GPU Adapter Memory' -ErrorAction Stop).PathsWithInstances",
  ], 15_000);
  if (!out) return [];
  const seen = new Set();
  const re = /luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_(\d+)/gi;
  let m;
  while ((m = re.exec(out))) seen.add(`0x${m[1].toUpperCase()}_0x${m[2].toUpperCase()}`);
  return [...seen];
}

async function getHardware({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const [cpus, systems, adapters, smi, luids] = await Promise.all([
    queryCimJson('Win32_Processor', ['Name', 'Manufacturer', 'NumberOfCores', 'NumberOfLogicalProcessors']),
    queryCimJson('Win32_ComputerSystem', ['NumberOfLogicalProcessors', 'TotalPhysicalMemory']),
    queryCimJson('Win32_VideoController', ['Name', 'AdapterRAM', 'DriverVersion', 'PNPDeviceID']),
    detectNvidiaSmi(),
    detectAdapterLuids(),
  ]);

  const cpu = cpus[0] || {};
  const sys = systems[0] || {};
  const threads = cpu.NumberOfLogicalProcessors || sys.NumberOfLogicalProcessors || os.cpus().length || 1;
  const cores = cpus.reduce((a, c) => a + (c.NumberOfCores || 0), 0) || null;
  const gpus = adapters
    .filter((a) => a && a.Name)
    .map((a) => {
      const cls = classifyGpu(a.Name);
      const ramMB = a.AdapterRAM > 0 ? Math.round(a.AdapterRAM / 1048576) : null;
      return { name: a.Name, ...cls, vramMB: ramMB, driver: a.DriverVersion || null, pnp: a.PNPDeviceID || null };
    });

  const hardwareGpus = gpus.filter((g) => g.kind !== 'other');
  const hasDiscreteNvidia = gpus.some((g) => g.kind === 'nvidia') || smi.available;
  const gpuProcesses = Math.max(1, hardwareGpus.length, luids.length);

  // Concrete parallel plan for THIS machine.
  const plan = {
    importWorkers: threads,                 // one worker thread per logical CPU
    inflightWritesPerWorker: 2,             // parse batch k+1 while k, k-1 are written
    concurrentBulkWrites: threads * 2,
    chunking: 'files split into byte-range chunks (auto size = total / (2 x workers), 8-256 MB)',
    gpuProcesses: hardwareGpus.length > 1 || luids.length > 1
      ? `${gpuProcesses} (main window on the high-performance adapter + ${gpuProcesses - 1} pinned helper process(es))`
      : '1 (main window; no second adapter to pin a helper to)',
    cpuRankWorkers: Math.max(1, threads - 1),
    adapterLuids: luids,
  };

  // Pipeline involvement: what each device will do in this app, and why the
  // rest are skipped (mirrors the PS involvement report).
  const involvement = [];
  for (const g of hardwareGpus) {
    const isPrimary = g === hardwareGpus.find((x) => x.kind === 'nvidia') || (!hasDiscreteNvidia && g === hardwareGpus[0]);
    involvement.push({
      device: g.kind === 'nvidia' ? 'NVIDIA GPU' : g.kind === 'intel' ? 'Intel GPU' : 'AMD GPU',
      role: 'gpu-compute',
      detail: (isPrimary
        ? 'Primary WebGPU device of the main window (Electron started with --force-high-performance-gpu, '
          + 'so Chromium binds to the fast adapter instead of the laptop default). '
        : 'Secondary adapter: Chromium exposes one adapter per process, so this GPU is driven by a hidden '
          + 'helper Electron process pinned with --use-adapter-luid. ')
        + 'Runs the WGSL rank kernel (search results) and the fold kernel (import text), sharded by weight.',
    });
  }
  const basic = gpus.filter((g) => g.kind === 'other');
  if (!gpus.length) {
    involvement.push({
      device: 'GPU',
      role: 'gpu-unavailable',
      detail: 'No display adapter reported by Win32_VideoController - CPU worker pool ranks instead.',
    });
  } else if (!hardwareGpus.length) {
    involvement.push({
      device: 'GPU',
      role: 'gpu-fallback',
      detail: `Only a basic/virtual display adapter (${basic.map((g) => g.name).join(', ')}) - WebGPU has no hardware `
        + 'adapter here; a software adapter is detected but not used (slower than JS); the CPU worker pool ranks.',
    });
  } else if (basic.length) {
    involvement.push({
      device: 'GPU',
      role: 'gpu-idle',
      detail: `Skipped: ${basic.map((g) => g.name).join(', ')} (basic/virtual adapter, no compute value).`,
    });
  }
  involvement.push({
    device: 'CPU',
    role: 'parallel-import',
    detail: `${threads} logical thread(s) -> ${plan.importWorkers} import worker(s), each parsing its own byte-range chunk of the `
      + `CSVs and writing to MongoDB with ${plan.inflightWritesPerWorker} bulkWrites in flight (${plan.concurrentBulkWrites} concurrent). `
      + `Search: ${plan.cpuRankWorkers} rank worker(s) take over when no GPU is usable; the main thread only orchestrates.`,
  });
  involvement.push({
    device: 'MongoDB (mongod)',
    role: 'storage',
    detail: 'Stores one document per person; indexes (nationalCode, mobile, card, name) '
      + 'narrow candidates before GPU ranking. Its own threads absorb the concurrent writes.',
  });

  cache = {
    cpu: {
      name: (cpu.Name || os.cpus()[0]?.model || 'Unknown').trim(),
      vendor: cpu.Manufacturer || 'Unknown',
      class: classifyCpu(cpu.Name || '', cpu.Manufacturer || ''),
      cores,
      threads,
    },
    memoryGB: sys.TotalPhysicalMemory ? Math.round(sys.TotalPhysicalMemory / 1073741824) : Math.round(os.totalmem() / 1073741824),
    gpus,
    hardwareGpuCount: hardwareGpus.length,
    adapterLuids: luids,
    nvidiaSmi: smi,
    preferredRanker: hardwareGpus.length ? 'webgpu' : 'cpu',
    plan,
    involvement,
    detectedAt: new Date().toISOString(),
  };
  cacheAt = now;
  return cache;
}

module.exports = { getHardware, classifyGpu, classifyCpu };
