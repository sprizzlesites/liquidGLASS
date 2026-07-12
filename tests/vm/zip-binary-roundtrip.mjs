// Node harness: proves SprizzleIDE's binary-safe ZIP export (buildProjectZip
// in SprizzleIDE.html) round-trips a binary file byte-identically.
//
// buildProjectZip(files, ZipCtor) is a pure (no-DOM) helper factored out of
// exportProjectZip() specifically so it can be exercised here against a real
// JSZip without duplicating its logic: rather than hand-copying the zip-build
// loop into this test (which would silently drift from the real
// implementation over time), we regex the function's exact source text out
// of SprizzleIDE.html and eval it. The function is a single source line with
// no embedded newlines (repo style), so `/^function buildProjectZip\(files,ZipCtor\)\{.*\}$/m`
// greedily matches from `function` to the LAST `}` on that line, which is
// exactly its closing brace.
//
// JSZip itself is fetched from the npm registry into a scratchpad directory
// (never into the repo's node_modules — see docs/ORCHESTRATION.md rules) via:
//   cd <scratchpad>/zip-test && npm init -y && npm install jszip
// Run: node tests/vm/zip-binary-roundtrip.mjs   (exits 0 on pass)
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const require_ = createRequire(import.meta.url);

function loadJSZip() {
  const candidates = [
    'jszip', // normal resolution, e.g. if a devDependency is ever added properly
    process.env.SPRZ_JSZIP_PATH,
    '/tmp/claude-0/-home-user-liquidGLASS/82d04b29-dbce-5039-8bbd-5e80ffff6508/scratchpad/zip-test/node_modules/jszip',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require_(c); } catch (e) { /* try next */ }
  }
  throw new Error(
    'JSZip not found for the node test. Install it into a scratchpad dir (never tracked in the repo):\n' +
    '  mkdir -p <scratchpad>/zip-test && cd <scratchpad>/zip-test && npm init -y && npm install jszip\n' +
    'then either rely on the default candidate path in this file or set SPRZ_JSZIP_PATH to the install location.'
  );
}

function extractBuildProjectZip(htmlSrc) {
  const m = htmlSrc.match(/^function buildProjectZip\(files,ZipCtor\)\{.*\}$/m);
  if (!m) throw new Error('Could not find buildProjectZip(files,ZipCtor){...} as a single source line in SprizzleIDE.html — did its source formatting change?');
  // indirect eval so it runs in global scope, no closure surprises
  return (0, eval)('(' + m[0] + ')');
}

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const JSZip = loadJSZip();
  const htmlSrc = fs.readFileSync(path.join(root, 'SprizzleIDE.html'), 'utf8');
  const buildProjectZip = extractBuildProjectZip(htmlSrc);

  const textContent = '#!/bin/sh\necho "plain text project file"\n';
  const pngBytes = crypto.randomBytes(1024); // pseudo-PNG: 1KB of random bytes, byte-for-byte is all that matters here
  const pngB64 = pngBytes.toString('base64');

  const files = {
    'run.sh': { content: textContent, lang: 'Shell', modified: false },
    'assets/logo.png': { content: pngB64, b64: true, lang: 'binary', modified: false },
  };

  const zip = buildProjectZip(files, JSZip);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  const reloaded = await JSZip.loadAsync(buf);
  const textOut = await reloaded.file('run.sh').async('string');
  const pngOut = await reloaded.file('assets/logo.png').async('uint8array');

  assert(textOut === textContent, 'run.sh text should round-trip byte-identically through the zip: got ' + JSON.stringify(textOut));
  assert(pngOut.length === pngBytes.length, `assets/logo.png length mismatch: expected ${pngBytes.length}, got ${pngOut.length}`);
  assert(Buffer.compare(Buffer.from(pngOut), pngBytes) === 0, 'assets/logo.png bytes must be byte-identical after zip export+reimport (this is the binary-safety guarantee under test)');

  console.log(`PASS: zip-binary-roundtrip.mjs — text file (${textContent.length}B) and binary file (${pngBytes.length}B) both round-tripped byte-identically through buildProjectZip()`);
  process.exitCode = 0;
}

main().catch(e => { console.error('FAIL:', e && e.stack ? e.stack : e); process.exitCode = 1; });
