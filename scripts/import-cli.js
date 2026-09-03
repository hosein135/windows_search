'use strict';

/**
 * Headless importer:  npm run import -- [--dir databases] [--batch 5000]
 * The GUI offers GPU text normalization; the CLI always uses the CPU folder
 * (same normalize.js rules) because WebGPU needs the renderer.
 */

const path = require('path');
const db = require('../src/main/db');
const { scanCsvFiles, importAll } = require('../src/main/importer');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async function main() {
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', 'databases')));
  const batchSize = Number(arg('batch', 5000));

  console.log(`[import] scanning ${dir}`);
  const files = scanCsvFiles(dir);
  const known = files.filter((f) => f.known);
  if (!known.length) {
    console.log('[import] no known CSV layouts found. Drop the dumps into databases\\');
    console.log('         or generate demo data with:  npm run make-sample');
    process.exit(0);
  }
  for (const f of files) {
    console.log(`  ${f.known ? 'OK ' : 'SKIP'}  ${f.folder}\\${f.name}  (${(f.sizeBytes / 1e6).toFixed(1)} MB, ${f.sourceLabel})`);
  }

  console.log(`[import] connecting to ${db.DEFAULT_URL} db=${db.DB_NAME}`);
  await db.connect();
  await db.ensureIndexes();

  const started = Date.now();
  const totals = await importAll(dir, {
    col: db.persons(),
    batchSize,
    onProgress: (p) => {
      if (p.phase === 'progress') {
        process.stdout.write(
          `\r[import] ${p.file}: ${p.rows.toLocaleString()} rows, ` +
          `${p.persons.toLocaleString()} persons, ${p.rowsPerSec.toLocaleString()} rows/s   `,
        );
      } else if (p.phase === 'done' || p.phase === 'cancelled') {
        process.stdout.write('\n');
        console.log(`[import] ${p.file} ${p.phase}: rows=${p.rows} persons=${p.persons} skipped=${p.skipped} errors=${p.errors}`);
      }
    },
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[import] finished in ${secs}s: files=${totals.done}/${totals.files} rows=${totals.rows} persons=${totals.persons} skipped=${totals.skipped} errors=${totals.errors}`);
  const st = await db.status();
  console.log(`[import] collection now holds ~${st.persons.toLocaleString()} person documents`);
  await db.close();
})().catch((err) => {
  console.error('[import] failed:', err.message);
  process.exit(1);
});
