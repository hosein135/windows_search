'use strict';

/**
 * GpuPool - every compute endpoint the main process can reach, and a
 * weighted sharder over them.
 *
 * Why a pool: Chromium exposes exactly ONE GPU adapter per process to WebGPU
 * (crbug.com/329211593; powerPreference is ignored on Windows,
 * crbug.com/369219127). So "use every GPU" cannot be done inside one renderer.
 * Instead each GPU gets its own process, and the CPU worker pool in the main
 * window is a first-class endpoint that runs at the same time:
 *
 *   endpoint 'renderer'   the main window - Chromium bound to the
 *                         high-performance adapter via --force-high-performance-gpu
 *   endpoint 'helper-N'   a hidden helper Electron process pinned to another
 *                         DXGI adapter with --use-adapter-luid (gpuHelpers.js)
 *   endpoint 'cpu'        Web Workers in the main window (same rank/fold
 *                         algorithms as the WGSL kernels)
 *
 * All GPU endpoints run the same WGSL kernels (renderer/gpuRank.js). Requests
 * are split across endpoints in proportion to their weight; the weight
 * starts from the adapter class (discrete > integrated > cpu > software) and
 * is then re-tuned at runtime from measured throughput, so a slow iGPU never
 * drags a fast dGPU. A failing endpoint only costs its own shard (redone on
 * the CPU here); with no active endpoint the caller uses the CPU path
 * (runtime detection, never hardcoded).
 */

const { EventEmitter } = require('events');
const { normalizePersianChars, normalizeDigits } = require('./normalize');
const { cpuRank } = require('./search');

const BASE_WEIGHT = { discrete: 4, integrated: 1, unknown: 2, software: 0.25, cpu: 1 };
// CPU twin of the GPU fold kernel (used for a failed shard).
const cpuFoldOne = (s) => (typeof s === 'string' ? normalizeDigits(normalizePersianChars(s)) : s);
const MIN_SHARD = 256;          // don't split tiny fold batches
const RANK_MIN_SHARD = 64;     // search candidate sets are smaller than import batches
const CALIBRATION_CALLS = 3;    // measured throughput takes over after this many calls

/** Weight for the whole CPU pool vs a discrete GPU (4). Caps so GPUs stay primary. */
function cpuComputeWeight(workers) {
  const n = Math.max(1, Number(workers) || 1);
  return Math.round(Math.min(3, Math.max(1, n * 0.15)) * 100) / 100;
}

/** Classify a WebGPU adapter.info blob into discrete / integrated / software / unknown. */
function classifyAdapter(info) {
  if (!info) return 'none';
  if (info.isFallbackAdapter || /swiftshader|warp|llvmpipe|software/i.test(`${info.architecture} ${info.description} ${info.device}`)) {
    return 'software';
  }
  const v = String(info.vendor || '').toLowerCase();
  const arch = String(info.architecture || '').toLowerCase();
  const desc = String(info.description || '').toLowerCase();
  if (v === 'nvidia') return 'discrete';
  if (v === 'intel') return /arc|dg2|battlemage|xe-hpg|xe2-hpg|alchemist/.test(`${arch} ${desc}`) ? 'discrete' : 'integrated';
  if (v === 'amd') return /igpu|apu|vega-igpu|gfx90c|gfx1035|gfx1036|gfx1103|raphael|phoenix|rembrandt|renoir|cezanne/.test(`${arch} ${desc}`) ? 'integrated' : 'discrete';
  if (v === 'apple' || v === 'qualcomm' || v === 'arm') return 'integrated';
  return 'unknown';
}

/** Stable identity for "is this the same physical adapter?" comparisons. */
function adapterKey(info) {
  if (!info) return null;
  return [info.vendor, info.architecture, info.device, info.description].map((x) => String(x || '')).join('|');
}

class GpuPool extends EventEmitter {
  constructor() {
    super();
    this.endpoints = new Map(); // id -> endpoint
    this.allowSoftware = false;
  }

