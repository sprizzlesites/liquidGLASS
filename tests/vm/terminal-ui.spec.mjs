// Playwright smoke test: VM panel tab lazy-loads xterm+v86, boots the vendored
// floppy test OS (no manifest.json present yet => floppy fallback), and proves
// the serial round-trip works end-to-end through the real browser DOM/UI (not
// just the node harness in boot-testos.mjs).
// Run: node tests/vm/terminal-ui.spec.mjs   (exits 0 on pass)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import url from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const PORT = 8801;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('http.server did not start in time')), 10000);
    proc.stdout.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    // python's http.server logs to stderr by default; give it a moment either way
    setTimeout(() => { clearTimeout(t); resolve(); }, 1200);
  });
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += String(d); });
  await waitForServer(server);

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    page.on('console', msg => {
      const text = msg.text();
      // CDN loads (fontawesome/webllm) are expected to fail in this sandbox — ignore that noise.
      if (/fontawesome|webllm|cdn\./i.test(text)) return;
      if (msg.type() === 'error') console.log('[page error]', text);
    });

    await page.goto(`http://127.0.0.1:${PORT}/SprizzleIDE.html`, { waitUntil: 'domcontentloaded' });

    // Ensure the bottom panel is visible, then switch to the VM tab (this triggers the lazy loader).
    await page.evaluate(() => {
      const bp = document.getElementById('bottom-panel');
      if (bp && bp.style.display === 'none') bp.style.display = 'flex';
      switchPanelTabById('vm');
    });

    // Wait for the lazy-loaded VMTerm global and its terminal instance.
    await page.waitForFunction(() => window.VMTerm && window.VMTerm._term, { timeout: 20000 });

    await page.click('.vm-toolbar button:has-text("Boot")');

    await page.waitForFunction(() => {
      const t = window.VMTerm && window.VMTerm._term;
      if (!t || !t.buffer || !t.buffer.active) return false;
      const buf = t.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) text += buf.getLine(i)?.translateToString(true) + '\n';
      return text.includes('SPRZ-TESTOS READY');
    }, { timeout: 60000 });
    console.log('PASS: banner "SPRZ-TESTOS READY" observed in xterm buffer');

    await page.evaluate(() => window.VMTerm._emulator.serial0_send('abc'));

    await page.waitForFunction(() => {
      const t = window.VMTerm && window.VMTerm._term;
      if (!t || !t.buffer || !t.buffer.active) return false;
      const buf = t.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) text += buf.getLine(i)?.translateToString(true) + '\n';
      return text.includes('ABC');
    }, { timeout: 15000 });
    console.log('PASS: serial echo "ABC" observed in xterm buffer');

    console.log('PASS: terminal-ui.spec.mjs — VM tab lazy-load, boot, and serial round-trip all OK');
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
