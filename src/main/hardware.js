'use strict';

/**
 * Host hardware inventory + "pipeline involvement", ported from the
 * PowerShell bootstrap (Show-HostHardwareInventory / Show-PipelineInvolvement):
 * runtime detection, never hardcoded.
 *
 *  - CPU via Win32_Processor / Win32_ComputerSystem
 *  - Display adapters via Win32_VideoController, classified as
 *    discrete NVIDIA / Intel iGPU / AMD / other with the same regexes
 *  - nvidia-smi -L probe for the CUDA-capable path
 *  - an involvement report: which device does what in THIS app and why
 */

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

async function detectNvidiaSmi() {
  const out = await run('nvidia-smi', ['-L'], 8_000);
  if (!out) return { available: false, gpus: [] };
  const gpus = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^GPU \d+:/.test(l));
  return { available: gpus.length > 0, gpus };
}

async function getHardware({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const [cpus, systems, adapters, smi] = await Promise.all([
    queryCimJson('Win32_Processor', ['Name', 'Manufacturer', 'NumberOfLogicalProcessors']),
    queryCimJson('Win32_ComputerSystem', ['NumberOfLogicalProcessors', 'TotalPhysicalMemory']),
    queryCimJson('Win32_VideoController', ['Name', 'AdapterRAM', 'DriverVersion']),
    detectNvidiaSmi(),
  ]);

  const cpu = cpus[0] || {};
  const sys = systems[0] || {};
  const gpus = adapters
    .filter((a) => a && a.Name)
    .map((a) => {
      const cls = classifyGpu(a.Name);
      const ramMB = a.AdapterRAM > 0 ? Math.round(a.AdapterRAM / 1048576) : null;
      return { name: a.Name, ...cls, vramMB: ramMB, driver: a.DriverVersion || null };
    });

  const hasDiscreteNvidia = gpus.some((g) => g.kind === 'nvidia') || smi.available;

  // Pipeline involvement: what each device will do in this app, and why the
  // rest are skipped (mirrors the PS involvement report).
  const involvement = [];
  if (hasDiscreteNvidia) {
    involvement.push({
      device: 'NVIDIA GPU',
      role: 'gpu-rank',
      detail: 'Ranks/highlights search results with WebGPU compute shaders (WGSL); '
        + (smi.available ? 'CUDA device visible via nvidia-smi.' : 'driver visible, nvidia-smi missing.'),
    });
  }
  const intel = gpus.find((g) => g.kind === 'intel');
  if (intel) {
    involvement.push({
      device: 'Intel GPU',
      role: hasDiscreteNvidia ? 'gpu-idle' : 'gpu-rank',
      detail: hasDiscreteNvidia
        ? 'Skipped: discrete NVIDIA adapter is the preferred WebGPU device.'
        : 'Used for WebGPU result ranking when no discrete GPU is present.',
    });
  }
  const amd = gpus.find((g) => g.kind === 'amd');
  if (amd) {
    involvement.push({
      device: 'AMD GPU',
      role: hasDiscreteNvidia ? 'gpu-idle' : 'gpu-rank',
      detail: hasDiscreteNvidia
        ? 'Skipped: discrete NVIDIA adapter is the preferred WebGPU device.'
        : 'Used for WebGPU result ranking when no discrete GPU is present.',
    });
  }
  const classified = gpus.filter((g) => g.kind !== 'other');
  if (!gpus.length) {
    involvement.push({
      device: 'GPU',
      role: 'gpu-unavailable',
      detail: 'No display adapter reported by Win32_VideoController - CPU ranker will be used.',
    });
  } else if (!classified.length) {
    involvement.push({
      device: 'GPU',
      role: 'gpu-fallback',
      detail: 'Only a basic/virtual display adapter was found - WebGPU may run via software '
        + 'rasterizer; otherwise the CPU ranker is used.',
    });
  }
  involvement.push({
    device: 'CPU',
    role: 'orchestration',
    detail: 'CSV streaming/parse, MongoDB bulk writes, query planning, and the fallback '
      + 'result ranker when WebGPU is unavailable.',
  });
  involvement.push({
    device: 'MongoDB (mongod)',
    role: 'storage',
    detail: 'Stores one document per person; indexes (nationalCode, mobile, card, name) '
      + 'narrow candidates before GPU ranking.',
  });

  cache = {
    cpu: {
      name: (cpu.Name || 'Unknown').trim(),
      vendor: cpu.Manufacturer || 'Unknown',
      threads: cpu.NumberOfLogicalProcessors || sys.NumberOfLogicalProcessors || null,
    },
    memoryGB: sys.TotalPhysicalMemory ? Math.round(sys.TotalPhysicalMemory / 1073741824) : null,
    gpus,
    nvidiaSmi: smi,
    preferredRanker: gpus.some((g) => g.kind !== 'other') ? 'webgpu' : 'cpu',
    involvement,
    detectedAt: new Date().toISOString(),
  };
  cacheAt = now;
  return cache;
}

module.exports = { getHardware, classifyGpu };