  /**
   * Register an endpoint.
   * ep: { id, kind: 'renderer'|'helper'|'cpu', label, adapter (info or null), send: (op, payload) => Promise, meta }
   * Returns the stored endpoint record (status 'active' | 'skipped' | 'no-gpu').
   */
  register(ep) {
    if (ep.kind === 'cpu') {
      const workers = (ep.meta && ep.meta.cpuWorkers) || 1;
      const w = cpuComputeWeight(workers);
      const rec = {
        id: ep.id,
        kind: 'cpu',
        label: ep.label || `CPU (${workers} workers)`,
        adapter: ep.adapter || {
          vendor: 'cpu', architecture: `${workers} workers`, device: '', description: 'CPU worker pool',
        },
        adapterClass: 'cpu',
        adapterKey: 'cpu',
        baseWeight: w,
        weight: w,
        status: 'active',
        reason: null,
        meta: ep.meta || {},
        send: ep.send,
        stats: { calls: 0, items: 0, ms: 0, failures: 0 },
        registeredAt: Date.now(),
      };
      this.endpoints.set(rec.id, rec);
      this.emit('change', this.plan());
      return rec;
    }

    const cls = classifyAdapter(ep.adapter);
    const key = adapterKey(ep.adapter);
    const rec = {
      id: ep.id,
      kind: ep.kind,
      label: ep.label || ep.id,
      adapter: ep.adapter || null,
      adapterClass: cls,
      adapterKey: key,
      baseWeight: BASE_WEIGHT[cls] || 0,
      weight: BASE_WEIGHT[cls] || 0,
      status: 'active',
      reason: null,
      meta: ep.meta || {},
      send: ep.send,
      stats: { calls: 0, items: 0, ms: 0, failures: 0 },
      registeredAt: Date.now(),
    };
    if (!ep.adapter) {
      rec.status = 'no-gpu';
      rec.reason = (ep.meta && ep.meta.reason) || 'no WebGPU adapter in this process';
    } else if (cls === 'software' && !this.allowSoftware) {
      rec.status = 'skipped';
      rec.reason = 'software adapter (SwiftShader/WARP) - slower than the CPU fold; enable with --gpu-allow-software';
    } else {
      const dup = [...this.endpoints.values()].find((e) => e.status === 'active' && e.adapterKey === key);
      if (dup && ep.kind === 'renderer' && dup.kind === 'helper') {
        // The main window always keeps its GPU; a helper that happened to report
        // first on the same adapter is the redundant one - demote it and let the
        // HelperManager (listening on 'demoted') shut the process down.
        dup.status = 'skipped';
        dup.reason = `same adapter as ${rec.label} - Chromium bound both processes to one DXGI adapter`;
        this.emit('demoted', dup);
      } else if (dup) {
        rec.status = 'skipped';
        rec.reason = `same adapter as ${dup.label} - Chromium bound both processes to one DXGI adapter`;
      }
    }
    this.endpoints.set(rec.id, rec);
    this.emit('change', this.plan());
    return rec;
  }

  unregister(id) {
    if (this.endpoints.delete(id)) this.emit('change', this.plan());
  }

  get(id) { return this.endpoints.get(id) || null; }

  active() {
    return [...this.endpoints.values()].filter((e) => e.status === 'active' && typeof e.send === 'function');
  }

  hasGpu() { return this.active().some((e) => e.kind !== 'cpu'); }

  hasCompute() { return this.active().length > 0; }

