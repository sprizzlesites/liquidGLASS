// Node harness (via a real browser page, since vmterm.js is a classic script
// that reads/writes SprizzleIDE.html's global `S`, `fileGetBytes`,
// `fileSetBytes`, `tw`, `addGitChange`, `renderTree`, `renderTabs`): proves
// VMTerm.syncIn()/syncOut() correctly bridge S.files <-> a 9p-shaped
// filesystem, binary-safely, WITHOUT booting a real v86 emulator — a fake
// in-memory `_fs` stub (implementing the {mkdir,write,read,readdir} contract
// documented in vm/vmterm.js) is injected directly via VMTerm._fs, and
// VMTerm._mode is forced to 'linux9p' so the sync paths don't early-exit
// with the "requires the Linux VM image" floppy-mode message.
// Run: node tests/vm/sync-bridge.mjs   (exits 0 on pass)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import url from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const PORT = 8802;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('http.server did not start in time')), 10000);
    proc.stdout.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    setTimeout(() => { clearTimeout(t); resolve(); }, 1200);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += String(d); });
  await waitForServer(server);

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('console', msg => {
      const text = msg.text();
      if (/fontawesome|webllm|cdn\./i.test(text)) return;
      if (msg.type() === 'error') console.log('[page error]', text);
    });

    await page.goto(`http://127.0.0.1:${PORT}/SprizzleIDE.html`, { waitUntil: 'domcontentloaded' });

    // Load vmterm.js as a plain classic script (not through the full lazy
    // loader — we don't need xterm/libv86 for this test, only the sync
    // bridge, which never touches Terminal/V86 at module-eval time).
    await page.addScriptTag({ path: path.join(root, 'vm/vmterm.js') });
    await page.waitForFunction(() => !!window.VMTerm, { timeout: 5000 });

    const result = await page.evaluate(async () => {
      // ── in-memory fake 9p filesystem, matching the {mkdir,write,read,
      // readdir} contract VMTerm._fs expects ──────────────────────────────
      function makeStubFs() {
        const store = new Map();
        store.set('project', { isDir: true });
        return {
          async mkdir(p) {
            const parts = p.split('/').filter(Boolean);
            let cur = '';
            for (const part of parts) { cur = cur ? cur + '/' + part : part; if (!store.has(cur)) store.set(cur, { isDir: true }); }
          },
          async write(p, bytes) {
            const parts = p.split('/').filter(Boolean);
            const dir = parts.slice(0, -1).join('/');
            if (dir) await this.mkdir(dir);
            store.set(p, { isDir: false, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });
          },
          async read(p) {
            const e = store.get(p);
            if (!e || e.isDir) return null;
            return e.bytes;
          },
          async readdir(p) {
            const prefix = p ? p + '/' : '';
            const names = new Set();
            for (const key of store.keys()) {
              if (key === p || !key.startsWith(prefix)) continue;
              names.add(key.slice(prefix.length).split('/')[0]);
            }
            return Array.from(names).map(name => {
              const full = prefix + name;
              const e = store.get(full);
              return { name, isDir: e ? e.isDir : true };
            });
          },
          _store: store,
        };
      }

      const stub = makeStubFs();
      VMTerm._fs = stub;
      VMTerm._mode = 'linux9p';

      // ── seed S.files with one text file and one binary file ────────────
      const binBytes = [0, 1, 255, 66, 73, 78]; // arbitrary bytes incl. NUL + 0xff, then "BIN"
      const binB64 = btoa(String.fromCharCode(...binBytes));
      S.files = {
        'a.txt': { content: 'hi', lang: 'Plain Text', modified: false },
        'img.bin': { content: binB64, b64: true, lang: 'binary', modified: false },
      };
      S.gitChanges = [];

      const out = { steps: [] };

      // ── syncIn: S.files -> stub fs ──────────────────────────────────────
      const syncInOk = await VMTerm.syncIn();
      out.syncInOk = syncInOk;
      const aEntry = stub._store.get('project/a.txt');
      const imgEntry = stub._store.get('project/img.bin');
      out.aWritten = aEntry ? Array.from(aEntry.bytes) : null;
      out.imgWritten = imgEntry ? Array.from(imgEntry.bytes) : null;

      // ── mutate the stub fs as if the guest had done work ────────────────
      const enc = s => new TextEncoder().encode(s);
      await stub.write('project/new.txt', enc('created in vm'));
      await stub.write('project/sub/deep.txt', enc('nested file'));
      const mutatedBin = [9, 9, 9, 255, 0];
      await stub.write('project/img.bin', new Uint8Array(mutatedBin));
      await stub.write('project/.sprz-sync', enc('marker-touch-1'));

      // ── syncOut: stub fs -> S.files ──────────────────────────────────────
      const syncOutOk = await VMTerm.syncOut();
      out.syncOutOk = syncOutOk;
      out.finalFiles = Object.fromEntries(Object.entries(S.files).map(([k, v]) => [k, { content: v.content, b64: !!v.b64, lang: v.lang }]));
      out.gitChanges = S.gitChanges.slice();
      out.hasMarkerFile = '.sprz-sync' in S.files;

      // ── also check the honest floppy-mode message ───────────────────────
      VMTerm._fs = null;
      VMTerm._mode = 'floppy';
      const floppySyncIn = await VMTerm.syncIn();
      out.floppySyncInOk = floppySyncIn;

      return out;
    });

    // ── Node-side assertions ────────────────────────────────────────────
    assert(result.syncInOk === true, 'syncIn() should return true');
    assert(JSON.stringify(result.aWritten) === JSON.stringify(Array.from(Buffer.from('hi', 'utf8'))), 'a.txt bytes written to stub fs should be UTF-8 "hi": got ' + JSON.stringify(result.aWritten));
    assert(JSON.stringify(result.imgWritten) === JSON.stringify([0, 1, 255, 66, 73, 78]), 'img.bin bytes written to stub fs should match the original binary payload: got ' + JSON.stringify(result.imgWritten));

    assert(result.syncOutOk === true, 'syncOut() should return true');
    assert(result.hasMarkerFile === false, '.sprz-sync marker must NOT be imported into S.files');

    const ff = result.finalFiles;
    assert(ff['a.txt'] && ff['a.txt'].content === 'hi' && ff['a.txt'].b64 === false, 'a.txt should remain a plain-text entry after syncOut: ' + JSON.stringify(ff['a.txt']));
    assert(ff['new.txt'] && ff['new.txt'].content === 'created in vm' && ff['new.txt'].b64 === false, 'new.txt (guest-created, valid UTF-8) should be stored as plain text: ' + JSON.stringify(ff['new.txt']));
    assert(ff['sub/deep.txt'] && ff['sub/deep.txt'].content === 'nested file', 'nested project/sub/deep.txt should sync back as sub/deep.txt: ' + JSON.stringify(ff['sub/deep.txt']));
    assert(ff['img.bin'] && ff['img.bin'].b64 === true && ff['img.bin'].lang === 'binary', 'img.bin (mutated, contains NUL) should be stored base64: ' + JSON.stringify(ff['img.bin']));
    const decoded = Buffer.from(ff['img.bin'].content, 'base64');
    assert(JSON.stringify(Array.from(decoded)) === JSON.stringify([9, 9, 9, 255, 0]), 'img.bin base64 content should decode to the mutated bytes: got ' + JSON.stringify(Array.from(decoded)));

    const imgChange = result.gitChanges.find(c => c.path === 'img.bin');
    const newChange = result.gitChanges.find(c => c.path === 'new.txt');
    assert(imgChange && imgChange.status === 'M', 'img.bin (pre-existing) should be recorded as a git "M" change: ' + JSON.stringify(imgChange));
    assert(newChange && newChange.status === 'A', 'new.txt (did not exist before syncOut) should be recorded as a git "A" change: ' + JSON.stringify(newChange));

    assert(result.floppySyncInOk === false, 'syncIn() with no _fs (floppy/testos mode) must honestly report failure, not silently succeed');

    console.log('PASS: sync-bridge.mjs — syncIn/syncOut binary-safe round-trip through a fake 9p stub, marker file excluded, git-change status correct, floppy-mode honesty verified');
    process.exitCode = 0;
  } catch (e) {
    console.error('FAIL:', e && e.stack ? e.stack : e);
    if (serverErr) console.error('--- http.server stderr ---\n' + serverErr);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main();
