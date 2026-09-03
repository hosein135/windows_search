'use strict';

/**
 * GPU ranking + GPU text normalization via WebGPU compute shaders (WGSL),
 * with a CPU Web Worker pool as the parallel fallback.
 *
 * The Mongo query narrows candidates with indexes; this module scores those
 * candidates ON THE GPU (one work-item per document) and, when enabled,
 * folds Persian characters for import batches on the GPU too.
 *
 * Device model (runtime-detected, never hardcoded):
 *   - Every DISTINCT adapter WebGPU hands out is turned into a device and used
 *     (default / high-performance / low-power requests). Chromium on Windows
 *     exposes one adapter per process (crbug.com/329211593), so here that is
 *     normally one device - the high-performance GPU, because main.js starts
 *     Electron with --force-high-performance-gpu. Extra GPUs are driven by
 *     pinned helper processes (main/gpuHelpers.js) that load this same file.
 *   - A software adapter (SwiftShader/WARP) is detected and reported but only
 *     used when explicitly allowed: for these kernels it is slower than JS.
 *   - CPU: navigator.hardwareConcurrency Web Workers run the same scoring
 *     over the same packed buffers when no GPU is usable, sharded by document
 *     range; tiny candidate sets stay on the main thread (no worker overhead).
 *
 * Everything degrades to a CPU implementation when WebGPU is unavailable,
 * mirroring the bootstrap script's "runtime detection, never hardcoded" rule.
 */

const FIELD_WEIGHTS = [3, 100, 80, 80]; // searchName, nationalCode, mobile, card
const MAX_FIELD_UNITS = 256;
const NUM_FIELDS = 4;
const MIN_SHARD_DOCS = 512;      // below 2x this, one device does everything
const CPU_POOL_MIN_DOCS = 2048;  // below this the main thread ranks (no worker hop)
const FOLD_SHARD_MIN = 1024;

/* ------------------------------------------------------------------ */
/* WGSL kernels                                                        */
/* ------------------------------------------------------------------ */

// NOTE: WGSL reserves many plain words (meta, filter, target, type, set, ...);
// binding names below are deliberately prefixed so they never collide.
const RANK_WGSL = /* wgsl */`
struct Params { numDocs: u32, numTokens: u32, numFields: u32, pad: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> docMeta: array<u32>;   // per doc-field: [start, len]
@group(0) @binding(2) var<storage, read> docText: array<u32>;   // doc code units
@group(0) @binding(3) var<storage, read> qMeta: array<u32>;     // per token: [start, len]
@group(0) @binding(4) var<storage, read> qText: array<u32>;     // token code units
@group(0) @binding(5) var<storage, read_write> outScore: array<u32>;
@group(0) @binding(6) var<storage, read_write> outMask: array<u32>;

fn fieldWeight(f: u32) -> u32 {
  switch f {
    case 0u: { return ${FIELD_WEIGHTS[0]}u; }
    case 1u: { return ${FIELD_WEIGHTS[1]}u; }
    case 2u: { return ${FIELD_WEIGHTS[2]}u; }
    default: { return ${FIELD_WEIGHTS[3]}u; }
  }
}

// One invocation per document. Same semantics as cpuRank():
//   token == field            -> weight * 10
//   token substring of field  -> weight
// Written with flag-terminated while loops and no break/continue on purpose:
// the D3D (HLSL) backend miscompiled the nested break/continue form (caught by
// the init self-test on WARP), while SPIR-V was fine. This shape is correct on
// every backend and no slower (the loops terminate on the same condition).
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let doc = gid.x;
  if (doc >= params.numDocs) { return; }
  var score = 0u;
  var mask = 0u;
  for (var f = 0u; f < params.numFields; f = f + 1u) {
    let mbase = (doc * params.numFields + f) * 2u;
    let fs = docMeta[mbase];
    let fl = docMeta[mbase + 1u];
    let w = fieldWeight(f);
    for (var t = 0u; t < params.numTokens; t = t + 1u) {
      let ts = qMeta[t * 2u];
      let tl = qMeta[t * 2u + 1u];
      if (fl != 0u && tl != 0u && tl <= fl) {
        var found = false;
        var i = 0u;
        while (!found && i + tl <= fl) {
          var same = true;
          var k = 0u;
          while (same && k < tl) {
            same = docText[fs + i + k] == qText[ts + k];
            k = k + 1u;
          }
          found = same;
          i = i + 1u;
        }
        if (found) {
          if (tl == fl) { score = score + w * 10u; } else { score = score + w; }
          mask = mask | (1u << f);
        }
      }
    }
  }
  outScore[doc] = score;
  outMask[doc] = mask;
}
`;

