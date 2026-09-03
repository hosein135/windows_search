'use strict';

/**
 * Value normalization for the unified "person" document.
 *
 * Rules come straight from the database-folder report:
 *  - Placeholders count as EMPTY and are never stored:
 *    blank/whitespace, null / None / nan / n/a / -
 *    (Mellat/Melli 'None' cities, irancell 'null'/'-' phones, Saderat blanks).
 *  - Saderat numeric fields look like floats from a spreadsheet export
 *    ('1.0', '3046.0', '287910434.0') -> integer part only.
 *  - Saderat phones carry leading/trailing spaces.
 *  - irancell address/city cells contain runs of TAB characters used as
 *    fixed-width padding -> collapsed to single spaces.
 *  - Persian text: Arabic variants are folded so search matches either
 *    spelling (ي->ی, ك->ک, tatweel removed, Arabic/Persian digits -> ASCII
 *    for the normalized search copies).
 *
 * A "row" (Mongo document) is never empty: buildPerson() returns null for
 * rows that carry no usable identity at all, and the importer skips them.
 * Null fields are simply omitted from the document.
 */

const PLACEHOLDERS = new Set([
  '', '-', '--', '—', '.', '..',
  'null', 'none', 'nan', 'n/a', 'na', 'nil', '- ',
]);

const AR_YEH = 0x064a; // ي
const FA_YEH = 0x06cc; // ی
const AR_KEH = 0x0643; // ك
const FA_KEH = 0x06a9; // ک
const TATWEEL = 0x0640; // ـ

/** True when the raw cell is blank or a known placeholder. */
function isPlaceholder(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (s === '') return true;
  return PLACEHOLDERS.has(s.toLowerCase());
}

/** Collapse tabs / non-breaking spaces / runs of spaces, trim. */
function collapseWhitespace(v) {
  return String(v)
    .replace(/[\t ﻿]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** '3046.0' -> '3046'  (spreadsheet float exports in the Saderat dumps). */
function stripFloatSuffix(v) {
  const m = /^(\d+)\.0+$/.exec(v);
  return m ? m[1] : v;
}

/**
 * Clean a raw CSV cell into a storable scalar, or null when empty/placeholder.
 */
function cleanValue(v) {
  if (v == null) return null;
  let s = collapseWhitespace(String(v));
  if (s === '' || PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s;
}

/** Same as cleanValue, plus digit folding + float-suffix stripping (IDs / cards / branch). */
function cleanNumericId(v) {
  const s = cleanValue(v);
  if (s == null) return null;
  return stripFloatSuffix(normalizeDigits(s));
}

/** Phone/mobile: fold digit alphabets, keep digits only ('021-66570876' -> '02166570876'). */
function cleanPhone(v) {
  const s = cleanValue(v);
  if (s == null) return null;
  const digits = normalizeDigits(s).replace(/[^\d]/g, '');
  if (digits === '' || /^0+$/.test(digits)) return null;
  return digits;
}

/** Fold Arabic-Indic (٠-٩) and Extended Arabic-Indic / Persian (۰-۹) digits to ASCII. */
function normalizeDigits(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(0x30 + (c - 0x0660));
    else if (c >= 0x06f0 && c <= 0x06f9) out += String.fromCharCode(0x30 + (c - 0x06f0));
    else out += ch;
  }
  return out;
}

/** Fold Arabic ي/ك to Persian ی/ک and drop tatweel. */
function normalizePersianChars(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === AR_YEH) out += String.fromCodePoint(FA_YEH);
    else if (c === AR_KEH) out += String.fromCodePoint(FA_KEH);
    else if (c === TATWEEL) continue;
    else out += ch;
  }
  return out;
}

/** Search-normalized copy: persian-folded, digit-folded, lowercased, ws-collapsed. */
function searchNorm(s) {
  if (s == null) return null;
  const out = collapseWhitespace(normalizeDigits(normalizePersianChars(String(s)))).toLowerCase();
  return out === '' ? null : out;
}

