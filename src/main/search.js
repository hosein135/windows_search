'use strict';

/**
 * Query planning + candidate selection (MongoDB side).
 *
 * Mongo narrows the set with indexes; the GPU (or CPU fallback) then ranks
 * the candidates. Query type is auto-detected:
 *   10 digits              -> national code (exact)
 *   11 digits starting 09  -> mobile (exact, multikey)
 *   16 digits              -> payment card (exact, multikey)
 *   other long digit run   -> any id (nationalCode / mobile / card / account)
 *   otherwise              -> name tokens (AND of substring matches on the
 *                             normalized searchName)
 */

const { searchNorm, normalizeDigits } = require('./normalize');

const NAME_CANDIDATE_CAP = 5000;   // bounded scan before ranking
const DEFAULT_LIMIT = 500;         // docs sent to the ranker

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyQuery(raw) {
  const q = normalizeDigits(String(raw || '').trim());
  if (!q) return { type: 'empty' };
  if (/^\d{10}$/.test(q)) return { type: 'nationalCode', value: q };
  if (/^09\d{9}$/.test(q)) return { type: 'mobile', value: q };
  if (/^\d{16}$/.test(q)) return { type: 'card', value: q };
  if (/^\d{4,}$/.test(q)) return { type: 'anyId', value: q };
  const norm = searchNorm(raw);
  const tokens = norm ? norm.split(' ').filter(Boolean) : [];
  if (!tokens.length) return { type: 'empty' };
  return { type: 'name', tokens, value: norm };
}

const PROJECTION = {
  key: 1, nationalCode: 1, fullName: 1, firstName: 1, lastName: 1,
  fatherName: 1, birthDate: 1, city: 1, province: 1, birthCity: 1,
  birthProvince: 1, mobiles: 1, phones: 1, cards: 1, accounts: 1,
  addresses: 1, emails: 1, sources: 1, searchName: 1,
};

function buildFilter(query) {
  switch (query.type) {
    case 'nationalCode': return { nationalCode: query.value };
    case 'mobile': return { mobiles: query.value };
    case 'card': return { cards: query.value };
    case 'anyId':
      return {
        $or: [
          { nationalCode: query.value },
          { mobiles: query.value },
          { cards: query.value },
          { accounts: query.value },
          { idNumber: query.value },
        ],
      };
    case 'name':
      return { $and: query.tokens.map((t) => ({ searchName: { $regex: escapeRegex(t) } })) };
    default:
      return null;
  }
}

/**
 * Run the Mongo side of a search.
 * Returns { query, candidates, tookMs, capped }.
 */
async function search(col, raw, { limit = DEFAULT_LIMIT } = {}) {
  const query = classifyQuery(raw);
  if (query.type === 'empty') return { query, candidates: [], tookMs: 0, capped: false };

  const filter = buildFilter(query);
  const started = process.hrtime.bigint();

  const cap = query.type === 'name' ? NAME_CANDIDATE_CAP : limit;
  const candidates = await col
    .find(filter, { projection: PROJECTION })
    .limit(cap)
    .toArray();

  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { query, candidates, tookMs, capped: candidates.length >= cap };
}

/**
 * CPU fallback ranker (same scoring as the WGSL kernel).
 * Score = sum over fields of substring hits * field weight; exact hits win big.
 */
const FIELD_WEIGHTS = { searchName: 3, nationalCode: 100, mobile: 80, card: 80 };

function docFields(doc) {
  return {
    searchName: doc.searchName || '',
    nationalCode: doc.nationalCode || '',
    mobile: (doc.mobiles && doc.mobiles[0]) || '',
    card: (doc.cards && doc.cards[0]) || '',
  };
}

function scoreDoc(doc, query) {
  const tokens = query.type === 'name' ? query.tokens : [query.value];
  const fields = docFields(doc);
  let score = 0;
  let mask = 0;
  const names = Object.keys(fields);
  for (let fi = 0; fi < names.length; fi++) {
    const fname = names[fi];
    const fval = fields[fname];
    if (!fval) continue;
    const w = FIELD_WEIGHTS[fname];
    for (const t of tokens) {
      if (!t) continue;
      if (fval === t) { score += w * 10; mask |= (1 << fi); }
      else if (fval.includes(t)) { score += w; mask |= (1 << fi); }
    }
  }
  return { score, mask };
}

function cpuRank(candidates, query, topK = 50) {
  const scored = candidates.map((doc) => {
    const { score, mask } = scoreDoc(doc, query);
    return { doc, score, mask };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

module.exports = { classifyQuery, buildFilter, search, cpuRank, scoreDoc, FIELD_WEIGHTS };
