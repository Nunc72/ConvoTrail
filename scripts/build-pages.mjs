// Builds the GitHub Pages site into _site/ from index.html.
//
// index.html stays the source of truth and stays directly runnable for
// local dev (in-browser Babel, Tailwind Play CDN, React dev builds).
// For production this script precompiles what the browser used to do
// on every single page load:
//   - the one <script type="text/babel"> block → app.js, compiled by the
//     very same @babel/standalone (pinned to the version the CDN served)
//     with the very same options it applies to a script tag, so runtime
//     semantics are identical — just no ~650 KB Babel download and no
//     multi-second compile per start. (A modern-syntax build would turn
//     latent use-before-define spots, which the ES5 `var` output hides,
//     into TDZ crashes.)
//   - Tailwind utilities → static tailwind.css, same v3.4.17 the Play
//     CDN serves, linked right after polish.css where the Play CDN
//     appended its <style> — so the cascade is unchanged
//   - React 18.3.1 development UMD → production UMD
//
// Every rewrite asserts it matched exactly once; any surprise fails the
// build (and therefore the deploy) instead of shipping a half-rewritten
// site.

import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const Babel = createRequire(import.meta.url)('@babel/standalone');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');
const BABEL_BLOCK = /<script type="text\/babel">([\s\S]*?)<\/script>/g;

function fail(msg) {
  console.error(`[build-pages] FAILED: ${msg}`);
  process.exit(1);
}

function replaceOnce(haystack, needle, replacement, label) {
  const at = haystack.indexOf(needle);
  if (at === -1) fail(`${label}: not found`);
  if (haystack.indexOf(needle, at + needle.length) !== -1) fail(`${label}: found more than once`);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// The auto-update checks compare APP_VERSION, polish.css ?v= and
// version.json; if they disagree clients redirect on every start.
const appVersion = html.match(/const APP_VERSION = "([^"]+)"/)?.[1];
const polishVersion = html.match(/href="polish\.css\?v=([^"]+)"/)?.[1];
const jsonVersion = JSON.parse(await readFile(join(ROOT, 'version.json'), 'utf8')).version;
if (!appVersion) fail('APP_VERSION not found in index.html');
if (appVersion !== polishVersion || appVersion !== jsonVersion) {
  fail(`version mismatch: APP_VERSION=${appVersion}, polish.css?v=${polishVersion}, version.json=${jsonVersion}`);
}

const blocks = [...html.matchAll(BABEL_BLOCK)];
if (blocks.length !== 1) fail(`expected exactly one <script type="text/babel">, found ${blocks.length}`);

// presets/plugins/targets mirror buildBabelOptions() in @babel/standalone
// for a plain <script type="text/babel">; with exactly those options this
// produces byte-for-byte the code the browser used to generate. compact is
// what the browser already fell back to (input > 500 KB); dropping comments
// is the only difference. Loaded as a classic <script>, so top-level
// declarations stay global — exactly like the script Babel injected.
const compiled = Babel.transform(blocks[0][1], {
  filename: 'app.jsx',
  presets: ['react', 'env'],
  plugins: ['transform-class-properties', 'transform-object-rest-spread', 'transform-flow-strip-types'],
  targets: { browsers: undefined },
  sourceMaps: true,
  sourceFileName: 'app.jsx',
  compact: true,
  comments: false,
});
if (!compiled.code.includes('createRoot(')) fail('compiled app.js has no createRoot( — did the mount line move?');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'app.js'), `${compiled.code}\n//# sourceMappingURL=app.js.map\n`);
await writeFile(join(OUT, 'app.js.map'), JSON.stringify(compiled.map));

// Tailwind scans the source index.html (JSX class strings + static
// markup) and emits only the utilities that actually occur. Deliberately
// not --minify: cssnano merges and splits rules, while the unminified
// output matches the Play CDN's rule for rule (gzip makes up the size).
const twInput = join(OUT, '.tailwind-input.css');
await writeFile(twInput, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
execFileSync(join(ROOT, 'node_modules', '.bin', 'tailwindcss'),
  ['-i', twInput, '-o', join(OUT, 'tailwind.css'), '--content', join(ROOT, 'index.html')],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
await rm(twInput);

// The JSX block goes first: its srcDoc templates contain "</head>" and
// CDN-looking strings that must not trip the replaceOnce checks below.
let out = html.replace(BABEL_BLOCK, () => `<script defer src="app.js?v=${appVersion}"></script>`);
out = replaceOnce(out, '<script defer src="https://cdn.tailwindcss.com"></script>', '', 'Tailwind Play CDN tag');
out = replaceOnce(out, '<script defer src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>', '', 'Babel standalone tag');
out = replaceOnce(out, 'https://unpkg.com/react@18/umd/react.development.js',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js', 'React UMD');
out = replaceOnce(out, 'https://unpkg.com/react-dom@18/umd/react-dom.development.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js', 'ReactDOM UMD');
out = replaceOnce(out, '</head>', `  <link rel="stylesheet" href="tailwind.css?v=${appVersion}"/>\n</head>`, '</head>');
for (const leftover of ['type="text/babel"', 'babel.min.js', 'cdn.tailwindcss.com', '.development.js']) {
  if (out.includes(leftover)) fail(`built index.html still contains ${leftover}`);
}
await writeFile(join(OUT, 'index.html'), out);

// Static assets: the tracked top-level files, i.e. what the old
// "upload the repo root" deploy served, minus build tooling and the
// source index.html. Subdirectories (backend/, scripts/) are not part
// of the site.
const SKIP = new Set(['index.html', 'package.json', 'package-lock.json']);
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(f => f && !f.includes('/') && !f.startsWith('.') && !SKIP.has(f));
for (const f of tracked) await copyFile(join(ROOT, f), join(OUT, f));

const kb = s => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
const css = await readFile(join(OUT, 'tailwind.css'), 'utf8');
console.log(`[build-pages] v${appVersion}: app.js ${kb(compiled.code)}, tailwind.css ${kb(css)}, index.html ${kb(out)}, ${tracked.length} static files → _site/`);
