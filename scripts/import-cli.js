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

function argList(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) {
      out.push(process.argv[i + 1]);
    }
  }
  return out;
}

(async function main() {
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', 'databases')));
  const batchSize = Number(arg('batch', 5000));
  const specificFiles = argList('file');

  console.log(`[import] scanning ${dir}`);
  const files = scanCsvFiles(dir);
  const known = files.filter((f) => f.known);

  // If --file was given, import only those files (file-by-file mode)
  let toImport;
  if (specificFiles.length) {
    toImport = known.filter((f) =>
      specificFiles.some((sf) => f.path.endsWith(sf) || f.name === path.basename(sf)));
    if (!toImport.length) {
      console.log(`[import] no matching files for: ${specificFiles.join(', ')}`);
      process.exit(0);
    }
    console.log(`[import] file-by-file mode: ${toImport.length} file(s) selected`);
  } else {
    toImport = known;
  }

  if (!toImport.length) {
    console.log('[import] no known CSV layouts found. Drop the dumps into databases\\');
    console.log('         or generate demo data with:  npm run make-sample');
    process.exit(0);
  }
  for (const f of toImport) {
    console.log(`  ${f.known ? 'OK ' : 'SKIP'}  ${f.folder}\\${f.name}  (${(f.sizeBytes / 1e6).toFixed(1)} MB, ${f.sourceLabel})`);
  }

  console.log(`[import] connecting to ${db.DEFAULT_URL} db=${db.DB_NAME}`);
  await db.connect();
  await db.ensureIndexes();

  const started = Date.now();
  // Import file by file so the user sees results after each file
  for (const f of toImport) {
    const { importFile } = require('../src/main/importer');
    console.log(`[import] --- ${f.name} ---`);
    const stats = await importFile(f, {
      col: db.persons(),
      batchSize,
      onProgress: (p) => {
        if (p.phase === 'progress') {
          process.stdout.write(
            `\r[import] ${p.file}: ${p.rows.toLocaleString()} rows, ` +
            `${p.persons.toLocaleString()} persons, ${p.rowsPerSec.toLocaleString()} rows/s   `,
          );
        }
      },
    });
    process.stdout.write('\n');
    console.log(`[import] ${f.name} done: rows=${stats.rows} persons=${stats.persons} skipped=${stats.skipped} errors=${stats.errors}`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const st = await db.status();
  console.log(`[import] finished in ${secs}s. Collection now holds ~${st.persons.toLocaleString()} person documents`);
  await db.close();
})().catch((err) => {
  console.error('[import] failed:', err.message);
  process.exit(1);
});
