'use strict';

/* Renderer app logic: search (GPU-ranked), import control, hardware + compute plan view. */

(function () {
  const $ = (sel) => document.querySelector(sel);

  /* ----------------------------- tabs ----------------------------- */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-page').forEach((p) =>
        p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    });
  });

  /* --------------------------- hardware --------------------------- */
  const KIND_CLASS = { nvidia: 'hw-nvidia', intel: 'hw-intel', amd: 'hw-amd', other: 'hw-other' };
  const VENDOR_BADGE = { nvidia: 'badge-nvidia', intel: 'badge-intel', amd: 'badge-amd' };
  let hwCache = null;
  let lastPlan = null;

  async function renderHardware(force) {
    const hw = await window.api.getHardware({ force: !!force });
    hwCache = hw;

    $('#hw-cpu').innerHTML = `
      <h4>CPU</h4>
      <div class="hw-line"><b>${esc(hw.cpu.name)}</b></div>
      <div class="hw-line muted">${esc(hw.cpu.class)} (${esc(hw.cpu.vendor)}) - ${hw.cpu.cores ? `${hw.cpu.cores} cores / ` : ''}${hw.cpu.threads || '?'} threads${hw.memoryGB ? ` - ${hw.memoryGB} GB RAM` : ''}</div>
      <div class="hw-line muted">Import plan: ${hw.plan.importWorkers} worker thread(s) x ${hw.plan.inflightWritesPerWorker} in-flight bulkWrites = ${hw.plan.concurrentBulkWrites} concurrent writes; ${esc(hw.plan.chunking)}</div>`;

    const gpuHtml = hw.gpus.length
      ? hw.gpus.map((g) => `
          <div class="hw-line ${KIND_CLASS[g.kind] || 'hw-other'}">
            [${esc(g.label)}] ${esc(g.name)}${g.vramMB ? ` - ~${g.vramMB} MB VRAM` : ''}${g.driver ? ` <small class="muted">driver ${esc(g.driver)}</small>` : ''}
          </div>`).join('')
      : '<div class="hw-line hw-other">(no adapters reported by Win32_VideoController)</div>';
    const smi = hw.nvidiaSmi && hw.nvidiaSmi.available
      ? `<div class="hw-line hw-nvidia">nvidia-smi: ${hw.nvidiaSmi.gpus.map(esc).join(' | ')}</div>`
      : '<div class="hw-line muted">nvidia-smi: not available - CUDA path unavailable, WebGPU/CPU will be used</div>';
    const luids = hw.adapterLuids && hw.adapterLuids.length
      ? `<div class="hw-line muted">DXGI adapter LUIDs (perf counters): ${hw.adapterLuids.map(esc).join(', ')} - ${hw.plan.gpuProcesses} GPU process(es)</div>`
      : '<div class="hw-line muted">DXGI adapter LUIDs: unavailable (GPU perf counters missing) - helper GPUs cannot be pinned by LUID</div>';
    $('#hw-gpus').innerHTML = `<h4>Display adapters</h4>${gpuHtml}${smi}${luids}`;

    $('#hw-involvement').innerHTML = hw.involvement.map((i) => `
      <div class="inv-card">
        <span class="inv-role">${esc(i.role)}</span>
        <b>${esc(i.device)}</b><br /><span class="muted">${esc(i.detail)}</span>
      </div>`).join('');

    $('#chip-cpu').textContent = `CPU: ${(hw.cpu.name || 'unknown').replace(/\(R\)|\(TM\)/g, '').slice(0, 32)} (${hw.cpu.threads || '?'}t)`;

    // Default the import controls to the whole machine.
    const workersInput = $('#workers-count');
    if (!workersInput.dataset.touched) workersInput.value = hw.plan.importWorkers || 4;
    renderImportPlan();
    await renderComputePlan();
  }

  function adapterLine(a, extra) {
    if (!a) return `<span class="badge badge-warn">no WebGPU</span>${extra || ''}`;
    const vendor = String(a.vendor || '').toLowerCase();
    const badge = VENDOR_BADGE[vendor] || 'badge-muted';
    return `<span class="badge ${badge}">${esc(a.vendor || '?')}</span>`
      + `${esc(a.architecture || '')}${a.description ? ` - ${esc(a.description)}` : ''}${a.device ? ` (${esc(a.device)})` : ''}`
      + `${a.isFallbackAdapter ? ' <span class="badge badge-warn">software</span>' : ''}${extra || ''}`;
  }

  async function renderComputePlan(planFromEvent) {
    const local = window.GpuRank.state() || {};
    const plan = planFromEvent || await window.api.getGpuPlan();
    lastPlan = plan;
    const flags = plan.flags || {};
    const pool = plan.pool || { endpoints: [], activeCount: 0, sharding: 'none' };
    const helpers = plan.helpers;

    const rows = [];
    // 1. local GPU devices in THIS renderer
    if (local.devices && local.devices.length) {
      local.devices.forEach((d, i) => {
        const st = d.stats || {};
        rows.push(['GPU (this window)' + (local.devices.length > 1 ? ` #${i + 1}` : ''),
          adapterLine(d, ` <small>[${esc(d.kind)}, weight ${d.weight}, via ${esc(d.via)}]</small>`
            + `<br><small>ranks search results + folds import text; ${st.rankCalls || 0} rank call(s) / ${(st.rankDocs || 0).toLocaleString()} docs, `
            + `${st.foldCalls || 0} fold call(s)${d.maxStorageBindingMB ? `; max storage binding ${d.maxStorageBindingMB} MB` : ''}</small>`)]);
      });
    } else {
      rows.push(['GPU (this window)', `<span class="badge badge-warn">none</span> <small>${esc(local.reason || 'WebGPU unavailable')}</small>`]);
    }
    for (const r of local.rejected || []) {
      rows.push(['GPU adapter skipped', adapterLine(r, ` <small>${esc(r.reason)}</small>`)]);
    }
    // 2. helper GPU processes (other adapters)
    const helperEps = pool.endpoints.filter((e) => e.kind === 'helper');
    for (const e of helperEps) {
      const ok = e.status === 'active';
      rows.push([esc(e.label), adapterLine(e.adapter,
        ` <span class="badge ${ok ? 'badge-ok' : 'badge-warn'}">${esc(e.status)}</span>`
        + `<small>${e.meta && e.meta.luid ? `pinned --use-adapter-luid ${esc(e.meta.luid)}; ` : ''}`
        + `${ok ? `weight ${e.weight}; ${e.stats.calls} fold call(s), ${e.stats.items.toLocaleString()} strings` : esc(e.reason || '')}</small>`)]);
    }
    if (helpers) {
      for (const h of helpers.helpers || []) {
        if (helperEps.some((e) => e.id === h.id)) continue; // already shown via the pool
        rows.push([esc(h.id), `<span class="badge badge-muted">${esc(h.status)}</span> <small>${h.luid ? `LUID ${esc(h.luid)}; ` : ''}${esc(h.stopReason || (h.log && h.log.length ? h.log[h.log.length - 1] : ''))}</small>`]);
      }
      rows.push(['Helper decision', `<small>${esc((helpers.discovery && helpers.discovery.decision) || 'pending...')}</small>`]);
      const ch = helpers.discovery && helpers.discovery.chromium;
      if (ch && ch.devices && ch.devices.length) {
        rows.push(['Chromium GPU list', ch.devices.map((d) => `<small>${d.active ? '<b>active</b> ' : ''}${esc(d.vendor || `0x${(d.vendorId || 0).toString(16)}`)} ${esc(d.device || `0x${(d.deviceId || 0).toString(16)}`)} <span class="badge badge-muted">${esc(d.gpuPreference)}</span>${d.software ? ' <span class="badge badge-warn">software</span>' : ''}</small>`).join('<br>')
          + `${ch.optimus ? '<br><small>NVIDIA Optimus hybrid graphics detected</small>' : ''}${ch.amdSwitchable ? '<br><small>AMD switchable graphics detected</small>' : ''}`]);
      }
    }
    // 3. sharding + CPU
    rows.push(['GPU fold sharding', `<small>${esc(pool.sharding)} - ${pool.activeCount} active GPU process(es)</small>`]);
    rows.push(['CPU (this window)', `<small>${local.hardwareConcurrency || '?'} logical threads; ${local.cpuWorkers || 0} rank worker(s) `
      + `${local.devices && local.devices.length ? '(idle while a GPU ranks; take over on GPU failure)' : '(active ranker: sharded by document range for large candidate sets)'}`
      + `${local.cpuPoolStats ? `; ${local.cpuPoolStats.calls} call(s) / ${(local.cpuPoolStats.docs || 0).toLocaleString()} docs` : ''}</small>`]);
    rows.push(['CPU (import)', `<small>${hwCache ? `${hwCache.plan.importWorkers} worker threads (one per logical CPU), byte-range chunked files, direct MongoDB writes, ${hwCache.plan.inflightWritesPerWorker} in flight each` : '...'}</small>`]);
    rows.push(['Chromium switches', `<small>${flags.forceHighPerformanceGpu ? '--force-high-performance-gpu ' : ''}${flags.unsafe ? '--enable-unsafe-webgpu --ignore-gpu-blocklist ' : ''}${flags.allowSoftware ? '--enable-unsafe-swiftshader ' : ''}`
      + `${flags.helpersDisabled ? '--no-gpu-helpers ' : ''}${flags.helpersForced ? `--gpu-helpers=${flags.helpersForced}` : ''}</small>`]);
    if (local.notes && local.notes.length) rows.push(['Adapter probes', `<small>${local.notes.map(esc).join('<br>')}</small>`]);

    $('#hw-compute').innerHTML = rows.map(([k, v]) => `<div class="plan-row"><div class="plan-k">${k}</div><div class="plan-v">${v}</div></div>`).join('');
    renderGpuChip();
  }

  $('#btn-hw-refresh').addEventListener('click', () => renderHardware(true));
  window.api.onGpuPlanChange((plan) => { renderComputePlan(plan).catch(() => {}); });

  /* ------------------------- status chips -------------------------- */
  async function refreshStatus() {
    const st = await window.api.dbStatus();
    const chip = $('#chip-mongo');
    if (st.ok) {
      chip.textContent = `MongoDB: ${st.persons.toLocaleString()} persons`;
      chip.className = 'chip chip-ok';
    } else {
      chip.textContent = 'MongoDB: offline';
      chip.className = 'chip chip-bad';
      chip.title = st.error || '';
    }
  }

  function renderGpuChip() {
    const chip = $('#chip-gpu');
    const st = window.GpuRank.state() || {};
    const helpersActive = lastPlan && lastPlan.pool ? lastPlan.pool.endpoints.filter((e) => e.kind === 'helper' && e.status === 'active').length : 0;
    if (st.ok && st.devices.length) {
      const names = st.devices.map((d) => d.vendor || d.architecture || 'gpu');
      chip.textContent = `GPU: ${names.join(' + ')}${helpersActive ? ` + ${helpersActive} helper GPU` : ''}`;
      chip.className = 'chip chip-ok';
      chip.title = st.devices.map((d) => `${d.vendor} ${d.architecture} ${d.description || ''} [${d.kind}]`).join('\n')
        + (helpersActive ? `\n+${helpersActive} pinned helper process(es)` : '');
    } else {
      chip.textContent = `GPU: CPU fallback (${st.cpuWorkers || 0} workers)`;
      chip.className = 'chip chip-warn';
      chip.title = st.reason || 'WebGPU unavailable';
    }
  }

  /* ---------------------------- search ----------------------------- */
  const input = $('#search-input');
  let debounce = null;
  let searchSeq = 0;

  function classifyPreview(q) {
    const d = q.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
               .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
    if (/^\d{10}$/.test(d)) return 'national code';
    if (/^09\d{9}$/.test(d)) return 'mobile';
    if (/^\d{16}$/.test(d)) return 'card';
    if (/^\d{4,}$/.test(d)) return 'any id';
    if (d.trim()) return 'name';
    return '-';
  }

  const FIELD_BIT = { searchName: 1, nationalCode: 2, mobile: 4, card: 8 };
  const hl = (text, on) => `<span class="${on ? 'hit' : ''}" dir="auto">${esc(text)}</span>`;

  async function runSearch() {
    const q = input.value;
    $('#query-type').textContent = `type: ${classifyPreview(q)}`;
    if (!q.trim()) {
      $('#results-body').innerHTML = '';
      $('#search-meta').textContent = 'Enter a query. MongoDB narrows candidates, the GPU ranks them.';
      return;
    }
    const mySeq = ++searchSeq;
    const t0 = performance.now();
    const res = await window.api.search(q);
    if (mySeq !== searchSeq) return; // stale
    if (res.error) {
      $('#search-meta').textContent = res.error;
      $('#results-body').innerHTML = '';
      return;
    }
    const t1 = performance.now();
    const ranked = await window.GpuRank.rank(res.candidates, res.query, 50);
    const t2 = performance.now();

    const shards = ranked.shards && ranked.shards.length > 1
      ? ` across ${ranked.shards.length} shards (${ranked.shards.map((s) => `${s.unit}:${s.docs}`).join(', ')})`
      : '';
    $('#search-meta').textContent =
      `${res.candidates.length} candidates from MongoDB in ${res.tookMs.toFixed(0)} ms` +
      ` (query ${(t1 - t0).toFixed(0)} ms) - ranked on ${ranked.device.toUpperCase()}${shards} in ${(t2 - t1).toFixed(1)} ms` +
      `${res.capped ? ' - candidate cap reached, refine the query' : ''}` +
      ` - ${ranked.results.length} shown`;

    $('#results-body').innerHTML = ranked.results.map((r, i) => {
      const d = r.doc;
      const m = r.mask || 0;
      return `<tr>
        <td>${i + 1}</td>
        <td>${r.score}</td>
        <td>${hl(d.fullName || '', m & FIELD_BIT.searchName)}</td>
        <td>${hl(d.nationalCode || '', m & FIELD_BIT.nationalCode)}</td>
        <td>${hl((d.mobiles || []).join(', '), m & FIELD_BIT.mobile)}</td>
        <td>${hl((d.cards || []).join(', '), m & FIELD_BIT.card)}</td>
        <td dir="auto">${esc([d.city, d.province].filter(Boolean).join(' / '))}</td>
        <td dir="auto">${esc((d.addresses || [])[0] || '')}</td>
        <td class="muted">${esc((d.sources || []).join(', '))}</td>
      </tr>`;
    }).join('');
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);
  });

  /* ---------------------------- import ----------------------------- */
  let filesCache = [];

  function fmtSize(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
  }

  function importOptions() {
    const useParallel = $('#chk-parallel').checked;
    const workers = Math.max(1, Number($('#workers-count').value) || (hwCache ? hwCache.plan.importWorkers : 4));
    const inflight = Math.max(1, Number($('#inflight-count').value) || 2);
    return { parallel: useParallel, workers, inflight, gpuNormalize: $('#chk-gpu-normalize').checked };
  }

  function renderImportPlan() {
    const o = importOptions();
    const gpuEps = lastPlan && lastPlan.pool ? lastPlan.pool.activeCount : (window.GpuRank.gpuAvailable() ? 1 : 0);
    const threads = hwCache ? hwCache.cpu.threads : '?';
    $('#import-plan').textContent = o.parallel
      ? `Plan: ${o.workers} worker thread(s) of ${threads} logical CPUs, each parsing its own byte-range chunk and writing to MongoDB with ${o.inflight} bulkWrites in flight `
        + `(${o.workers * o.inflight} concurrent) - ${o.gpuNormalize ? (gpuEps ? `text folded on ${gpuEps} GPU process(es), sharded by weight` : 'GPU fold requested but no GPU endpoint - CPU fold') : 'CPU fold'}.`
      : `Plan: sequential - 1 thread, ${o.inflight} bulkWrites in flight, ${o.gpuNormalize && gpuEps ? `GPU fold on ${gpuEps} GPU process(es)` : 'CPU fold'}. Enable parallel import to use all ${threads} threads.`;
    $('#workers-label').style.display = o.parallel ? 'flex' : 'none';
  }

  async function scanFiles() {
    filesCache = await window.api.scanFiles();
    const known = filesCache.filter((f) => f.known);
    $('#import-summary').innerHTML =
      `${filesCache.length} CSV file(s) found, ${known.length} with a known layout - ` +
      `${fmtSize(filesCache.reduce((a, f) => a + f.sizeBytes, 0))} total.` +
      (known.length ? ' Use each file\'s Import button for file-by-file mode, or Import selected files for batch.' : '');
    $('#files-body').innerHTML = filesCache.map((f, i) => `
      <tr data-path="${esc(f.path)}">
        <td><input type="checkbox" class="file-chk" data-i="${i}" ${f.known ? 'checked' : 'disabled'} /></td>
        <td><button class="btn-import-one" data-i="${i}" ${f.known ? '' : 'disabled'}>Import</button></td>
        <td>${esc(f.folder)} / ${esc(f.name)}</td>
        <td>${esc(f.sourceLabel)}</td>
        <td>${fmtSize(f.sizeBytes)}</td>
        <td class="c-rows">-</td><td class="c-persons">-</td><td class="c-skipped">-</td>
        <td class="c-rate">-</td><td class="c-chunks">-</td><td class="c-state">pending</td>
      </tr>`).join('');
    $('#btn-import').disabled = !known.length;

    // Wire per-file import buttons
    document.querySelectorAll('.btn-import-one').forEach((btn) => {
      btn.addEventListener('click', () => importOneFile(Number(btn.dataset.i)));
    });
    renderImportPlan();
  }

  function updateFileRow(fileName, p) {
    const row = [...document.querySelectorAll('#files-body tr')]
      .find((tr) => tr.dataset.path.endsWith(fileName));
    if (!row) return;
    row.querySelector('.c-rows').textContent = p.rows != null ? p.rows.toLocaleString() : '-';
    row.querySelector('.c-persons').textContent = p.persons != null ? p.persons.toLocaleString() : '-';
    row.querySelector('.c-skipped').textContent = p.skipped != null ? p.skipped.toLocaleString() : '-';
    row.querySelector('.c-rate').textContent = p.rowsPerSec ? p.rowsPerSec.toLocaleString() : '-';
    if (p.chunks) row.querySelector('.c-chunks').textContent = `${p.chunksDone || 0}/${p.chunks}`;
    row.querySelector('.c-state').textContent = p.phase;
    if (p.bytesTotal) {
      const pct = Math.min(100, (100 * (p.bytes || 0)) / p.bytesTotal);
      row.querySelector('.c-state').textContent = `${p.phase} ${pct.toFixed(0)}%`;
    }
  }

  $('#btn-scan').addEventListener('click', scanFiles);

  function describeTotals(res, prefix) {
    const t = res.totals;
    const mode = res.mode === 'parallel'
      ? ` [parallel: ${t.workers} workers, ${t.tasksDone}/${t.tasks} chunk tasks, chunk ${fmtSize(t.chunkBytes || 0)}]`
      : ' [sequential]';
    return `${prefix} ${res.cancelled ? 'cancelled' : 'finished'}: ${t.persons.toLocaleString()} persons from ` +
      `${t.rows.toLocaleString()} rows (${t.skipped.toLocaleString()} empty rows skipped, ` +
      `${t.errors.toLocaleString()} errors)${mode}`;
  }

  $('#btn-import').addEventListener('click', async () => {
    const selected = [...document.querySelectorAll('.file-chk:checked')]
      .map((c) => filesCache[Number(c.dataset.i)].path);
    if (!selected.length) return;
    const opts = importOptions();
    $('#btn-import').disabled = true;
    $('#btn-cancel').disabled = false;
    // Disable all per-file buttons during batch import
    document.querySelectorAll('.btn-import-one').forEach((b) => { b.disabled = true; });
    const res = await window.api.startImport({ files: selected, ...opts });
    $('#btn-import').disabled = false;
    $('#btn-cancel').disabled = true;
    document.querySelectorAll('.btn-import-one').forEach((b) => { b.disabled = false; });
    if (res.error) $('#import-summary').textContent = res.error;
    else $('#import-summary').textContent = describeTotals(res, 'Import');
    refreshStatus();
    refreshStorage();
    renderComputePlan().catch(() => {});
  });

  for (const id of ['#chk-parallel', '#workers-count', '#inflight-count', '#chk-gpu-normalize']) {
    $(id).addEventListener('change', () => { if (id === '#workers-count') $(id).dataset.touched = '1'; renderImportPlan(); });
    $(id).addEventListener('input', renderImportPlan);
  }

  async function importOneFile(i) {
    const f = filesCache[i];
    if (!f || !f.known) return;
    const opts = importOptions();
    // Disable buttons during single-file import
    const btn = document.querySelector(`.btn-import-one[data-i="${i}"]`);
    if (btn) btn.disabled = true;
    $('#btn-import').disabled = true;
    $('#btn-cancel').disabled = false;
    const row = [...document.querySelectorAll('#files-body tr')]
      .find((tr) => tr.dataset.path === f.path);
    if (row) row.querySelector('.c-state').textContent = 'importing...';

    const res = await window.api.importFile({ file: f, ...opts });

    if (btn) btn.disabled = false;
    $('#btn-import').disabled = false;
    $('#btn-cancel').disabled = true;

    if (res.error) {
      if (row) row.querySelector('.c-state').textContent = `error: ${res.error}`;
    } else {
      const s = res.stats;
      if (row) {
        row.querySelector('.c-rows').textContent = s.rows.toLocaleString();
        row.querySelector('.c-persons').textContent = s.persons.toLocaleString();
        row.querySelector('.c-skipped').textContent = s.skipped.toLocaleString();
        row.querySelector('.c-state').textContent = res.cancelled ? 'cancelled' : 'done';
      }
      $('#import-summary').textContent =
        `${f.name}: ${s.persons.toLocaleString()} persons from ${s.rows.toLocaleString()} rows ` +
        `(${s.skipped.toLocaleString()} skipped, ${s.errors.toLocaleString()} errors)` +
        `${res.mode === 'parallel' ? ` [parallel: ${res.totals.workers} workers, ${res.totals.tasks} chunk(s)]` : ' [sequential]'}.`;
    }
    refreshStatus();
    refreshStorage();
  }

  $('#btn-cancel').addEventListener('click', () => window.api.cancelImport());

  /* ---------------------------- storage ---------------------------- */
  function renderMongoDirBlock(info) {
    const di = info.dirInfo || { exists: false, sizeMB: 0, entries: [], files: [], fileCount: 0 };
    const entries = di.entries && di.entries.length
      ? di.entries
      : (di.files || []).map((name) => ({ name, kind: name.endsWith('/') ? 'dir' : 'file', sizeMB: null }));
    const entryRows = entries.map((e) => {
      const label = e.kind === 'dir' ? `${e.name}/` : e.name;
      const size = (e.sizeMB != null) ? `${e.sizeMB} MB` : '-';
      return `<tr><td><code>${esc(label)}</code></td><td>${e.kind === 'dir' ? 'folder' : 'file'}</td><td>${size}</td></tr>`;
    }).join('');
    return `
      <div class="hw-block">
        <h4>Data directory (MongoDB storage files)</h4>
        <div class="hw-line">Path: <code>${esc(info.dataDir || di.path || '')}</code></div>
        <div class="hw-line">Exists: ${di.exists ? 'yes' : 'no (run setup.cmd / start mongod --dbpath mongo)'}</div>
        ${di.exists ? `<div class="hw-line">Total size on disk: <b>${di.sizeMB} MB</b> (${(di.fileCount || 0).toLocaleString()} file(s), recursive)</div>` : ''}
        ${di.exists && entryRows ? `
          <table class="results" style="margin-top:6px;max-height:180px;display:block;overflow:auto">
            <thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead>
            <tbody>${entryRows}</tbody>
          </table>` : ''}
      </div>`;
  }

  async function refreshStorage() {
    const el = $('#storage-content');
    el.innerHTML = 'Loading...';
    const info = await window.api.storageInfo();

    if (!info.ok) {
      el.innerHTML = `
        <div class="hw-block">
          <h4>Connection</h4>
          <div class="hw-line"><span class="chip chip-bad">MongoDB offline</span></div>
          <div class="hw-line muted">${esc(info.error || 'Cannot reach mongod')}</div>
          <div class="hw-line muted">Expected URL: <code>${esc(info.mongoUrl || 'mongodb://127.0.0.1:27017')}</code></div>
          <div class="hw-line muted">Start with: <code>mongod --dbpath mongo --port 27017 --bind_ip 127.0.0.1</code> (or re-run setup.cmd)</div>
        </div>
        ${renderMongoDirBlock(info)}`;
      return;
    }

    const idxRows = (info.indexes || []).map((ix) => `
      <tr>
        <td>${esc(ix.name)}</td>
        <td><code>${esc(ix.keys)}</code></td>
        <td>${ix.unique ? 'yes' : '-'}</td>
        <td>${ix.sparse ? 'yes' : '-'}</td>
      </tr>`).join('');

    const dbRows = (info.allDatabases || []).map((d) => `
      <tr>
        <td>${esc(d.name)}</td>
        <td>${d.sizeOnDisk ? fmtSize(d.sizeOnDisk) : '-'}</td>
        <td>${d.empty ? 'empty' : 'has data'}</td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="hw-block">
        <h4>Connection</h4>
        <div class="hw-line">URL: <code>${esc(info.mongoUrl)}</code></div>
        <div class="hw-line">Database: <b>${esc(info.dbName)}</b></div>
        <div class="hw-line">Collection: <b>${esc(info.collection)}</b></div>
      </div>
      ${renderMongoDirBlock(info)}
      <div class="hw-block">
        <h4>Collection statistics</h4>
        <table class="results" style="margin-top:4px">
          <tr><th>Documents</th><th>Data size</th><th>Storage size</th><th>Index size</th></tr>
          <tr>
            <td><b>${info.documentCount.toLocaleString()}</b></td>
            <td>${info.dataSizeMB} MB</td>
            <td>${info.storageSizeMB} MB</td>
            <td>${info.indexSizeMB} MB</td>
          </tr>
        </table>
      </div>
      <div class="hw-block">
        <h4>Indexes (${(info.indexes || []).length})</h4>
        <table class="results" style="margin-top:4px">
          <thead><tr><th>Name</th><th>Keys</th><th>Unique</th><th>Sparse</th></tr></thead>
          <tbody>${idxRows}</tbody>
        </table>
      </div>
      <div class="hw-block">
        <h4>All databases on this server</h4>
        <table class="results" style="margin-top:4px">
          <thead><tr><th>Database</th><th>Size</th><th>Status</th></tr></thead>
          <tbody>${dbRows}</tbody>
        </table>
      </div>`;
  }

  $('#btn-storage-refresh').addEventListener('click', refreshStorage);

  window.api.onImportProgress((p) => {
    if (p.phase === 'all-done') { $('#import-bar').style.width = '100%'; return; }
    if (p.phase === 'plan') {
      $('#import-plan').textContent = `Running: ${p.workers} worker(s), ${p.tasks} chunk task(s) over ${p.files} file(s), chunk ${fmtSize(p.chunkBytes)}, ${p.inflight} in-flight writes each, GPU fold ${p.gpuFold ? 'on' : 'off'}.`;
      return;
    }
    if (p.file) updateFileRow(p.file, p);
    if (p.bytesTotal) $('#import-bar').style.width = `${Math.min(100, (100 * p.bytes) / p.bytesTotal)}%`;
  });

  // GPU ops requested by the main process (fold for the importers, rank/state for diagnostics).
  window.api.onGpuOp(async (op, payload) => {
    switch (op) {
      case 'fold': return window.GpuRank.normalizeBatch(payload.strings || []);
      case 'rank': return window.GpuRank.rank(payload.candidates || [], payload.query, payload.topK || 50);
      case 'state': return window.GpuRank.state();
      default: throw new Error(`unknown gpu op ${op}`);
    }
  });

  /* ---------------------------- helpers ---------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ----------------------------- init ------------------------------ */
  (async function init() {
    const flags = (await window.api.getGpuFlags().catch(() => null)) || {};
    await window.GpuRank.initGpu({ allowSoftware: !!flags.allowSoftware });
    window.api.reportGpuState(window.GpuRank.state());
    renderGpuChip();
    await renderHardware(false);
    await refreshStatus();
    await scanFiles();
    await refreshStorage();
    setInterval(refreshStatus, 15_000);
  })();
})();
