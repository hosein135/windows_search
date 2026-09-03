'use strict';

/**
 * CLI twin of the GUI hardware tab - prints the host inventory, the parallel
 * plan for this machine and the pipeline involvement report (same detection
 * the GUI shows). WebGPU itself needs a Chromium renderer, so the live GPU
 * endpoint list is only visible in the GUI (Hardware tab -> Compute plan).
 */

const { getHardware } = require('../src/main/hardware');

(async function main() {
  const hw = await getHardware({ force: true });

  console.log('='.repeat(64));
  console.log(' Host hardware inventory (Windows)');
  console.log('='.repeat(64));
  console.log(`  CPU name : ${hw.cpu.name}`);
  console.log(`  CPU class: ${hw.cpu.class} (${hw.cpu.vendor})`);
  console.log(`  Cores    : ${hw.cpu.cores || '?'} physical / ${hw.cpu.threads} logical threads`);
  if (hw.memoryGB) console.log(`  RAM      : ~${hw.memoryGB} GB`);
  console.log('');
  console.log('  Display adapters:');
  if (!hw.gpus.length) console.log('   (none reported by Win32_VideoController)');
  for (const g of hw.gpus) {
    console.log(`   - [${g.label}] ${g.name}${g.vramMB ? ` | ~${g.vramMB} MB VRAM` : ''}${g.driver ? ` | driver ${g.driver}` : ''}`);
  }
  console.log(`  DXGI adapter LUIDs: ${hw.adapterLuids.length ? hw.adapterLuids.join(', ') : 'unavailable (GPU perf counters missing)'}`);
  console.log('');
  if (hw.nvidiaSmi.available) {
    console.log('  nvidia-smi:');
    for (const line of hw.nvidiaSmi.gpus) console.log(`   ${line}`);
  } else {
    console.log('  nvidia-smi: not on PATH - CUDA path unavailable; WebGPU/CPU will be used');
  }
  console.log('');
  console.log('  Preferred ranker:', hw.preferredRanker.toUpperCase());
  console.log('');
  console.log('='.repeat(64));
  console.log(' Parallel plan for this machine');
  console.log('='.repeat(64));
  console.log(`  Import workers      : ${hw.plan.importWorkers} thread(s) (one per logical CPU)`);
  console.log(`  In-flight writes    : ${hw.plan.inflightWritesPerWorker} per worker -> ${hw.plan.concurrentBulkWrites} concurrent bulkWrites`);
  console.log(`  File chunking       : ${hw.plan.chunking}`);
  console.log(`  GPU processes       : ${hw.plan.gpuProcesses}`);
  console.log(`  CPU rank workers    : ${hw.plan.cpuRankWorkers} (GUI fallback when no GPU)`);
  console.log('');
  console.log(`  Run:  bun scripts/import-cli.js --parallel --workers ${hw.plan.importWorkers} --inflight ${hw.plan.inflightWritesPerWorker}`);
  console.log('');
  console.log('='.repeat(64));
  console.log(' Pipeline involvement (who does what)');
  console.log('='.repeat(64));
  for (const i of hw.involvement) {
    console.log(`  [${i.role}] ${i.device}`);
    console.log(`      ${i.detail}`);
  }
})().catch((err) => {
  console.error('hardware detection failed:', err.message);
  process.exit(1);
});
