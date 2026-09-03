'use strict';

/**
 * Per-source CSV layouts, derived from the database-folder report.
 *
 * Every source maps its physical columns (by position) onto the unified
 * "person" document. Columns mapped to `null` are dropped entirely
 * (the report marks them >=95% empty / useless: passwords, office phones,
 * Field15/Field16, ...).
 *
 * Header handling: the report shows irancell files mix two header styles
 * (named vs generic FieldN) and some files carry TWO header rows; one file
 * (938-1.csv) has a corrupted header ('j' instead of ADDRESS_V). Because the
 * column ORDER is stable across all files of a source, we map positionally
 * and skip any leading header-looking rows instead of trusting header names.
 */

// Unified person fields (scalars):   nationalCode, fullName, firstName, lastName,
//   fatherName, idNumber, birthDate, city, province, birthCity, birthProvince,
//   defineNumber, defineNumOld, branch, poBox
// Unified person fields (arrays):    mobiles, phones, cards, accounts, addresses, emails
// Meta (arrays):                     sources

const MELLAT = {
  id: 'mellat',
  label: 'Bank Mellat',
  match: (dir, file) => /mellat/i.test(dir) || /mellat/i.test(file),
  // NATIONAL_CODE | ACCOUNT_NUMBER | FULL_NAME | FATHER_NAME | ID_NUMBER |
  // BIRTH_DATE | CITY_NAME | PROVINCE_NAME | BIRTH_CITY | BIRTH_PROVINCE |
  // ADDRESS | CARD_NO | MOBILE
  columns: [
    'nationalCode', 'account', 'fullName', 'fatherName', 'idNumber',
    'birthDate', 'city', 'province', 'birthCity', 'birthProvince',
    'address', 'card', 'mobile',
  ],
  personKey: 'nationalCode',
  isHeaderRow: (row) => /^national_?code$/i.test(cleanCell(row[0])),
};

const MELLI = {
  id: 'melli',
  label: 'Bank Melli',
  match: (dir, file) => /melli/i.test(dir) || /melli/i.test(file),
  // NATIONAL_CODE | CARD_NO | FULL_NAME | BIRTH_DATE | MOBILE
  columns: ['nationalCode', 'card', 'fullName', 'birthDate', 'mobile'],
  personKey: 'nationalCode',
  isHeaderRow: (row) => /^national_?code$/i.test(cleanCell(row[0])),
};

const SADERAT = {
  id: 'saderat',
  label: 'Bank Saderat',
  match: (dir, file) => /saderat/i.test(dir) || /saderat/i.test(file),
  // AccountNumber | DefineationNumber | FullName | CardNumber | Password_Hint |
  // user_email_address | Passw | user_phone_number | Member | Username |
  // DefineNum_Old | ID_Branch
  // -> Password_Hint / Passw / Member / Username are ~100% empty: dropped.
  //    user_email_address is 99%+ empty but kept (stored only when present).
  columns: [
    'account', 'defineNumber', 'fullName', 'card', null,
    'email', null, 'phone', null, null,
    'defineNumOld', 'branch',
  ],
  // Saderat rows carry no national code -> the account number is the identity.
  personKey: 'account',
  isHeaderRow: (row) => /^accountnumber$/i.test(cleanCell(row[0])),
};

const IRANCELL = {
  id: 'irancell',
  label: 'Irancell',
  match: (dir, file) => /irancell/i.test(dir) || /^\d{3}-\d/i.test(file),
  // MOBL_NUM_VOICE_V | SUBS_NAME_V | FAMILY_NAME_V | IC_NUMBER_V |
  // CONTACT_HOME_NUM_V | CONTACT_OFFICE_NUM_V | ADDRESS_V | PROVINCE_V |
  // TOWN_CITY_V | PO_BOX_V   (+ optional Field15 | Field16 in 935-2)
  // Generic style: Field1..Field14 map to the same positions.
  // -> CONTACT_OFFICE_NUM_V / Field15 / Field16 are >=95% empty: dropped.
  columns: [
    'mobile', 'firstName', 'lastName', 'nationalCode', 'phone',
    null, 'address', 'province', 'city', 'poBox', null, null,
  ],
  personKey: 'nationalCode',
  // Handles both header styles and the files with TWO header rows, plus the
  // corrupted 'j' header (positional mapping makes header names irrelevant).
  isHeaderRow: (row) => /^(mobl_num_voice_v|field1)$/i.test(cleanCell(row[0])),
};

const SOURCES = [MELLAT, MELLI, SADERAT, IRANCELL];

function cleanCell(v) {
  return String(v == null ? '' : v).trim();
}

/** Resolve the source definition for a CSV path, or null when unknown. */
function resolveSource(filePath) {
  const path = require('path');
  const dir = path.basename(path.dirname(filePath));
  const file = path.basename(filePath);
  for (const src of SOURCES) {
    try {
      if (src.match(dir, file)) return src;
    } catch { /* matcher must never break scanning */ }
  }
  return null;
}

module.exports = { SOURCES, MELLAT, MELLI, SADERAT, IRANCELL, resolveSource };
