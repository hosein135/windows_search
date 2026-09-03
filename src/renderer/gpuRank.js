'use strict';

/**
 * GPU ranking + GPU text normalization via WebGPU compute shaders (WGSL).
 *
 * The Mongo query narrows candidates with indexes; this module scores those
 * candidates ON THE GPU (one work-item per document) and, when enabled,
 * folds Persian characters for import batches on the GPU too.
 *
 * Everything degrades to a CPU implementation when WebGPU is unavailable,
 * mirroring the bootstrap script's "runtime detection, never hardcoded" rule.
 */

const FIELD_WEIGHTS = [3, 100, 80, 80]; // searchName, nationalCode, mobile, card
const MAX_FIELD_UNITS = 256;
const NUM_FIELDS = 4;

/* ------------------------------------------------------------------ */
/* WGSL kernels                                                        */
/* ------------------------------------------------------------------ */

const RANK_WGSL = /* wgsl */`
struct Params { numDocs: u32, numTokens: u32, numFields: u32, pad: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> meta: array<u32>;   // per doc-field: [start, len]
@group(0) @binding(2) var<storage, read> text: array<u32>;   // doc code units
@group(0) @binding(3) var<storage, read> qmeta: array<u32>;  // per token: [start, len]
@group(0) @binding(4) var<storage, read> qtext: array<u32>;  // token code units
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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let doc = gid.x;
  if (doc >= params.numDocs) { return; }
  var score = 0u;
  var mask = 0u;
  for (var f = 0u; f < params.numFields; f = f + 1u) {
    let mbase = (doc * params.numFields + f) * 2u;
    let fs = meta[mbase];
    let fl = meta[mbase + 1u];
    if (fl == 0u) { continue; }
    let w = fieldWeight(f);
    for (var t = 0u; t < params.numTokens; t = t + 1u) {
      let ts = qmeta[t * 2u];
      let tl = qmeta[t * 2u + 1u];
      if (tl == 0u || tl > fl) { continue; }
      if (tl == fl) {
        var eq = true;
        for (var k = 0u; k < fl; k = k + 1u) {
          if (text[fs + k] != qtext[ts + k]) { eq = false; break; }
        }
        if (eq) { score = score + w * 10u; mask = mask | (1u << f); continue; }
      }
      for (var i = 0u; i + tl <= fl; i = i + 1u) {
        var hit = true;
        for (var k = 0u; k < tl; k = k + 1u) {
          if (text[fs + i + k] != qtext[ts + k]) { hit = false; break; }
        }
        if (hit) { score = score + w; mask = mask | (1u << f); break; }
      }
    }
  }
  outScore[doc] = score;
  outMask[doc] = mask;
}
`;

const FOLD_WGSL = /* wgsl */`
// Persian/Arabic fold on the GPU: ي->ی  ك->ک  tatweel->space
// Arabic-Indic + Persian digits -> ASCII. One work-item per code unit.
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp)) { return; }
  var c = inp[i];
  if (c == 0x064Au) { c = 0x06CCu; }        // ي -> ی
  else if (c == 0x0643u) { c = 0x06A9u; }   // ك -> ک
  else if (c == 0x0640u) { c = 0x20u; }     // tatweel -> space (collapsed later)
  else if (c >= 0x0660u && c <= 0x0669u) { c = 0x30u + (c - 0x0660u); }
  else if (c >= 0x06F0u && c <= 0x06F9u) { c = 0x30u + (c - 0x06F0u); }
  outp[i] = c;
}
`;

/* ------------------------------------------------------------------ */
/* Device management                                                   */
/* ------------------------------------------------------------------ */

let gpuState = null; // { device, adapterInfo, rankPipeline, foldPipeline }

async function initGpu() {
  if (gpuState) return gpuState;
  if (!('gpu' in navigator) || !navigator.gpu) {
    gpuState = { device: null, reason: 'WebGPU API not exposed in this runtime' };
    return gpuState;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      gpuState = { device: null, reason: 'No WebGPU adapter (no compatible GPU/driver)' };
      return gpuState;
    }
    const device = await adapter.requestDevice();
    let adapterInfo = {};
    try {
      if (adapter.info) {
        adapterInfo = {
          vendor: adapter.info.vendor, architecture: adapter.info.architecture,
          device: adapter.info.device, description: adapter.info.description,
        };
      }
    } catch { /* info optional */ }
    const rankPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: RANK_WGSL }), entryPoint: 'main' },
    });
    const foldPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: FOLD_WGSL }), entryPoint: 'main' },
    });
    gpuState = { device, adapterInfo, rankPipeline, foldPipeline };
  } catch (err) {
    gpuState = { device: null, reason: String(err && err.message || err) };
  }
  return gpuState;
}

function gpuAvailable() {
  return !!(gpuState && gpuState.device);
}

/* ------------------------------------------------------------------ */
/* Packing helpers                                                     */
/* ------------------------------------------------------------------ */

function toUnits(s, maxLen) {
  const out = [];
  const str = String(s == null ? '' : s);
  const n = Math.min(str.length, maxLen);
  for (let i = 0; i < n; i++) out.push(str.charCodeAt(i));
  return out;
}

