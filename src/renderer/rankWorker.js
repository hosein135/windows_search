'use strict';

/**
 * CPU compute worker - one per core (see CpuRankPool in gpuRank.js).
 *
 * Rank: the RANK_WGSL algorithm over the same packed buffers the GPU would
 * receive (meta = [start,len] per doc-field, text = UTF-16 code units).
 * Fold: the FOLD_WGSL character map (Persian/Arabic yeh/keh, tatweel drop,
 * Arabic/Persian digits -> ASCII).
 *
 * Both paths are bit-for-bit comparable with the GPU kernels so a shard can
 * move between a GPU process and a CPU worker without a second pack step.
 */

function cpuFold(strings) {
  const out = new Array(strings.length);
  for (let i = 0; i < strings.length; i++) {
    let s = '';
    for (const ch of String(strings[i] == null ? '' : strings[i])) {
      const c = ch.codePointAt(0);
      if (c === 0x064a) s += 'ی';
      else if (c === 0x0643) s += 'ک';
      else if (c === 0x0640) continue;
      else if (c >= 0x0660 && c <= 0x0669) s += String.fromCharCode(0x30 + (c - 0x0660));
      else if (c >= 0x06f0 && c <= 0x06f9) s += String.fromCharCode(0x30 + (c - 0x06f0));
      else s += ch;
    }
    out[i] = s;
  }
  return out;
}

self.onmessage = (e) => {
  const data = e.data || {};
  const { id, op } = data;
  try {
    if (op === 'fold') {
      const strings = cpuFold(data.strings || []);
      self.postMessage({ id, strings });
      return;
    }

    const { meta, text, qmeta, qtext, numDocs, numFields, numTokens, weights } = data;
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
