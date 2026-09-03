'use strict';

/**
 * CLI twin of the GUI hardware tab - prints the host inventory and the
 * pipeline involvement report (same detection the GUI shows).
 */

const { getHardware } = require('../src/main/hardware');

(async function main() {
  const hw = await getHardware({ force: true });

  console.log('='.repeat(64));
  console.log(' Host hardware inventory (Windows)');
  console.log('='.repeat(64));
  console.log(`  CPU name : ${hw.cpu.name}`);
  console.log(`  CPU vendor: ${hw.cpu.vendor}`);
  console.log(`  Threads  : ${hw.cpu.threads}`);
  if (hw.memoryGB) console.log(`  RAM      : ~${hw.memoryGB} GB`);
  console.log('');
  console.log('  Display adapters:');
  if (!hw.gpus.length) console.log('   (none reported by Win32_VideoController)');
  for (const g of hw.gpus) {
    console.log(`   - [${g.label}] ${g.name}${g.vramMB ? ` | ~${g.vramMB} MB VRAM` : ''}`);
  }
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
