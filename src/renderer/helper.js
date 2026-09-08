'use strict';

/* GPU helper renderer: initialise WebGPU on this process's adapter, report it,
 * then serve fold/rank/state requests forwarded by the helper's main process.
 * CPU workers stay in the main window so helpers don't oversubscribe cores. */

(async function main() {
  const flags = (await window.api.getGpuFlags().catch(() => null)) || {};
  const st = await window.GpuRank.initGpu({ allowSoftware: !!flags.allowSoftware, cpuWorkers: 0 });
  window.api.reportGpuState(st);

  window.api.onGpuOp(async (op, payload) => {
    payload = payload || {};
    const units = payload.units || 'gpu';
    switch (op) {
      case 'fold': {
        const out = await window.GpuRank.normalizeBatch(payload.strings || [], { units });
        if (!out || !Array.isArray(out.strings) || !/^gpu/.test(String(out.device))) {
          throw new Error('helper has no usable GPU');
        }
        return out.strings;
      }
      case 'rank': {
        const out = await window.GpuRank.rank(payload.candidates || [], payload.query, payload.topK || 50, { units });
        return out;
      }
      case 'state':
        return window.GpuRank.state();
      default:
        throw new Error(`unknown op ${op}`);
    }
  });
})();