function packStrings(list, maxLen) {
  const meta = new Uint32Array(list.length * 2);
  const units = [];
  for (let i = 0; i < list.length; i++) {
    const u = toUnits(list[i], maxLen);
    meta[i * 2] = units.length;
    meta[i * 2 + 1] = u.length;
    for (const c of u) units.push(c);
  }
  return { meta, text: new Uint32Array(units.length ? units : [0]) };
}

function docFieldStrings(doc) {
  return [
    doc.searchName || '',
    doc.nationalCode || '',
    (doc.mobiles && doc.mobiles[0]) || '',
    (doc.cards && doc.cards[0]) || '',
  ];
}

/* ------------------------------------------------------------------ */
/* GPU ranking                                                         */
/* ------------------------------------------------------------------ */

async function rankOnGpu(candidates, tokens, topK) {
  const { device, rankPipeline } = gpuState;
  const numDocs = candidates.length;
  if (!numDocs) return [];

  // meta: per doc, NUM_FIELDS (start,len) pairs
  const metaArr = new Uint32Array(numDocs * NUM_FIELDS * 2);
  const textUnits = [];
  for (let d = 0; d < numDocs; d++) {
    const fields = docFieldStrings(candidates[d]);
    for (let f = 0; f < NUM_FIELDS; f++) {
      const u = toUnits(fields[f], MAX_FIELD_UNITS);
      const base = (d * NUM_FIELDS + f) * 2;
      metaArr[base] = textUnits.length;
      metaArr[base + 1] = u.length;
      for (const c of u) textUnits.push(c);
    }
  }
  const textArr = new Uint32Array(textUnits.length ? textUnits : [0]);
  const q = packStrings(tokens, MAX_FIELD_UNITS);

  const mk = (arr, usage) => {
    const b = device.createBuffer({ size: Math.max(4, arr.byteLength), usage, mappedAtCreation: true });
    new Uint32Array(b.getMappedRange()).set(arr);
    b.unmap();
    return b;
  };
  const USAGE = GPUBufferUsage;
  const paramsBuf = device.createBuffer({ size: 16, usage: USAGE.UNIFORM, mappedAtCreation: true });
  new Uint32Array(paramsBuf.getMappedRange()).set([numDocs, tokens.length, NUM_FIELDS, 0]);
  paramsBuf.unmap();

  const metaBuf = mk(metaArr, USAGE.STORAGE);
  const textBuf = mk(textArr, USAGE.STORAGE);
  const qmetaBuf = mk(q.meta, USAGE.STORAGE);
  const qtextBuf = mk(q.text, USAGE.STORAGE);
  const scoreBuf = device.createBuffer({ size: numDocs * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
  const maskBuf = device.createBuffer({ size: numDocs * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
  const scoreRead = device.createBuffer({ size: numDocs * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
  const maskRead = device.createBuffer({ size: numDocs * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });

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
  for (const b of [paramsBuf, metaBuf, textBuf, qmetaBuf, qtextBuf, scoreBuf, maskBuf, scoreRead, maskRead]) {
    b.destroy();
  }

  const scored = candidates.map((doc, i) => ({ doc, score: scores[i], mask: masks[i] }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

/* ------------------------------------------------------------------ */
/* GPU Persian fold (import normalization)                             */
/* ------------------------------------------------------------------ */

async function foldOnGpu(strings) {
  const { device, foldPipeline } = gpuState;
  const packed = packStrings(strings, 4096);
  const n = packed.text.length;

  const inBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
  new Uint32Array(inBuf.getMappedRange()).set(packed.text);
  inBuf.unmap();
  const outBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

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
  for (const b of [inBuf, outBuf, readBuf]) b.destroy();

  const out = [];
  for (let s = 0; s < strings.length; s++) {
    const start = packed.meta[s * 2];
    const len = packed.meta[s * 2 + 1];
    let str = '';
    for (let i = 0; i < len; i++) str += String.fromCharCode(units[start + i]);
    out.push(str);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CPU fallbacks (same semantics as the WGSL kernels)                  */
/* ------------------------------------------------------------------ */

function cpuRank(candidates, tokens, topK = 50) {
  const scored = candidates.map((doc) => {
    const fields = docFieldStrings(doc);
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
    return { doc, score, mask };
  });
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
      else if (c === 0x0640) out += ' ';
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

async function rank(candidates, query, topK = 50) {
  const tokens = tokensFor(query).filter(Boolean);
  if (!tokens.length) return { results: [], device: 'none' };
  if (gpuAvailable()) {
    try {
      const results = await rankOnGpu(candidates, tokens, topK);
      return { results, device: 'gpu' };
    } catch (err) {
      console.warn('GPU rank failed, falling back to CPU:', err);
    }
  }
  return { results: cpuRank(candidates, tokens, topK), device: 'cpu' };
}

async function normalizeBatch(strings) {
  if (gpuAvailable()) {
    try { return { strings: await foldOnGpu(strings), device: 'gpu' }; }
    catch (err) { console.warn('GPU fold failed, falling back to CPU:', err); }
  }
  return { strings: cpuFold(strings), device: 'cpu' };
}

function adapterInfo() { return (gpuState && gpuState.adapterInfo) || null; }
function state() { return gpuState; }

window.GpuRank = { initGpu, gpuAvailable, adapterInfo, state, rank, normalizeBatch, cpuRank, cpuFold };
