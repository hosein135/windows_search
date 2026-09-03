'use strict';

/**
 * End-to-end smoke test (no GUI required):
 *   1. normalization unit checks (placeholders, floats, tabs, Persian fold, phones)
 *   2. buildPerson checks per source layout (incl. "empty rows are skipped")
 *   3. full import of the generated sample data into a FakeCollection
 *      (verifies one-doc-per-person merge across sources + no empty fields)
 *   4. query classification checks
 *   5. REAL MongoDB end-to-end when mongod is reachable (optional)
 */

const assert = require('assert');
const path = require('path');

const N = require('../src/main/normalize');
const { resolveSource } = require('../src/main/schemas');
const { importAll } = require('../src/main/importer');
const { classifyQuery, cpuRank } = require('../src/main/search');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch((err) => { console.error(`  FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; });
}

/** Minimal in-memory stand-in for the persons collection (upsert semantics). */
class FakeCollection {
  constructor() { this.docs = new Map(); }
  async bulkWrite(ops) {
    let upserted = 0; let matched = 0; let modified = 0;
    for (const op of ops) {
      const { filter, update } = op.updateOne;
      const key = filter.key;
      let doc = this.docs.get(key);
      if (!doc) { doc = { ...(update.$setOnInsert || {}) }; this.docs.set(key, doc); upserted++; }
      else matched++;
      let changed = false;
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (JSON.stringify(doc[k]) !== JSON.stringify(v)) { doc[k] = v; changed = true; }
      }
      for (const [k, spec] of Object.entries(update.$addToSet || {})) {
        const arr = doc[k] || [];
        for (const x of spec.$each || [spec]) {
          if (!arr.includes(x)) { arr.push(x); changed = true; }
        }
        doc[k] = arr;
      }
      if (changed) modified++;
    }
    return { upsertedCount: upserted, matchedCount: matched, modifiedCount: modified };
  }
  async updateOne(filter, update, opts) {
    await this.bulkWrite([{ updateOne: { filter, update, upsert: !!(opts && opts.upsert) } }]);
  }
}

(async function main() {
  console.log('== 1. normalization ==');
  await ok('placeholders are empty', () => {
    for (const v of ['', '  ', 'null', 'None', 'NONE', 'nan', 'n/a', '-', null, undefined]) {
      assert.strictEqual(N.isPlaceholder(v), true, `expected placeholder: ${JSON.stringify(v)}`);
      assert.strictEqual(N.cleanValue(v), null);
    }
    assert.strictEqual(N.cleanValue('تهران'), 'تهران');
  });
  await ok('float-ish ids -> integer part', () => {
    assert.strictEqual(N.stripFloatSuffix('3046.0'), '3046');
    assert.strictEqual(N.stripFloatSuffix('287910434.0'), '287910434');
    assert.strictEqual(N.cleanNumericId('1.0'), '1');
    assert.strictEqual(N.cleanNumericId('6104337638223311'), '6104337638223311');
  });
  await ok('tabs / padded phones', () => {
    assert.strictEqual(N.collapseWhitespace('10م ش كمالي\t\tك 15'), '10م ش كمالي ك 15');
    assert.strictEqual(N.cleanPhone(' 0912-345 6789 '), '09123456789');
    assert.strictEqual(N.cleanPhone('021-66570876'), '02166570876');
    assert.strictEqual(N.cleanPhone('-'), null);
  });
  await ok('persian/arabic folding', () => {
    assert.strictEqual(N.normalizePersianChars('علي'), 'علی');
    assert.strictEqual(N.normalizePersianChars('بابك'), 'بابک');
    assert.strictEqual(N.normalizeDigits('۱۲۳۴۵'), '12345');
    assert.strictEqual(N.searchNorm('  سيد   علي '), 'سید علی');
  });

  console.log('== 2. buildPerson per layout ==');
  await ok('mellat row -> person, None placeholders dropped', () => {
    const src = resolveSource(path.join('databases', 'bank mellat', 'Bank Mellat DB1.csv'));
    const p = N.buildPerson(src, [
      '0532347226', '5640913340', 'هادي حسن ونديان', 'حاجي علي', '1507', '1357-10-06',
      'None', 'None', 'اراک', 'مرکزی', 'ماشين سازي اراک', '6104337846241071', '09183604450',
    ], 'mellat:test');
    assert.strictEqual(p.key, 'nc:0532347226');
    assert.strictEqual(p.set.fullName, 'هادی حسن وندیان'); // ي->ی folded
    assert.ok(!('city' in p.set), 'None city must be omitted');
    assert.ok(!('province' in p.set), 'None province must be omitted');
    assert.deepStrictEqual(p.addToSet.cards, ['6104337846241071']);
    assert.deepStrictEqual(p.addToSet.mobiles, ['09183604450']);
    assert.deepStrictEqual(p.addToSet.sources, ['mellat:test']);
    assert.strictEqual(p.searchName, 'هادی حسن وندیان');
  });
  await ok('saderat row -> person keyed by account, floats fixed, dead columns dropped', () => {
    const src = resolveSource(path.join('databases', 'bank saderat', 'Bank Saderat DB2.csv'));
    const p = N.buildPerson(src, [
      '21340569800', '497', 'عليرضا وهابي', '3046.0', '', '', '', '021 33788891 ', '', '', '', '3046',
    ], 'saderat:test');
    assert.strictEqual(p.key, 'saderat:21340569800');
    assert.strictEqual(p.set.fullName, 'علیرضا وهابی');
    assert.deepStrictEqual(p.addToSet.cards, ['3046']);
    assert.deepStrictEqual(p.addToSet.phones, ['02133788891']);
    assert.strictEqual(p.set.branch, '3046');
    assert.strictEqual(Object.keys(p.set).length, 3); // fullName, defineNumber, branch
  });
  await ok('irancell generic FieldN row -> person with composed name', () => {
    const src = resolveSource(path.join('databases', 'irancell', '936-1.csv'));
    const p = N.buildPerson(src, [
      '9366471796', 'ناهيد', 'نيک بختيان', '4220168346', '0741-3331189', '-',
      'شاهد11 26\tکهگيلويه وبويراحمد', 'ياسوج', 'null', '7591654563',
    ], 'irancell:test');
    assert.strictEqual(p.key, 'nc:4220168346');
    assert.strictEqual(p.set.fullName, 'ناهید نیک بختیان');
    assert.deepStrictEqual(p.addToSet.mobiles, ['9366471796']);
    assert.deepStrictEqual(p.addToSet.phones, ['07413331189']);
    assert.ok(!('city' in p.set), "'null' city must be omitted");
    assert.strictEqual(p.set.province, 'یاسوج');
    assert.strictEqual(p.addToSet.addresses[0].includes('\t'), false);
  });
  await ok('empty row -> null (skipped, no empty documents)', () => {
    const src = resolveSource(path.join('databases', 'bank melli', 'Bank Melli DB1.csv'));
    assert.strictEqual(N.buildPerson(src, ['', '', '', '', ''], 'melli:test'), null);
    assert.strictEqual(N.buildPerson(src, ['null', 'None', '-', 'nan', ' '], 'melli:test'), null);
  });

  console.log('== 3. import generated sample into FakeCollection ==');
  require('./make-sample-data'); // (re)generates databases/ sample CSVs
  const databasesDir = path.join(__dirname, '..', 'databases');
  const fake = new FakeCollection();
  await ok('importAll merges persons across sources', async () => {
    const totals = await importAll(databasesDir, { col: fake, batchSize: 97 });
    // 300 mellat + 200 new irancell (nc300-499) + 150 (nc500-649) + 150 (nc650-799)
    // + 300 melli + 300 saderat = 1400 unique person keys
    assert.strictEqual(fake.docs.size, 1400, `expected 1400 persons, got ${fake.docs.size}`);
    assert.strictEqual(totals.skipped, 1, 'the one empty melli row must be skipped');
  });
  await ok('no document field is empty', () => {
    for (const [key, doc] of fake.docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (k === 'createdAt' || k === 'updatedAt') continue;
        assert.ok(v !== null && v !== undefined && v !== '', `${key}.${k} is empty`);
        if (Array.isArray(v)) {
          assert.ok(v.length > 0, `${key}.${k} is an empty array`);
          for (const x of v) assert.ok(x !== '' && x != null, `${key}.${k} holds empty item`);
        }
      }
    }
  });
  await ok('merged person carries both sources', () => {
    const doc = fake.docs.get('nc:1000000000'); // nc(0): mellat + irancell 935-1
    assert.ok(doc, 'person missing');
    assert.ok(doc.sources.some((s) => s.startsWith('mellat:')), doc.sources);
    assert.ok(doc.sources.some((s) => s.startsWith('irancell:')), doc.sources);
    assert.ok(doc.mobiles.length >= 2, 'should hold mobiles from both sources');
    assert.ok(doc.cards.length >= 1 && doc.addresses.length >= 2);
  });
  await ok('two-header irancell file parsed', () => {
    // 937-1.csv contributes nc(500)..nc(649) -> spot check one
    const doc = fake.docs.get(`nc:${String(1000000000 + 500 * 37).slice(0, 10)}`);
    assert.ok(doc, 'person from 937-1.csv missing (header rows not skipped?)');
    assert.ok(doc.sources.some((s) => s.includes('937-1')));
  });

  console.log('== 4. query classification + CPU ranker ==');
  await ok('classifyQuery detects types', () => {
    assert.strictEqual(classifyQuery('09123456789').type, 'mobile');
    assert.strictEqual(classifyQuery('1000000000').type, 'nationalCode');
    assert.strictEqual(classifyQuery('6104337638223311').type, 'card');
    assert.strictEqual(classifyQuery('02166570876').type, 'anyId');
    const q = classifyQuery('علي اسدي');
    assert.strictEqual(q.type, 'name');
    assert.deepStrictEqual(q.tokens, ['علی', 'اسدی']);
    assert.strictEqual(classifyQuery('   ').type, 'empty');
  });
  await ok('cpuRank scores exact id above name hits', () => {
    const docs = [...fake.docs.values()].slice(0, 400);
    const target = docs.find((d) => d.nationalCode);
    const q = classifyQuery(target.nationalCode);
    const ranked = cpuRank(docs, q, 5);
    assert.strictEqual(ranked[0].doc.nationalCode, target.nationalCode);
    assert.ok(ranked[0].mask & 2, 'nationalCode bit should be set');
  });

  console.log('== 5. real MongoDB (optional) ==');
  const canReach = await (async () => {
    try {
      process.env.MONGO_DB = process.env.MONGO_DB || 'windows_search_smoke';
      const db = require('../src/main/db');
      await db.connect();
      await db.status();
      return db;
    } catch { return null; }
  })();
  if (!canReach) {
    console.log('  SKIP  mongod not reachable at mongodb://127.0.0.1:27017 - run setup.ps1, then re-run bun run smoke');
  } else {
    const db = canReach;
    await ok('import sample + search against live mongod', async () => {
      await db.connect();
      await db.persons().deleteMany({});
      await db.ensureIndexes();
      await importAll(databasesDir, { col: db.persons(), batchSize: 500 });
      const count = await db.persons().countDocuments({});
      assert.strictEqual(count, 1400, `expected 1400 docs, got ${count}`);

      const { search } = require('../src/main/search');
      const byNc = await search(db.persons(), '1000000000');
      assert.strictEqual(byNc.candidates.length, 1);
      assert.strictEqual(byNc.candidates[0].nationalCode, '1000000000');

      const firstDoc = await db.persons().findOne({ nationalCode: '1000000000' });
      const firstNameToken = firstDoc.fullName.split(' ')[0];
      const byName = await search(db.persons(), firstNameToken);
      assert.ok(byName.candidates.length >= 1, 'name search returned nothing');

      await db.persons().deleteMany({});
    });
    await db.close();
  }

  console.log(`\n${passed} check(s) passed${process.exitCode ? ' (with failures)' : ''}.`);
})().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
