/**
 * Post-build fixups. Two jobs, both about making the published package resolve
 * correctly for consumers.
 *
 * 1. `dist/cjs/package.json`
 *    The root package.json says `"type": "module"`, which would otherwise make
 *    every `.js` file under dist/cjs ESM — including the CommonJS build. A
 *    scoped `{"type": "commonjs"}` overrides it for that subtree. This is the
 *    standard dual-publish fix, and it beats renaming everything to `.cjs`,
 *    which would invalidate the relative paths TypeScript emitted.
 *
 * 2. Rewrite `.ts` specifiers in declaration files
 *    Source files import each other as `./foo.ts` so Node's type stripping can
 *    run them directly. `rewriteRelativeImportExtensions` fixes those up to
 *    `.js` in the emitted JavaScript, but as of TypeScript 5.9 it does not do
 *    the same inside `.d.ts` output. Left alone, a consumer's compiler follows
 *    `./errors.ts` into dist, finds no such file, and every type resolves to
 *    `any`. Rewriting them here is what keeps `--pack` type checks green.
 */
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const cjsDir = join(dist, 'cjs');

try {
  await access(dist);
} catch {
  console.error('dist/ not found — run the builds first.');
  process.exit(1);
}

/** Yields every file under `dir` matching `predicate`. */
async function* walk(dir, predicate) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, predicate);
    } else if (predicate(entry.name)) {
      yield full;
    }
  }
}

// Matches only *relative* specifiers ending in `.ts`, in both `from '...'` and
// `import('...')` position. Bare package specifiers are left alone.
const RELATIVE_TS = /(from\s*['"]|import\(\s*['"])(\.[^'"]*?)\.ts(['"])/g;

let rewritten = 0;
for await (const file of walk(dist, (n) => n.endsWith('.d.ts'))) {
  const src = await readFile(file, 'utf8');
  const out = src.replace(RELATIVE_TS, '$1$2.js$3');
  if (out !== src) {
    await writeFile(file, out);
    rewritten++;
  }
}

await writeFile(join(cjsDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

// Fail loudly rather than shipping a package whose types silently degrade to
// `any` — that failure is invisible until a user reports it.
const leftovers = [];
for await (const file of walk(dist, (n) => n.endsWith('.d.ts') || n.endsWith('.js'))) {
  const src = await readFile(file, 'utf8');
  if (RELATIVE_TS.test(src)) leftovers.push(file);
  RELATIVE_TS.lastIndex = 0;
}
if (leftovers.length > 0) {
  console.error('Unrewritten .ts specifiers remain in:', leftovers);
  process.exit(1);
}

console.log(`fixup: rewrote ${rewritten} declaration file(s); dist/cjs/package.json written`);
