/**
 * Bundle-size budget check.
 *
 * Measures what a consumer actually downloads per entry point: the entry plus
 * everything it transitively imports, minified-ish and gzipped. CI fails when a
 * budget is exceeded, so bloat is caught in the PR that causes it rather than in
 * a bug report six months later.
 *
 * "Minified-ish" is honest labelling — this strips comments and indentation with
 * `node:zlib` and no bundler, so figures run slightly above what esbuild or
 * terser would produce. Treating them as an upper bound is the point.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const distEsm = fileURLToPath(new URL('../dist/esm', import.meta.url));

/** Gzipped byte budgets per entry point. */
// Set roughly 30% above the current measured size: loose enough not to fail on
// an ordinary change, tight enough that accidental bloat is caught in the PR
// that introduces it rather than in a bug report months later.
const BUDGETS = {
  '.': 30_000,
  './mp3': 23_000,
  './flac': 16_000,
  './analyze': 6_000,
  './stream': 17_000,
  './worker': 4_000,
};

const ENTRIES = {
  '.': 'index.js',
  './mp3': 'mp3/index.js',
  './flac': 'flac/index.js',
  './analyze': 'analyze/index.js',
  './stream': 'stream/index.js',
  './worker': 'worker/index.js',
};

/** Removes comments and leading indentation. Not a real minifier; see the note above. */
function crudeMinify(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Walks the static import graph from an entry file. */
async function collect(entryPath, seen = new Set()) {
  const abs = resolve(entryPath);
  if (seen.has(abs)) return seen;
  if (!(await exists(abs))) return seen;
  seen.add(abs);

  const src = await readFile(abs, 'utf8');
  const importRe = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    await collect(join(dirname(abs), m[1]), seen);
  }
  return seen;
}

let failed = false;
const rows = [];

if (!(await exists(distEsm))) {
  console.error('dist/esm not found — run `npm run build` first.');
  process.exit(1);
}

for (const [name, rel] of Object.entries(ENTRIES)) {
  const entry = join(distEsm, rel);
  if (!(await exists(entry))) continue;

  const files = await collect(entry);
  let source = '';
  for (const f of files) {
    if (f.endsWith('.d.ts') || f.endsWith('.map')) continue;
    source += await readFile(f, 'utf8');
  }

  const raw = Buffer.byteLength(source);
  const gzip = gzipSync(Buffer.from(crudeMinify(source)), { level: 9 }).byteLength;
  const budget = BUDGETS[name];
  const over = budget != null && gzip > budget;
  if (over) failed = true;

  rows.push({
    entry: `audiobox${name === '.' ? '' : name.slice(1)}`,
    files: files.size,
    raw: `${(raw / 1024).toFixed(1)} kB`,
    gzip: `${(gzip / 1024).toFixed(1)} kB`,
    budget: budget ? `${(budget / 1024).toFixed(1)} kB` : '—',
    status: over ? 'OVER' : 'ok',
  });
}

console.table(rows);

// Unbuilt entry points would silently pass an empty budget check, so make the
// absence loud rather than reporting a misleading all-clear.
const built = rows.length;
const expected = Object.keys(ENTRIES).length;
if (built < expected) {
  console.warn(`\nNote: ${expected - built} entry point(s) not built yet; not measured.`);
}

if (failed) {
  console.error('\nBundle size budget exceeded.');
  process.exit(1);
}
