'use strict';

/**
 * Generates small synthetic demo CSVs into databases/, mirroring the real
 * dumps' layouts AND their quirks (placeholders, float-ish ids, tabbed
 * addresses, both irancell header styles, two-header files, corrupted 'j'
 * header, empty rows). All data is fake. Overlapping national codes across
 * sources prove the one-document-per-person merge.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'databases');

const FIRST = ['احمد', 'علي', 'مريم', 'زهرا', 'رضا', 'سعيد', 'نرگس', 'حسين', 'فاطمه', 'محمد', 'اکبر', 'اسما'];
const LAST = ['اسدي', 'مرادي', 'حسني', 'كريمي', 'محمدي', 'قاسمي', 'احمدي', 'رضايي', 'جعفري', 'موسوي'];
const CITIES = ['تهران', 'اراک', 'ايلام', 'ياسوج', 'کرمان', 'سلماس'];
const PROVINCES = ['تهران', 'مرکزی', 'ايلام', 'کهگيلويه وبويراحمد', 'کرمان', 'آذربایجان غربی'];

const nc = (i) => String(1000000000 + ((i * 37) % 8999999999)).slice(0, 10);
const mobile = (i) => `09${String(120000000 + ((i * 7919) % 879999999)).slice(0, 9)}`;
const irMobile = (i) => `935${String(1000000 + ((i * 104729) % 8999999)).slice(0, 7)}`;
const cardMellat = (i) => `6104337${String(100000000 + ((i * 104729) % 899999999)).slice(0, 9)}`;
const cardMelli = (i) => `6037991${String(100000000 + ((i * 15485863) % 899999999)).slice(0, 9)}`;
const name = (i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
const father = (i) => FIRST[(i * 7) % FIRST.length];
const birthDate = (i) => `13${40 + (i % 60)}-0${1 + (i % 9)}-1${i % 9}`;

function write(rel, header, rows) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [header, ...rows].join('\r\n') + '\r\n', 'utf8');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  wrote ${rel}  (${rows.length} rows, ${kb} KB)`);
}

function main() {
  console.log(`Generating sample data into ${ROOT}`);

  // ---- bank mellat (13 cols; 'None' placeholders; shares nc 0..29 with irancell)
  const mellatHeader = 'NATIONAL_CODE,ACCOUNT_NUMBER,FULL_NAME,FATHER_NAME,ID_NUMBER,BIRTH_DATE,CITY_NAME,PROVINCE_NAME,BIRTH_CITY,BIRTH_PROVINCE,ADDRESS,CARD_NO,MOBILE';
  const mellatRows = [];
  for (let i = 0; i < 300; i++) {
    const city = i % 5 === 0 ? 'None' : CITIES[i % CITIES.length];
    const prov = i % 5 === 0 ? 'None' : PROVINCES[i % PROVINCES.length];
    mellatRows.push([
      nc(i), String(1132715732 + i), name(i), father(i), String(100 + i),
      birthDate(i), city, prov, CITIES[(i + 1) % CITIES.length], PROVINCES[(i + 1) % PROVINCES.length],
      `${CITIES[i % CITIES.length]} خ كمرزاده پلاک ${i}`, cardMellat(i), mobile(i),
    ].join(','));
  }
  write(path.join('bank mellat', 'Bank Mellat DB1.csv'), mellatHeader, mellatRows);

  // ---- bank melli (5 cols; 2/3 of MOBILE blank; one fully empty row)
  const melliHeader = 'NATIONAL_CODE,CARD_NO,FULL_NAME,BIRTH_DATE,MOBILE';
  const melliRows = [];
  for (let i = 0; i < 300; i++) {
    const id = 5000 + i; // distinct from mellat/irancell
    melliRows.push([
      nc(id), cardMelli(i), name(id), birthDate(id),
      i % 3 === 2 ? '' : mobile(id),
    ].join(','));
  }
  melliRows.push(',,,,'); // empty row -> must be skipped by the importer
  write(path.join('bank melli', 'Bank Melli DB1.csv'), melliHeader, melliRows);

  // ---- bank saderat (12 cols; float ids, spaced phones, dead password columns)
  const saderatHeader = 'AccountNumber,DefineationNumber,FullName,CardNumber,Password_Hint,user_email_address,Passw,user_phone_number,Member,Username,DefineNum_Old,ID_Branch';
  const saderatRows = [];
  for (let i = 0; i < 300; i++) {
    const acct = `2134056${String(8000 + i)}`;
    saderatRows.push([
      acct, String(91 + i), name(9000 + i),
      i % 4 === 0 ? `${3000 + i}.0` : '', // spreadsheet float export
      '', '', '',
      i % 3 === 0 ? ` ${mobile(9000 + i)} ` : '', // padded phone
      '', '', '', `${1 + (i % 50)}.0`,
    ].join(','));
  }
  write(path.join('bank saderat', 'Bank Saderat DB1.csv'), saderatHeader, saderatRows);

  // ---- irancell, named header (935-1 style; 'null' placeholders; tabs; one quoted comma address)
  const irNamed = 'MOBL_NUM_VOICE_V,SUBS_NAME_V,FAMILY_NAME_V,IC_NUMBER_V,CONTACT_HOME_NUM_V,CONTACT_OFFICE_NUM_V,ADDRESS_V,PROVINCE_V,TOWN_CITY_V,PO_BOX_V';
  const ir1 = [];
  for (let i = 0; i < 250; i++) {
    ir1.push([
      irMobile(i),
      FIRST[i % FIRST.length], LAST[(i * 3) % LAST.length], nc(i),
      i % 10 === 7 ? 'null' : `021-66${String(570000 + i)}`,
      'null',
      i === 3 ? '"10م ش كمالي, ك 15, تهران"' : `10م ش كمالي\t\tك ${i} تهران`,
      i % 5 === 0 ? 'null' : PROVINCES[i % PROVINCES.length],
      i % 3 === 0 ? 'null' : CITIES[i % CITIES.length],
      String(1353683434 + i),
    ].join(','));
  }
  write(path.join('irancell', '935-1.csv'), irNamed, ir1);

  // ---- irancell, generic FieldN header (936-1 style; office '-')
  const irGeneric = 'Field1,Field2,Field3,Field4,Field8,Field9,Field11,Field12,Field13,Field14';
  const ir2 = [];
  for (let i = 250; i < 500; i++) {
    ir2.push([
      irMobile(i), FIRST[i % FIRST.length], LAST[(i * 3) % LAST.length], nc(i),
      i % 2 === 0 ? `0741-33${String(31000 + i)}` : 'null', '-',
      `شاهد11 26\tکهگيلويه وبويراحمد`, PROVINCES[i % PROVINCES.length],
      i % 4 === 0 ? CITIES[i % CITIES.length] : 'null', String(7591654563 + i),
    ].join(','));
  }
  write(path.join('irancell', '936-1.csv'), irGeneric, ir2);

  // ---- irancell, TWO header rows (937-1 style: generic row, then named row)
  const ir3 = [];
  for (let i = 500; i < 650; i++) {
    ir3.push([
      irMobile(i), FIRST[i % FIRST.length], LAST[(i * 3) % LAST.length], nc(i),
      'null', 'null', `20 متري ابوذر م مقدم ${i} تهران`, 'null', 'null', String(1354755193 + i),
    ].join(','));
  }
  write(path.join('irancell', '937-1.csv'), `${irGeneric}\r\n${irNamed}`, ir3);

  // ---- irancell, corrupted header ('j' instead of ADDRESS_V, 938-1 style)
  const irCorrupt = 'MOBL_NUM_VOICE_V,SUBS_NAME_V,FAMILY_NAME_V,IC_NUMBER_V,CONTACT_HOME_NUM_V,CONTACT_OFFICE_NUM_V,j,PROVINCE_V,TOWN_CITY_V,PO_BOX_V';
  const ir4 = [];
  for (let i = 650; i < 800; i++) {
    ir4.push([
      irMobile(i), FIRST[i % FIRST.length], LAST[(i * 3) % LAST.length], nc(i),
      `021-774${String(60000 + i)}`, 'null', `خ سرباز ك شايگان بن بست ${i} تهران`, 'null', 'null', String(1631673697 + i),
    ].join(','));
  }
  write(path.join('irancell', '938-1.csv'), irCorrupt, ir4);

  console.log('Done. Import with:  npm run import   (or start the GUI:  npm start)');
}

main();