const SCALAR_FIELDS = new Set([
  'nationalCode', 'fullName', 'firstName', 'lastName', 'fatherName',
  'idNumber', 'birthDate', 'city', 'province', 'birthCity', 'birthProvince',
  'defineNumber', 'defineNumOld', 'branch', 'poBox',
]);
const ARRAY_FIELDS = new Set(['mobiles', 'phones', 'cards', 'accounts', 'addresses', 'emails']);

/** Map a schema column target to (bucket, value) after cleaning. */
function cleanField(target, rawValue) {
  switch (target) {
    case 'mobile':
    case 'phone':
      return { bucket: target === 'mobile' ? 'mobiles' : 'phones', value: cleanPhone(rawValue) };
    case 'card':
      return { bucket: 'cards', value: cleanNumericId(rawValue) };
    case 'account':
      return { bucket: 'accounts', value: cleanNumericId(rawValue) };
    case 'address':
      return { bucket: 'addresses', value: cleanValue(rawValue) };
    case 'email': {
      const v = cleanValue(rawValue);
      return { bucket: 'emails', value: v ? v.toLowerCase() : null };
    }
    case 'nationalCode':
    case 'idNumber':
    case 'defineNumber':
    case 'defineNumOld':
    case 'branch': {
      return { bucket: target, value: cleanNumericId(rawValue) };
    }
    default:
      return { bucket: target, value: cleanValue(rawValue) };
  }
}

/**
 * Build the update parts for one person from a CSV row.
 *
 * Returns:
 *   {
 *     key,            // unique person key: 'nc:<nationalCode>' or '<src>:<account|mobile>'
 *     set,            // scalar fields ($set)        - only non-empty values
 *     addToSet,       // array fields ($addToSet)    - only non-empty values
 *     searchName,     // normalized name for indexed search ($set when present)
 *   }
 * or null when the row has no usable identity (an "empty row" -> skipped).
 */
function buildPerson(source, row, sourceTag) {
  const set = {};
  const addToSet = {};

  for (let i = 0; i < source.columns.length && i < row.length; i++) {
    const target = source.columns[i];
    if (!target) continue; // dropped column
    const { bucket, value } = cleanField(target, row[i]);
    if (value == null) continue; // never store empties
    if (SCALAR_FIELDS.has(bucket)) set[bucket] = value;
    else if (ARRAY_FIELDS.has(bucket)) {
      (addToSet[bucket] = addToSet[bucket] || new Set()).add(value);
    }
  }

  // Fold Arabic variants in every stored text value (idempotent), so display
  // and search are consistent no matter which alphabet the dump used.
  for (const k of Object.keys(set)) set[k] = normalizePersianChars(set[k]);
  if (addToSet.addresses) {
    addToSet.addresses = new Set([...addToSet.addresses].map(normalizePersianChars));
  }

  // Irancell gives first/last separately -> compose the display name.
  if (!set.fullName && (set.firstName || set.lastName)) {
    set.fullName = collapseWhitespace([set.firstName, set.lastName].filter(Boolean).join(' '));
  }

  const nationalCode = set.nationalCode || null;
  let key = null;
  if (nationalCode) key = `nc:${nationalCode}`;
  else if (addToSet.accounts && addToSet.accounts.size) key = `${source.id}:${[...addToSet.accounts][0]}`;
  else if (addToSet.mobiles && addToSet.mobiles.size) key = `${source.id}:m${[...addToSet.mobiles][0]}`;

  const hasIdentity =
    key != null || set.fullName || (addToSet.cards && addToSet.cards.size);
  if (!hasIdentity) return null; // empty row -> skipped, nothing stored
  if (!key) key = `${source.id}:name:${searchNorm(set.fullName)}`;

  const searchName = set.fullName ? searchNorm(set.fullName) : null;

  const out = { key, set, addToSet: {}, searchName };
  for (const [k, s] of Object.entries(addToSet)) out.addToSet[k] = [...s];
  out.addToSet.sources = [sourceTag];
  return out;
}

module.exports = {
  PLACEHOLDERS,
  isPlaceholder,
  collapseWhitespace,
  stripFloatSuffix,
  cleanValue,
  cleanNumericId,
  cleanPhone,
  normalizeDigits,
  normalizePersianChars,
  searchNorm,
  buildPerson,
};
