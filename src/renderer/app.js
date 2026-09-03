'use strict';

/* Renderer app logic: search (GPU-ranked), import control, hardware view. */

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

  async function renderHardware(force) {
    const hw = await window.api.getHardware({ force: !!force });

    $('#hw-cpu').innerHTML = `
      <h4>CPU</h4>
      <div class="hw-line"><b>${esc(hw.cpu.name)}</b></div>
      <div class="hw-line muted">${hw.cpu.vendor} - ${hw.cpu.threads || '?'} threads${hw.memoryGB ? ` - ${hw.memoryGB} GB RAM` : ''}</div>`;

    const gpuHtml = hw.gpus.length
      ? hw.gpus.map((g) => `
          <div class="hw-line ${KIND_CLASS[g.kind] || 'hw-other'}">
            [${esc(g.label)}] ${esc(g.name)}${g.vramMB ? ` - ~${g.vramMB} MB VRAM` : ''}
          </div>`).join('')
      : '<div class="hw-line hw-other">(no adapters reported by Win32_VideoController)</div>';
    const smi = hw.nvidiaSmi && hw.nvidiaSmi.available
      ? `<div class="hw-line hw-nvidia">nvidia-smi: ${hw.nvidiaSmi.gpus.map(esc).join(' | ')}</div>`
      : '<div class="hw-line muted">nvidia-smi: not available - CUDA path unavailable, WebGPU/CPU will be used</div>';
    $('#hw-gpus').innerHTML = `<h4>Display adapters</h4>${gpuHtml}${smi}`;

    $('#hw-involvement').innerHTML = hw.involvement.map((i) => `
      <div class="inv-card">
        <span class="inv-role">${esc(i.role)}</span>
        <b>${esc(i.device)}</b><br /><span class="muted">${esc(i.detail)}</span>
      </div>`).join('');

    $('#chip-cpu').textContent = `CPU: ${(hw.cpu.name || 'unknown').replace(/\(R\)|\(TM\)/g, '').slice(0, 32)} (${hw.cpu.threads || '?'}t)`;
  }

  $('#btn-hw-refresh').addEventListener('click', () => renderHardware(true));

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
    if (window.GpuRank.gpuAvailable()) {
      const info = window.GpuRank.adapterInfo() || {};
      chip.textContent = `GPU: WebGPU${info.description ? ` (${info.description})` : ''}`;
      chip.className = 'chip chip-ok';
      chip.title = [info.vendor, info.architecture, info.device].filter(Boolean).join(' / ');
    } else {
      chip.textContent = 'GPU: CPU fallback';
      chip.className = 'chip chip-warn';
      chip.title = (window.GpuRank.state() && window.GpuRank.state().reason) || 'WebGPU unavailable';
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

    $('#search-meta').textContent =
      `${res.candidates.length} candidates from MongoDB in ${res.tookMs.toFixed(0)} ms` +
      ` (query ${(t1 - t0).toFixed(0)} ms) - ranked on ${ranked.device.toUpperCase()} in ${(t2 - t1).toFixed(1)} ms` +
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
        <td class="c-rate">-</td><td class="c-state">pending</td>
      </tr>`).join('');
    $('#btn-import').disabled = !known.length;

    // Wire per-file import buttons
    document.querySelectorAll('.btn-import-one').forEach((btn) => {
      btn.addEventListener('click', () => importOneFile(Number(btn.dataset.i)));
    });
  }

  function updateFileRow(fileName, p) {
    const row = [...document.querySelectorAll('#files-body tr')]
      .find((tr) => tr.dataset.path.endsWith(fileName));
    if (!row) return;
    row.querySelector('.c-rows').textContent = p.rows != null ? p.rows.toLocaleString() : '-';
    row.querySelector('.c-persons').textContent = p.persons != null ? p.persons.toLocaleString() : '-';
    row.querySelector('.c-skipped').textContent = p.skipped != null ? p.skipped.toLocaleString() : '-';
    row.querySelector('.c-rate').textContent = p.rowsPerSec ? p.rowsPerSec.toLocaleString() : '-';
    row.querySelector('.c-state').textContent = p.phase;
    if (p.bytesTotal) {
      const pct = Math.min(100, (100 * (p.bytes || 0)) / p.bytesTotal);
      row.querySelector('.c-state').textContent = `${p.phase} ${pct.toFixed(0)}%`;
    }
  }

  $('#btn-scan').addEventListener('click', scanFiles);

  $('#btn-import').addEventListener('click', async () => {
    const selected = [...document.querySelectorAll('.file-chk:checked')]
      .map((c) => filesCache[Number(c.dataset.i)].path);
    if (!selected.length) return;
    $('#btn-import').disabled = true;
    $('#btn-cancel').disabled = false;
    // Disable all per-file buttons during batch import
    document.querySelectorAll('.btn-import-one').forEach((b) => b.disabled = true);
    const res = await window.api.startImport({
      files: selected,
      gpuNormalize: $('#chk-gpu-normalize').checked,
    });
    $('#btn-import').disabled = false;
    $('#btn-cancel').disabled = true;
    document.querySelectorAll('.btn-import-one').forEach((b) => b.disabled = false);
    if (res.error) $('#import-summary').textContent = res.error;
    else $('#import-summary').textContent =
      `Import ${res.cancelled ? 'cancelled' : 'finished'}: ${res.totals.persons.toLocaleString()} persons from ` +
      `${res.totals.rows.toLocaleString()} rows (${res.totals.skipped.toLocaleString()} empty rows skipped, ` +
      `${res.totals.errors.toLocaleString()} errors).`;
    refreshStatus();
    refreshStorage();
  });

  async function importOneFile(i) {
    const f = filesCache[i];
    if (!f || !f.known) return;
    // Disable buttons during single-file import
    const btn = document.querySelector(`.btn-import-one[data-i="${i}"]`);
    if (btn) btn.disabled = true;
    $('#btn-import').disabled = true;
    const row = [...document.querySelectorAll('#files-body tr')]
      .find((tr) => tr.dataset.path === f.path);
    if (row) row.querySelector('.c-state').textContent = 'importing...';

    const res = await window.api.importFile({
      file: f,
      gpuNormalize: $('#chk-gpu-normalize').checked,
    });

    if (btn) btn.disabled = false;
    $('#btn-import').disabled = false;

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
        `(${s.skipped.toLocaleString()} skipped, ${s.errors.toLocaleString()} errors).`;
    }
    refreshStatus();
    refreshStorage();
  }

  $('#btn-cancel').addEventListener('click', () => window.api.cancelImport());

  /* ---------------------------- storage ---------------------------- */
  async function refreshStorage() {
    const el = $('#storage-content');
    el.innerHTML = 'Loading...';
    const info = await window.api.storageInfo();
    if (!info.ok) {
      el.innerHTML = `<span class="chip chip-bad">MongoDB offline</span><br><span class="muted">${esc(info.error || '')}</span>`;
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
      <div class="hw-block">
        <h4>Data directory (MongoDB storage files)</h4>
        <div class="hw-line">Path: <code>${esc(info.dataDir)}</code></div>
        <div class="hw-line">Exists: ${info.dirInfo.exists ? 'yes' : 'no (mongod not started with this dbpath)'}</div>
        ${info.dirInfo.exists ? `<div class="hw-line">Total size: <b>${info.dirInfo.sizeMB} MB</b></div>` : ''}
        ${info.dirInfo.exists && info.dirInfo.files.length ? `
          <div class="hw-line muted">Files (${info.dirInfo.files.length}):</div>
          <div class="hw-line muted" style="font-size:11px;max-height:120px;overflow:auto">${info.dirInfo.files.map(esc).join('<br>')}</div>` : ''}
      </div>
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
    if (p.file) updateFileRow(p.file, p);
    if (p.bytesTotal) $('#import-bar').style.width = `${Math.min(100, (100 * p.bytes) / p.bytesTotal)}%`;
  });

  // GPU normalize hook used by the importer when the checkbox is on.
  window.api.onGpuNormalize(async (strings) => {
    const out = await window.GpuRank.normalizeBatch(strings);
    return out.strings;
  });

  /* ---------------------------- helpers ---------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ----------------------------- init ------------------------------ */
  (async function init() {
    await window.GpuRank.initGpu();
    renderGpuChip();
    await renderHardware(false);
    await refreshStatus();
    await scanFiles();
    await refreshStorage();
    setInterval(refreshStatus, 15_000);
  })();
})();