  /** Split `n` items over the active endpoints by weight. Returns [{ ep, start, end }]. */
  shardPlan(n, { minShard = MIN_SHARD } = {}) {
    const eps = this.active();
    if (!eps.length) return [];
    if (n < minShard * 2 || eps.length === 1) return [{ ep: eps[0], start: 0, end: n }];
    const total = eps.reduce((a, e) => a + Math.max(0.05, e.weight), 0);
    const plan = [];
    let cursor = 0;
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      const share = i === eps.length - 1 ? n - cursor : Math.floor((n * Math.max(0.05, ep.weight)) / total);
      if (share <= 0) continue;
      plan.push({ ep, start: cursor, end: cursor + share });
      cursor += share;
    }
    if (plan.length && cursor < n) plan[plan.length - 1].end = n;
    return plan;
  }

  async _call(ep, op, payload, count) {
    const t0 = process.hrtime.bigint();
    try {
      const out = await ep.send(op, payload);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      ep.stats.calls++;
      ep.stats.items += count;
      ep.stats.ms += ms;
      this._retune();
      return out;
    } catch (err) {
      ep.stats.failures++;
      if (ep.stats.failures >= 3 && ep.stats.calls === 0) {
        ep.status = 'skipped';
        ep.reason = `disabled after repeated failures: ${err && err.message}`;
        this.emit('change', this.plan());
      }
      throw err;
    }
  }

  /** After calibration, weight = measured items/ms so shards finish together. */
  _retune() {
    const eps = this.active().filter((e) => e.stats.calls >= CALIBRATION_CALLS && e.stats.ms > 0);
    if (eps.length < 2) return;
    for (const e of eps) e.weight = Math.max(0.05, e.stats.items / e.stats.ms);
  }

  /**
   * Fold strings across every active endpoint (GPU processes + CPU workers).
   * Resolves to the folded strings in input order, or null when nothing is
   * registered. A shard whose endpoint fails is folded on the CPU here (same
   * normalizer the importer applies afterwards) so the other endpoints' work
   * is kept.
   */
  async fold(strings) {
    if (!Array.isArray(strings) || !strings.length) return strings || null;
    const plan = this.shardPlan(strings.length, { minShard: MIN_SHARD });
    if (!plan.length) return null;
    const parts = await Promise.all(plan.map(async ({ ep, start, end }) => {
      const slice = strings.slice(start, end);
      try {
        const part = await this._call(ep, 'fold', { strings: slice }, end - start);
        if (!Array.isArray(part) || part.length !== slice.length) throw new Error('malformed fold response');
        return part;
      } catch {
        return slice.map(cpuFoldOne);
      }
    }));
    if (plan.length === 1) return parts[0];
    const out = new Array(strings.length);
    for (let i = 0; i < plan.length; i++) {
      const part = parts[i];
      const { start } = plan[i];
      for (let j = 0; j < part.length; j++) out[start + j] = part[j];
    }
    return out;
  }

  /**
   * Rank search candidates across every active endpoint. Each shard returns
   * its local topK; the union is re-sorted so the global topK is exact.
   * Resolves { results, device, shards }.
   */
  async rank(candidates, query, topK = 50) {
    if (!Array.isArray(candidates) || !candidates.length) {
      return { results: [], device: 'none', shards: [] };
    }
    const plan = this.shardPlan(candidates.length, { minShard: RANK_MIN_SHARD });
    if (!plan.length) {
      return {
        results: cpuRank(candidates, query, topK),
        device: 'cpu',
        shards: [{ unit: 'main-thread', docs: candidates.length }],
      };
    }
    const kinds = new Set();
    const parts = await Promise.all(plan.map(async (sh) => {
      const slice = candidates.slice(sh.start, sh.end);
      try {
        const out = await this._call(sh.ep, 'rank', { candidates: slice, query, topK }, sh.end - sh.start);
        const results = Array.isArray(out) ? out : (out && out.results);
        if (!Array.isArray(results)) throw new Error('malformed rank response');
        kinds.add(sh.ep.kind === 'cpu' ? 'cpu' : 'gpu');
        return { results, fallback: false };
      } catch {
        kinds.add('cpu');
        return { results: cpuRank(slice, query, topK), fallback: true };
      }
    }));
    const merged = [];
    for (const p of parts) merged.push(...p.results);
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
    const fellBack = parts.filter((p) => p.fallback).length;
    const device = fellBack === plan.length
      ? 'cpu'
      : (kinds.has('gpu') && kinds.has('cpu') ? 'gpu+cpu' : kinds.has('gpu') ? 'gpu' : 'cpu');
    return {
      results: merged.filter((s) => s && s.score > 0).slice(0, topK),
      device,
      shards: plan.map((sh, i) => ({
        unit: parts[i].fallback ? `${sh.ep.id}->cpu` : sh.ep.id,
        docs: sh.end - sh.start,
      })),
    };
  }

  /** Human/GUI-facing plan: who is active, who is skipped and why, live stats. */
  plan() {
    const list = [...this.endpoints.values()].map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      status: e.status,
      reason: e.reason,
      adapter: e.adapter,
      adapterClass: e.adapterClass,
      weight: Math.round(e.weight * 100) / 100,
      baseWeight: e.baseWeight,
      meta: e.meta,
      stats: {
        calls: e.stats.calls,
        items: e.stats.items,
        failures: e.stats.failures,
        itemsPerMs: e.stats.ms > 0 ? Math.round((e.stats.items / e.stats.ms) * 10) / 10 : null,
      },
    }));
    const active = list.filter((e) => e.status === 'active');
    const gpuN = active.filter((e) => e.kind !== 'cpu').length;
    const cpuOn = active.some((e) => e.kind === 'cpu');
    let sharding = 'none (CPU fold in caller)';
    if (gpuN && cpuOn) sharding = 'weighted across GPU processes + CPU workers (self-tuning)';
    else if (gpuN > 1) sharding = 'weighted across GPU processes (self-tuning)';
    else if (gpuN === 1) sharding = 'single GPU';
    else if (cpuOn) sharding = 'CPU workers';
    return {
      endpoints: list,
      activeCount: active.length,
      gpuCount: gpuN,
      cpuActive: cpuOn,
      sharding,
      allowSoftware: this.allowSoftware,
    };
  }
}

module.exports = { GpuPool, classifyAdapter, adapterKey, BASE_WEIGHT, cpuComputeWeight, MIN_SHARD, RANK_MIN_SHARD };