const FOLD_WGSL = /* wgsl */`
// Persian/Arabic fold on the GPU: ي->ی  ك->ک  tatweel->dropped
// Arabic-Indic + Persian digits -> ASCII. One work-item per code unit.
// A 1:1 kernel cannot delete, so tatweel becomes the U+FFFF noncharacter and
// the readback strips it - identical output to the main-process normalizer.
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp)) { return; }
  var c = inp[i];
  if (c == 0x064Au) { c = 0x06CCu; }        // ي -> ی
  else if (c == 0x0643u) { c = 0x06A9u; }   // ك -> ک
  else if (c == 0x0640u) { c = 0xFFFFu; }   // tatweel -> sentinel (stripped on readback)
  else if (c >= 0x0660u && c <= 0x0669u) { c = 0x30u + (c - 0x0660u); }
  else if (c >= 0x06F0u && c <= 0x06F9u) { c = 0x30u + (c - 0x06F0u); }
  outp[i] = c;
}
`;

/* ------------------------------------------------------------------ */
/* Adapter discovery + device management                               */
/* ------------------------------------------------------------------ */

const BASE_WEIGHT = { discrete: 4, integrated: 1, unknown: 2, software: 0.25 };

let gpuState = null; // see state()
let gpuDevices = []; // [{ id, via, adapter, device, info, kind, weight, rankPipeline, foldPipeline }]
let cpuPool = null;

function classifyAdapter(info) {
  if (!info) return 'none';
  const blob = `${info.architecture} ${info.description} ${info.device}`.toLowerCase();
  if (info.isFallbackAdapter || /swiftshader|warp|llvmpipe|software/.test(blob)) return 'software';
  const v = String(info.vendor || '').toLowerCase();
  if (v === 'nvidia') return 'discrete';
  if (v === 'intel') return /arc|dg2|battlemage|xe-hpg|xe2-hpg|alchemist/.test(blob) ? 'discrete' : 'integrated';
  if (v === 'amd') return /igpu|apu|vega-igpu|gfx90c|gfx1035|gfx1036|gfx1103|raphael|phoenix|rembrandt|renoir|cezanne/.test(blob) ? 'integrated' : 'discrete';
  if (v === 'apple' || v === 'qualcomm' || v === 'arm') return 'integrated';
  return 'unknown';
}

async function readAdapterInfo(adapter) {
  let raw = adapter.info || null;
  if (!raw && typeof adapter.requestAdapterInfo === 'function') {
    try { raw = await adapter.requestAdapterInfo(); } catch { raw = null; }
  }
  raw = raw || {};
  const isFallback = !!(adapter.isFallbackAdapter || raw.isFallbackAdapter);
  const lim = adapter.limits || {};
  return {
    vendor: raw.vendor || '', architecture: raw.architecture || '',
    device: raw.device || '', description: raw.description || '',
    isFallbackAdapter: isFallback,
    features: adapter.features ? [...adapter.features] : [],
    maxBufferMB: lim.maxBufferSize ? Math.round(lim.maxBufferSize / 1048576) : null,
    maxStorageBindingMB: lim.maxStorageBufferBindingSize ? Math.round(lim.maxStorageBufferBindingSize / 1048576) : null,
    maxWorkgroupsPerDim: lim.maxComputeWorkgroupsPerDimension || null,
  };
}

const adapterKey = (info) => [info.vendor, info.architecture, info.device, info.description, info.isFallbackAdapter ? 'sw' : 'hw'].join('|');

