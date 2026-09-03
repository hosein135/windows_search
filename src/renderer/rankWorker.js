'use strict';

/**
 * CPU rank worker - one per core (see CpuRankPool in gpuRank.js).
 *
 * Runs exactly the RANK_WGSL algorithm over the same packed buffers the GPU
 * would receive (meta = [start,len] per doc-field, text = UTF-16 code units),
 * so the CPU fallback is bit-for-bit comparable with the GPU result and the
 * main thread never has to re-pack when a shard moves between devices.
 */

self.onmessage = (e) => {
  const { id, meta, text, qmeta, qtext, numDocs, numFields, numTokens, weights } = e.data;
  try {
    const scores = new Uint32Array(numDocs);
    const masks = new Uint32Array(numDocs);
    for (let doc = 0; doc < numDocs; doc++) {
      let score = 0;
      let mask = 0;
      for (let f = 0; f < numFields; f++) {
        const mbase = (doc * numFields + f) * 2;
        const fs = meta[mbase];
        const fl = meta[mbase + 1];
        if (fl === 0) continue;
        const w = weights[f];
        for (let t = 0; t < numTokens; t++) {
          const ts = qmeta[t * 2];
          const tl = qmeta[t * 2 + 1];
          if (tl === 0 || tl > fl) continue;
          if (tl === fl) {
            let eq = true;
            for (let k = 0; k < fl; k++) {
              if (text[fs + k] !== qtext[ts + k]) { eq = false; break; }
            }
            if (eq) { score += w * 10; mask |= (1 << f); continue; }
          }
          for (let i = 0; i + tl <= fl; i++) {
            let hit = true;
            for (let k = 0; k < tl; k++) {
              if (text[fs + i + k] !== qtext[ts + k]) { hit = false; break; }
            }
            if (hit) { score += w; mask |= (1 << f); break; }
          }
        }
      }
      scores[doc] = score;
      masks[doc] = mask;
    }
    self.postMessage({ id, scores, masks }, [scores.buffer, masks.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
