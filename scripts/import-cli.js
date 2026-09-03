'use strict';

/**
 * Headless importer with multiple acceleration modes:
 *
 *   bun run import                                    # sequential, file-by-file
 *   bun run import -- --parallel                      # all CPU cores: chunked files + direct writes
 *   bun run import -- --parallel --workers 4          # parallel, 4 worker threads
 *   bun run import -- --parallel --inflight 3         # 3 concurrent bulkWrites per worker
 *   bun run import -- --parallel --chunk-mb 64        # force 64 MB chunks (default: auto)
 *   bun run import -- --parallel --no-split           # one task per file (no chunking)
 *   bun run import -- --file "Bank Mellat DB1.csv"    # single file (chunked when --parallel)
 *   bun run import -- --parallel --file "935-1.csv" --file "936-1.csv"
 *   bun scripts/import-cli.js --parallel              # same as import:parallel, no extra npm layer
 *
 * The GUI offers GPU text normalization; the CLI always uses the CPU folder
 * (same normalize.js rules) because WebGPU needs a Chromium renderer.
 */

const os = require('os');
const path = require('path');
const db = require('../src/main/db');
const { scanCsvFiles, importFile } = require('../src/main/importer');
const { parallelImport, planTasks, DEFAULT_WORKERS, DEFAULT_INFLIGHT } = require('../src/main/parallelImporter');

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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtMB(bytes) { return `${(bytes / 1e6).toFixed(1)} MB`; }

(async function main() {
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', 'databases')));
  const batchSize = Number(arg('batch', 5000));
  const specificFiles = argList('file');
  const useParallel = hasFlag('parallel');
  const workers = Number(arg('workers', DEFAULT_WORKERS));
  const inflight = Number(arg('inflight', DEFAULT_INFLIGHT));
  const chunkBytes = Math.round(Number(arg('chunk-mb', 0)) * 1024 * 1024);
  const split = !hasFlag('no-split');
  const runtime = typeof Bun !== 'undefined' ? 'bun' : 'node';

  console.log(`[import] runtime: ${runtime} ${process.version || Bun.version}`);
  console.log(`[import] CPUs: ${os.cpus().length} logical threads`);
  console.log(`[import] mode: ${useParallel ? `parallel (${workers} workers, ${inflight} in-flight writes each)` : 'sequential (1 thread, pipelined writes)'}`);
  console.log(`[import] scanning ${dir}`);

  const files = scanCsvFiles(dir);
  const known = files.filter((f) => f.known);

  // If --file was given, import only those files
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
    console.log('         or generate demo data with:  bun run make-sample');
    process.exit(0);
  }
  for (const f of toImport) {
    console.log(`  ${f.known ? 'OK ' : 'SKIP'}  ${f.folder}\\${f.name}  (${fmtMB(f.sizeBytes)}, ${f.sourceLabel})`);
  }

  console.log(`[import] connecting to ${db.DEFAULT_URL} db=${db.DB_NAME}`);
  await db.connect();
  await db.ensureIndexes();

  const started = Date.now();

  if (useParallel) {
    // === PARALLEL MODE: every core parses a chunk and writes to MongoDB ===
    const plan = planTasks(toImport, { workers, chunkBytes, split });
    const activeWorkers = Math.min(workers, plan.tasks.length);
    console.log(`[import] plan: ${plan.tasks.length} chunk task(s) over ${toImport.length} file(s), ` +
      `chunk size ${fmtMB(plan.chunkBytes)}, ${activeWorkers} worker thread(s) x ${inflight} in-flight writes ` +
      `= up to ${activeWorkers * inflight} concurrent bulkWrites`);
    for (const f of toImport) {
      const n = plan.tasks.filter((t) => t.file === f.path).length;
      if (n > 1) console.log(`         ${f.name}: ${n} chunks`);
    }

    const fileProgress = new Map(); // fileName -> last snapshot
    let lastPrint = 0;
    const totals = await parallelImport(dir, {
      files: toImport.map((f) => f.path),
      workers,
      inflight,
      batchSize,
      chunkBytes,
      split,
      mongoUrl: db.DEFAULT_URL,
      dbName: db.DB_NAME,
      collection: db.PERSONS_COLLECTION,
      onProgress: (p) => {
        if (p.phase === 'progress') {
          fileProgress.set(p.file, p);
          const now = Date.now();
          if (now - lastPrint < 500) return; // throttle console output
          lastPrint = now;
          const lines = [...fileProgress.values()].map((st) => {
            const pct = st.bytesTotal ? ` ${Math.min(100, Math.round((100 * st.bytes) / st.bytesTotal))}%` : '';
            return `  ${st.file}: ${st.rows.toLocaleString()} rows, ${st.persons.toLocaleString()} persons, ` +
              `${st.rowsPerSec.toLocaleString()} rows/s, chunks ${st.chunksDone}/${st.chunks}${pct}`;
          });
          process.stdout.write(`${lines.join('\n')}\n`);
        } else if (p.phase === 'file-done') {
          console.log(`[import] ${p.file} done: rows=${p.stats.rows} persons=${p.stats.persons} skipped=${p.stats.skipped} errors=${p.stats.errors}`);
          fileProgress.delete(p.file);
        } else if (p.phase === 'task-start') {
          console.log(`[import] chunk ${p.chunkIndex + 1}/${p.chunks} of ${p.file} started (${fmtMB(p.bytes)})`);
        } else if (p.phase === 'task-error') {
          console.log(`[import] chunk ${(p.chunkIndex || 0) + 1} of ${p.file} FAILED: ${p.error}`);
        } else if (p.phase === 'task-retry') {
          console.log(`[import] worker died on ${p.file} (${p.error}); retrying chunk on a fresh worker`);
        }
      },
    });

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[import] parallel import finished in ${secs}s: files=${totals.done}/${totals.files} tasks=${totals.tasksDone}/${totals.tasks} ` +
      `rows=${totals.rows} persons=${totals.persons} skipped=${totals.skipped} errors=${totals.errors} ` +
      `(${Math.round(totals.rows / Math.max(0.001, secs)).toLocaleString()} rows/s aggregate)`);
  } else {
    // === SEQUENTIAL MODE: file-by-file, parse overlapped with pipelined writes ===
    for (const f of toImport) {
      console.log(`[import] --- ${f.name} ---`);
      const stats = await importFile(f, {
        col: db.persons(),
        batchSize,
        inflight,
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
    console.log(`[import] sequential import finished in ${secs}s`);
  }

  const st = await db.status();
  console.log(`[import] collection now holds ~${st.persons.toLocaleString()} person documents`);
  await db.close();
})().catch((err) => {
  console.error('[import] failed:', err.message);
  process.exit(1);
});