async function discoverAdapters() {
  const found = [];
  const notes = [];
  const seen = new Set();
  const attempt = async (via, opts) => {
    try {
      const adapter = await navigator.gpu.requestAdapter(opts);
      if (!adapter) { notes.push(`${via}: no adapter`); return; }
      const info = await readAdapterInfo(adapter);
      const key = adapterKey(info);
      if (seen.has(key)) { notes.push(`${via}: same adapter as an earlier request`); return; }
      seen.add(key);
      found.push({ adapter, info, via });
    } catch (err) {
      notes.push(`${via}: ${err && err.message || err}`);
    }
  };
  await attempt('default', undefined);
  await attempt('high-performance', { powerPreference: 'high-performance' });
  await attempt('low-power', { powerPreference: 'low-power' });
  await attempt('software fallback', { forceFallbackAdapter: true });
  return { found, notes };
}

const MAX_CONSECUTIVE_FAILURES = 3;

/** Compile a kernel; surfaces WGSL errors as a rejection instead of a silent invalid pipeline. */
async function buildPipeline(device, code, label) {
  const module = device.createShaderModule({ code, label });
  if (typeof module.getCompilationInfo === 'function') {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      throw new Error(`${label} WGSL: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    }
  }
  // createComputePipelineAsync rejects on an invalid pipeline; the sync variant
  // would hand back an invalid object that only fails later, silently.
  return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
}

/**
 * Run the kernels once on a tiny known input and compare against the JS
 * reference. Catches driver miscompiles / wrong results before the device is
 * trusted with real searches (a wrong GPU would otherwise return garbage).
 */
async function selfTest(rec) {
  const docs = [
    { searchName: 'علی اسدی', nationalCode: '0012345678', mobiles: ['09121234567'], cards: [] },
    { searchName: 'مریم مرادی', nationalCode: '0087654321', mobiles: [], cards: ['6037991234567890'] },
    { searchName: 'اسد اسدی', nationalCode: '', mobiles: [], cards: [] },
  ];
  const tokens = ['اسدی', '0912'];
  const ref = docs.map((doc) => cpuRank([doc], tokens, 1)[0] || { score: 0, mask: 0 });
  const q = packStrings(tokens, MAX_FIELD_UNITS);
  const { scores, masks } = await rankPackedOnDevice(rec, packDocs(docs), q, tokens.length);
  for (let i = 0; i < docs.length; i++) {
    if (scores[i] !== ref[i].score || masks[i] !== ref[i].mask) {
      throw new Error(`rank kernel self-test mismatch on doc ${i}: gpu ${scores[i]}/${masks[i]} vs js ${ref[i].score}/${ref[i].mask}`);
    }
  }
  const foldIn = ['علي كريم ۱۲۳٤۵', 'كـتاب', 'abc']; // ي ك, digits, tatweel
  const folded = await foldOnDevice(rec, foldIn);
  const expect = cpuFold(foldIn);
  for (let i = 0; i < foldIn.length; i++) {
    if (folded[i] !== expect[i]) throw new Error(`fold kernel self-test mismatch: "${folded[i]}" vs "${expect[i]}"`);
  }
  // Self-test traffic should not pollute the visible stats.
  rec.stats = { rankCalls: 0, rankDocs: 0, rankMs: 0, foldCalls: 0, foldUnits: 0, foldMs: 0, errors: 0 };
}

async function makeDevice(entry, index) {
  const device = await entry.adapter.requestDevice();
  const kind = classifyAdapter(entry.info);
  const rec = {
    id: `gpu${index}`, via: entry.via, adapter: entry.adapter, device, info: entry.info,
    kind, weight: BASE_WEIGHT[kind] || 1, rankPipeline: null, foldPipeline: null, lost: false,
    consecutiveFailures: 0,
    stats: { rankCalls: 0, rankDocs: 0, rankMs: 0, foldCalls: 0, foldUnits: 0, foldMs: 0, errors: 0 },
  };
  device.lost.then((info) => {
    rec.lost = true;
    retireDevice(rec, `device lost: ${info && info.message}`);
  });
  device.addEventListener('uncapturederror', (ev) => {
    rec.stats.errors++;
    console.warn('[gpu] uncaptured error on', rec.id, ev.error && ev.error.message);
  });
  try {
    [rec.rankPipeline, rec.foldPipeline] = await Promise.all([
      buildPipeline(device, RANK_WGSL, 'rank'),
      buildPipeline(device, FOLD_WGSL, 'fold'),
    ]);
    await selfTest(rec);
  } catch (err) {
    try { device.destroy(); } catch { /* ignore */ }
    throw err;
  }
  return rec;
}

/** Drop a device from the active set (lost, or too many failed dispatches). */
function retireDevice(rec, why) {
  if (!gpuDevices.includes(rec)) return;
  gpuDevices = gpuDevices.filter((d) => d !== rec);
  if (gpuState) {
    gpuState.notes.push(`${rec.id} retired: ${why}`);
    gpuState.rejected.push({ ...rec.info, via: rec.via, kind: rec.kind, reason: `retired at runtime: ${why}` });
  }
  refreshStateDevices();
  console.warn('[gpu] retired', rec.id, why);
}

function noteResult(rec, err) {
  if (!err) { rec.consecutiveFailures = 0; return; }
  rec.stats.errors++;
  rec.consecutiveFailures++;
  if (rec.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    retireDevice(rec, `${rec.consecutiveFailures} consecutive failures (${err.message || err})`);
  }
}

/**
 * Run `fn` with validation + OOM error scopes. Errors inside a submitted
 * command buffer never throw by themselves (the readback just comes back as
 * zeros), so the scopes are what turn a failed dispatch into an exception the
 * callers can fall back from.
 */
async function withErrorScopes(rec, fn) {
  const { device } = rec;
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let result;
  let thrown = null;
  try {
    result = await fn();
  } catch (err) {
    thrown = err;
  }
  const [validation, oom] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
  const err = thrown || (validation && new Error(`GPU validation error: ${validation.message}`))
    || (oom && new Error(`GPU out of memory: ${oom.message}`)) || null;
  noteResult(rec, err);
  if (err) throw err;
  return result;
}

/**
 * Initialise WebGPU devices + the CPU worker pool.
 * opts: { allowSoftware = false, cpuWorkers = hardwareConcurrency - 1 }
 */
async function initGpu(opts = {}) {
  if (gpuState) return gpuState;
  const allowSoftware = !!opts.allowSoftware;
  const hc = Math.max(1, navigator.hardwareConcurrency || 1);
  const cpuWorkers = Math.max(0, Math.min(64, opts.cpuWorkers == null ? hc - 1 : opts.cpuWorkers));
  cpuPool = cpuWorkers > 0 ? new CpuRankPool(cpuWorkers) : null;

  gpuState = {
    ok: false, devices: [], rejected: [], notes: [], reason: null,
    hardwareConcurrency: hc, cpuWorkers, allowSoftware,
    singleAdapterPerProcess: /win/i.test(navigator.platform || ''),
  };

  if (!('gpu' in navigator) || !navigator.gpu) {
    gpuState.reason = 'WebGPU API not exposed in this runtime';
    return gpuState;
  }
  const { found, notes } = await discoverAdapters();
  gpuState.notes.push(...notes);
  if (!found.length) {
    gpuState.reason = 'No WebGPU adapter (no compatible GPU/driver; try --gpu-unsafe to bypass the blocklist)';
    return gpuState;
  }
  let idx = 0;
  for (const entry of found) {
    const kind = classifyAdapter(entry.info);
    if (kind === 'software' && !allowSoftware) {
      gpuState.rejected.push({ ...entry.info, via: entry.via, kind, reason: 'software adapter - slower than JS for these kernels (allow with --gpu-allow-software)' });
      continue;
    }
    try {
      gpuDevices.push(await makeDevice(entry, idx++));
    } catch (err) {
      // requestDevice failure, WGSL compile error or kernel self-test mismatch:
      // the adapter is listed but never trusted with real work.
      gpuState.rejected.push({ ...entry.info, via: entry.via, kind, reason: `unusable: ${err && err.message}` });
      gpuState.notes.push(`${entry.via}: ${err && err.message}`);
    }
  }
  // Fastest first: the single-device path uses devices[0].
  gpuDevices.sort((a, b) => b.weight - a.weight);
  gpuState.ok = gpuDevices.length > 0;
  if (!gpuState.ok) gpuState.reason = gpuState.rejected.length ? gpuState.rejected[0].reason : 'no usable adapter';
  refreshStateDevices();
  return gpuState;
}

function refreshStateDevices() {
  if (!gpuState) return;
  gpuState.devices = gpuDevices.map((d) => ({
    id: d.id, via: d.via, kind: d.kind, weight: d.weight,
    vendor: d.info.vendor, architecture: d.info.architecture, device: d.info.device,
    description: d.info.description, isFallbackAdapter: d.info.isFallbackAdapter,
    features: d.info.features, maxBufferMB: d.info.maxBufferMB,
    maxStorageBindingMB: d.info.maxStorageBindingMB, stats: { ...d.stats },
  }));
  gpuState.ok = gpuDevices.length > 0;
}

function gpuAvailable() {
  return gpuDevices.length > 0;
}

/* ------------------------------------------------------------------ */
/* Packing helpers (typed arrays, no intermediate JS arrays)           */
/* ------------------------------------------------------------------ */

function docFieldStrings(doc) {
  return [
    doc.searchName || '',
    doc.nationalCode || '',
    (doc.mobiles && doc.mobiles[0]) || '',
    (doc.cards && doc.cards[0]) || '',
  ];
}

/** Pack docs into { meta (start,len per doc-field), text (UTF-16 units) }. */
function packDocs(docs) {
  const n = docs.length;
  const meta = new Uint32Array(n * NUM_FIELDS * 2);
  const strs = new Array(n * NUM_FIELDS);
  let total = 0;
  for (let d = 0; d < n; d++) {
    const fields = docFieldStrings(docs[d]);
    for (let f = 0; f < NUM_FIELDS; f++) {
      const s = String(fields[f] == null ? '' : fields[f]);
      const len = Math.min(s.length, MAX_FIELD_UNITS);
      const i = d * NUM_FIELDS + f;
      strs[i] = s;
      meta[i * 2] = total;
      meta[i * 2 + 1] = len;
      total += len;
    }
  }
  const text = new Uint32Array(Math.max(1, total));
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i];
    const start = meta[i * 2];
    const len = meta[i * 2 + 1];
    for (let k = 0; k < len; k++) text[start + k] = s.charCodeAt(k);
  }
  return { meta, text, numDocs: n };
}

/** Pack a flat list of strings into { meta, text }. */
function packStrings(list, maxLen) {
  const meta = new Uint32Array(list.length * 2);
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const len = Math.min(String(list[i] == null ? '' : list[i]).length, maxLen);
    meta[i * 2] = total;
    meta[i * 2 + 1] = len;
    total += len;
  }
  const text = new Uint32Array(Math.max(1, total));
  for (let i = 0; i < list.length; i++) {
    const s = String(list[i] == null ? '' : list[i]);
    const start = meta[i * 2];
    const len = meta[i * 2 + 1];
    for (let k = 0; k < len; k++) text[start + k] = s.charCodeAt(k);
  }
  return { meta, text };
}

/** Split n items over units by weight -> [{ unit, start, end }]. */
function shardByWeight(n, units, minShard) {
  if (!units.length) return [];
  if (units.length === 1 || n < minShard * 2) return [{ unit: units[0], start: 0, end: n }];
  const total = units.reduce((a, u) => a + Math.max(0.05, u.weight), 0);
  const out = [];
  let cursor = 0;
  for (let i = 0; i < units.length; i++) {
    const share = i === units.length - 1 ? n - cursor : Math.floor((n * Math.max(0.05, units[i].weight)) / total);
    if (share <= 0) continue;
    out.push({ unit: units[i], start: cursor, end: cursor + share });
    cursor += share;
  }
  if (out.length && cursor < n) out[out.length - 1].end = n;
  return out;
}

/* ------------------------------------------------------------------ */
/* GPU ranking                                                         */
/* ------------------------------------------------------------------ */

function rankPackedOnDevice(dev, packed, q, numTokens) {
  return withErrorScopes(dev, async () => {
    const { device, rankPipeline } = dev;
    const numDocs = packed.numDocs;
    const t0 = performance.now();
    const USAGE = GPUBufferUsage;
    const bufs = [];
    const mk = (arr, usage) => {
      const b = device.createBuffer({ size: Math.max(4, arr.byteLength), usage, mappedAtCreation: true });
      new Uint32Array(b.getMappedRange()).set(arr);
      b.unmap();
      bufs.push(b);
      return b;
    };
    const plain = (size, usage) => { const b = device.createBuffer({ size, usage }); bufs.push(b); return b; };
    try {
      const paramsBuf = mk(new Uint32Array([numDocs, numTokens, NUM_FIELDS, 0]), USAGE.UNIFORM);
      const metaBuf = mk(packed.meta, USAGE.STORAGE);
      const textBuf = mk(packed.text, USAGE.STORAGE);
      const qmetaBuf = mk(q.meta, USAGE.STORAGE);
      const qtextBuf = mk(q.text, USAGE.STORAGE);
      const scoreBuf = plain(numDocs * 4, USAGE.STORAGE | USAGE.COPY_SRC);
      const maskBuf = plain(numDocs * 4, USAGE.STORAGE | USAGE.COPY_SRC);
      const scoreRead = plain(numDocs * 4, USAGE.MAP_READ | USAGE.COPY_DST);
      const maskRead = plain(numDocs * 4, USAGE.MAP_READ | USAGE.COPY_DST);

      const bind = device.createBindGroup({
        layout: rankPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuf } },
          { binding: 1, resource: { buffer: metaBuf } },
          { binding: 2, resource: { buffer: textBuf } },
          { binding: 3, resource: { buffer: qmetaBuf } },
          { binding: 4, resource: { buffer: qtextBuf } },
          { binding: 5, resource: { buffer: scoreBuf } },
          { binding: 6, resource: { buffer: maskBuf } },
        ],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(rankPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(numDocs / 64));
      pass.end();
      encoder.copyBufferToBuffer(scoreBuf, 0, scoreRead, 0, numDocs * 4);
      encoder.copyBufferToBuffer(maskBuf, 0, maskRead, 0, numDocs * 4);
      device.queue.submit([encoder.finish()]);

      await Promise.all([scoreRead.mapAsync(GPUMapMode.READ), maskRead.mapAsync(GPUMapMode.READ)]);
      const scores = new Uint32Array(scoreRead.getMappedRange()).slice();
      const masks = new Uint32Array(maskRead.getMappedRange()).slice();
      scoreRead.unmap(); maskRead.unmap();
      dev.stats.rankCalls++;
      dev.stats.rankDocs += numDocs;
      dev.stats.rankMs += performance.now() - t0;
      return { scores, masks };
    } finally {
      for (const b of bufs) { try { b.destroy(); } catch { /* already gone */ } }
    }
  });
}

/* ------------------------------------------------------------------ */
/* CPU worker pool (same algorithm as the WGSL kernel, packed buffers) */
/* ------------------------------------------------------------------ */

class CpuRankPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.pending = new Map();
    this.seq = 0;
    this.rr = 0;
    this.stats = { calls: 0, docs: 0, ms: 0 };
    for (let i = 0; i < size; i++) {
      const w = new Worker('rankWorker.js');
      w.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve({ scores: e.data.scores, masks: e.data.masks });
      };
      w.onerror = (e) => console.warn('[cpu-pool] worker error', e.message);
      this.workers.push(w);
    }
  }
  rank(packed, q, numTokens) {
    const id = ++this.seq;
    const w = this.workers[this.rr++ % this.workers.length];
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => { this.stats.calls++; this.stats.docs += packed.numDocs; this.stats.ms += performance.now() - t0; resolve(r); },
        reject,
      });
      w.postMessage({
        id, meta: packed.meta, text: packed.text, qmeta: q.meta, qtext: q.text,
        numDocs: packed.numDocs, numFields: NUM_FIELDS, numTokens, weights: FIELD_WEIGHTS,
      }, [packed.meta.buffer, packed.text.buffer]);
    });
  }
}

/* ------------------------------------------------------------------ */
/* GPU Persian fold (import normalization)                             */
/* ------------------------------------------------------------------ */

function foldOnDevice(dev, strings) {
  return withErrorScopes(dev, async () => {
    const { device, foldPipeline } = dev;
    const t0 = performance.now();
    const packed = packStrings(strings, 4096);
    const n = Math.max(1, packed.text.length);
    const bufs = [];
    try {
      const inBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      bufs.push(inBuf);
      new Uint32Array(inBuf.getMappedRange()).set(packed.text);
      inBuf.unmap();
      const outBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      bufs.push(outBuf, readBuf);

      const bind = device.createBindGroup({
        layout: foldPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(foldPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(n / 256));
      pass.end();
      encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 4);
      device.queue.submit([encoder.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const units = new Uint32Array(readBuf.getMappedRange()).slice();
      readBuf.unmap();

      const out = new Array(strings.length);
      for (let s = 0; s < strings.length; s++) {
        const start = packed.meta[s * 2];
        const len = packed.meta[s * 2 + 1];
        // Long strings were truncated for the GPU; keep the untouched tail.
        let head = String.fromCharCode.apply(null, units.subarray(start, start + len));
        if (head.indexOf('\uFFFF') !== -1) head = head.replace(/\uFFFF/g, ''); // dropped tatweel
        const src = String(strings[s] == null ? '' : strings[s]);
        out[s] = src.length > len ? head + src.slice(len) : head;
      }
      dev.stats.foldCalls++;
      dev.stats.foldUnits += n;
      dev.stats.foldMs += performance.now() - t0;
      return out;
    } finally {
      for (const b of bufs) { try { b.destroy(); } catch { /* already gone */ } }
    }
  });
}

/* ------------------------------------------------------------------ */
/* CPU fallbacks (same semantics as the WGSL kernels)                  */
/* ------------------------------------------------------------------ */

/** Per-doc scores/masks in input order (the shape the GPU/worker paths return). */
function cpuRankArrays(candidates, tokens) {
  const scores = new Uint32Array(candidates.length);
  const masks = new Uint32Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const fields = docFieldStrings(candidates[i]);
    let score = 0;
    let mask = 0;
    for (let f = 0; f < NUM_FIELDS; f++) {
      const val = fields[f];
      if (!val) continue;
      const w = FIELD_WEIGHTS[f];
      for (const t of tokens) {
        if (!t) continue;
        if (val === t) { score += w * 10; mask |= (1 << f); }
        else if (val.includes(t)) { score += w; mask |= (1 << f); }
      }
    }
    scores[i] = score;
    masks[i] = mask;
  }
  return { scores, masks };
}

function cpuRank(candidates, tokens, topK = 50) {
  const { scores, masks } = cpuRankArrays(candidates, tokens);
  const scored = candidates.map((doc, i) => ({ doc, score: scores[i], mask: masks[i] }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

function cpuFold(strings) {
  return strings.map((s) => {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c === 0x064a) out += 'ی';
      else if (c === 0x0643) out += 'ک';
      else if (c === 0x0640) continue; // tatweel dropped (same as main-process normalizePersianChars)
      else if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(0x30 + (c - 0x0660));
      else if (c >= 0x06f0 && c <= 0x06f9) out += String.fromCharCode(0x30 + (c - 0x06f0));
      else out += ch;
    }
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** tokensFor(query): mirror main-process classifyQuery output. */
function tokensFor(query) {
  return query.type === 'name' ? query.tokens : [query.value];
}

/**
 * Rank candidates. Device policy:
 *   GPUs present  -> shard across all local GPU devices (weighted)
 *   no GPU, big   -> shard across the CPU worker pool
 *   no GPU, small -> main-thread JS
 * Returns { results: [{doc, score, mask}], device: 'gpu'|'cpu-pool'|'cpu', shards: [...] }
 */
async function rank(candidates, query, topK = 50) {
  const tokens = tokensFor(query).filter(Boolean);
  if (!tokens.length || !candidates.length) return { results: [], device: 'none', shards: [] };
  const numDocs = candidates.length;

  // Each shard runs on its unit; a shard whose unit fails (GPU validation
  // error, lost device, dead worker) is recomputed on the main thread so the
  // other units' work is kept. Resolves { results, device, shards }.
  const runSharded = async (units, deviceLabel, exec) => {
    const plan = shardByWeight(numDocs, units, MIN_SHARD_DOCS);
    const q = packStrings(tokens, MAX_FIELD_UNITS);
    let fellBack = 0;
    const parts = await Promise.all(plan.map(async (sh) => {
      const slice = candidates.slice(sh.start, sh.end);
      try {
        return await exec(sh.unit, packDocs(slice), q);
      } catch (err) {
        fellBack++;
        sh.fallback = true;
        console.warn(`[rank] ${sh.unit.id} failed (${err && err.message}); recomputing ${slice.length} docs on the main thread`);
        return cpuRankArrays(slice, tokens);
      }
    }));
    const scored = new Array(numDocs);
    for (let i = 0; i < plan.length; i++) {
      const { start } = plan[i];
      const { scores, masks } = parts[i];
      for (let j = 0; j < scores.length; j++) scored[start + j] = { doc: candidates[start + j], score: scores[j], mask: masks[j] };
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      results: scored.filter((s) => s.score > 0).slice(0, topK),
      device: fellBack === plan.length ? 'cpu' : fellBack ? `${deviceLabel}+cpu` : deviceLabel,
      shards: plan.map((sh) => ({ unit: sh.fallback ? `${sh.unit.id}->main-thread` : sh.unit.id, docs: sh.end - sh.start })),
    };
  };

  if (gpuDevices.length) {
    return runSharded(gpuDevices, 'gpu', (dev, packed, q) => rankPackedOnDevice(dev, packed, q, tokens.length));
  }
  if (cpuPool && numDocs >= CPU_POOL_MIN_DOCS) {
    const n = Math.min(cpuPool.size, Math.ceil(numDocs / MIN_SHARD_DOCS));
    const units = Array.from({ length: n }, (_, i) => ({ id: `cpu${i}`, weight: 1 }));
    return runSharded(units, 'cpu-pool', (unit, packed, q) => cpuPool.rank(packed, q, tokens.length));
  }
  return { results: cpuRank(candidates, tokens, topK), device: 'cpu', shards: [{ unit: 'main-thread', docs: numDocs }] };
}

/** Fold a batch of strings: sharded across local GPU devices, else CPU (per-shard fallback). */
async function normalizeBatch(strings) {
  if (gpuDevices.length) {
    const plan = shardByWeight(strings.length, gpuDevices, FOLD_SHARD_MIN);
    let fellBack = 0;
    const parts = await Promise.all(plan.map(async (sh) => {
      const slice = strings.slice(sh.start, sh.end);
      try {
        return await foldOnDevice(sh.unit, slice);
      } catch (err) {
        fellBack++;
        sh.fallback = true;
        console.warn(`[fold] ${sh.unit.id} failed (${err && err.message}); folding ${slice.length} strings on the CPU`);
        return cpuFold(slice);
      }
    }));
    const out = plan.length === 1 ? parts[0] : [].concat(...parts);
    return {
      strings: out,
      device: fellBack === plan.length ? 'cpu' : fellBack ? 'gpu+cpu' : 'gpu',
      shards: plan.map((sh) => ({ unit: sh.fallback ? `${sh.unit.id}->cpu` : sh.unit.id, items: sh.end - sh.start })),
    };
  }
  return { strings: cpuFold(strings), device: 'cpu', shards: [{ unit: 'main-thread', items: strings.length }] };
}

function adapterInfo() {
  return gpuDevices.length ? gpuDevices[0].info : null;
}

function state() {
  if (gpuState) {
    refreshStateDevices();
    gpuState.cpuPoolStats = cpuPool ? { ...cpuPool.stats } : null;
  }
  return gpuState;
}

window.GpuRank = { initGpu, gpuAvailable, adapterInfo, state, rank, normalizeBatch, cpuRank, cpuFold, classifyAdapter };
