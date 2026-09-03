'use strict';

/* GPU helper renderer: initialise WebGPU on this process's adapter, report it,
 * then serve fold/rank/state requests forwarded by the helper's main process. */

(async function main() {
  const flags = (await window.api.getGpuFlags().catch(() => null)) || {};
  const st = await window.GpuRank.initGpu({ allowSoftware: !!flags.allowSoftware, cpuWorkers: 0 });
  window.api.reportGpuState(st);

  window.api.onGpuOp(async (op, payload) => {
    switch (op) {
      case 'fold': {
        const out = await window.GpuRank.normalizeBatch(payload.strings || []);
        if (out.device !== 'gpu') throw new Error('helper has no usable GPU');
        return out.strings;
      }
      case 'rank': {
        const out = await window.GpuRank.rank(payload.candidates || [], payload.query, payload.topK || 50);
        return out;
      }
      case 'state':
        return window.GpuRank.state();
      default:
        throw new Error(`unknown op ${op}`);
    }
  });
})();
