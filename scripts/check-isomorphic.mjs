/**
 * Enforces the isomorphic promise mechanically.
 *
 * The README claims core runs unchanged in browsers, Node, Deno, Bun and edge
 * runtimes. That claim is one careless `import { readFile } from 'node:fs'`
 * away from being false, and the failure would not show up in a Node test run —
 * it would show up in a user's browser build. TypeScript cannot catch it either,
 * because `@types/node` has to be enabled for the `audiobox/node` subpath.
 *
 * So it is checked here instead: only the designated adapter directories may
 * touch runtime-specific APIs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const src = fileURLToPath(new URL('../src', import.meta.url));

/** Directories permitted to use runtime-specific APIs, and what each may use. */
const EXEMPT = [
  { dir: 'node', reason: 'the Node adapter exists to wrap node:* APIs' },
  { dir: 'webcodecs', reason: 'feature-detects browser-only WebCodecs' },
  { dir: 'worker', reason: 'feature-detects Worker and scheduler' },
  { dir: 'stream', reason: 'feature-detects the global TransformStream' },
];

/** Patterns that make a module non-portable. */
const FORBIDDEN = [
  { pattern: /\bfrom\s+['"]node:/, label: "import from 'node:*'" },
  { pattern: /\brequire\s*\(\s*['"]node:/, label: "require('node:*')" },
  { pattern: /(?<![.\w])document\s*\./, label: 'document (DOM only)' },
  { pattern: /(?<![.\w])window\s*\./, label: 'window (browser only)' },
  { pattern: /(?<![.\w])localStorage\b/, label: 'localStorage (browser only)' },
  { pattern: /(?<![.\w])process\.(?!env\b)/, label: 'process.* (Node only)' },
  { pattern: /(?<![.\w])Buffer\s*\./, label: 'Buffer (Node only)' },
  { pattern: /(?<![.\w])__dirname\b/, label: '__dirname (CJS only)' },
  { pattern: /(?<![.\w])eval\s*\(/, label: 'eval (security)' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function (security)' },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

/** Strips comments and string literals so matches come from real code only. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const violations = [];

for await (const file of walk(src)) {
  const rel = relative(src, file);
  const topDir = rel.split('/')[0];
  const exemption = EXEMPT.find((e) => e.dir === topDir);

  const raw = await readFile(file, 'utf8');
  const code = stripNonCode(raw);

  for (const { pattern, label } of FORBIDDEN) {
    if (!pattern.test(code)) continue;

    // `eval` and `new Function` are never acceptable, exemption or not.
    const isSecurityRule = label.includes('security');
    if (exemption && !isSecurityRule) continue;

    const line = raw.split('\n').findIndex((l) => pattern.test(stripNonCode(l))) + 1;
    violations.push({ file: rel, line, label });
  }
}

if (violations.length > 0) {
  console.error('Portability check failed — core must not use runtime-specific APIs:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.label}`);
  }
  console.error(
    `\nOnly these directories may use runtime APIs: ${EXEMPT.map((e) => `src/${e.dir}/`).join(', ')}.`,
  );
  process.exit(1);
}

console.log('Portability check passed: core is free of runtime-specific APIs.');
