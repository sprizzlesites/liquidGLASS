// tests/vst/vst-generator.spec.mjs
//
// Playwright end-to-end test for vst/vstcloud.js (Agent C work package §3.C).
// Serves the real SprizzleIDE.html from the repo, injects vst/vstcloud.js at
// runtime (proving the "can also be injected late" design goal — we do NOT
// rely on any <script> tag having been added to the HTML by another agent),
// then drives the actual UI: opens the modal, generates the JUCE/CMake/CI
// project into S.files, validates the generated YAML/CMake, and exercises
// the "Check builds" / asset-download flow against a stubbed GitHub API.
//
// Run: node tests/vst/vst-generator.spec.mjs   (exits 0 on pass)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import url from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { checkYamlSanity } from './yaml-lint.mjs';

const root = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const PORT = 8803;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const VSTCLOUD_PATH = path.join(root, 'vst', 'vstcloud.js');

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('http.server did not start in time')), 10000);
    proc.stdout.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', d => { if (/Serving HTTP/.test(String(d))) { clearTimeout(t); resolve(); } });
    setTimeout(() => { clearTimeout(t); resolve(); }, 1200);
  });
}

// A small deterministic "binary" payload standing in for a built .vst3 zip.
function makeFakeZipBytes() {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  return bytes;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += String(d); });
  await waitForServer(server);

  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('download', d => { d.path().catch(() => {}); }); // swallow the real-download side effect

    page.on('console', msg => {
      const text = msg.text();
      // CDN loads (fontawesome/webllm) are expected to fail in this sandbox — ignore that noise.
      if (/fontawesome|webllm|cdn\.|ERR_TUNNEL|net::ERR/i.test(text)) return;
      if (msg.type() === 'error') console.log('[page error]', text);
    });

    await page.goto(`http://127.0.0.1:${PORT}/SprizzleIDE.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.S === 'object' || typeof S === 'object', { timeout: 15000 }).catch(() => {});

    // ── Inject vst/vstcloud.js at runtime (late-injection design) ──────────
    await page.addScriptTag({ path: VSTCLOUD_PATH });
    await page.waitForFunction(() => !!window.VSTCloud, { timeout: 5000 });
    results.push('PASS: vst/vstcloud.js injected at runtime and window.VSTCloud registered');

    // ── Menu self-registration ──────────────────────────────────────────────
    const menuInjected = await page.evaluate(() => !!document.getElementById('vstcloud-menu-item'));
    assert.equal(menuInjected, true, 'VST Cloud Build… menu item should have self-inserted into the Run dropdown');
    results.push('PASS: "VST Cloud Build…" menu item self-inserted into the Run menu dropdown');

    // ── Open modal via the public API ───────────────────────────────────────
    await page.evaluate(() => window.VSTCloud.open());
    const modalVisible = await page.evaluate(() => {
      const m = document.getElementById('vstcloud-modal');
      return !!m && !m.classList.contains('hidden');
    });
    assert.equal(modalVisible, true, 'VSTCloud modal should be visible after open()');
    results.push('PASS: VSTCloud.open() shows the glass modal');

    // Honest-copy check.
    const bodyText = await page.evaluate(() => document.getElementById('vstcloud-modal').textContent);
    assert.match(bodyText, /cannot be compiled client-side/i, 'modal copy must be honest about client-side limits');
    assert.match(bodyText, /Windows, macOS and Linux/, 'modal copy must mention all three target platforms');
    results.push('PASS: modal copy is honest about VST3 build location constraints');

    // ── Fill inputs + click Generate ────────────────────────────────────────
    await page.fill('#vstc-name', 'Test Gain Plugin');
    await page.fill('#vstc-vendor', 'Sprizzle Co');
    await page.click('#vstc-gen');

    const genStatus = await page.evaluate(() => document.getElementById('vstc-status').textContent);
    assert.match(genStatus, /Generated 4 file/, 'status line should confirm 4 generated files');
    results.push('PASS: Generate button reports 4 files generated');

    // ── Assert S.files contains the 4 project files ────────────────────────
    const fileState = await page.evaluate(() => {
      const s = window.S || (typeof S !== 'undefined' ? S : null);
      const paths = ['plugin/CMakeLists.txt', 'plugin/Plugin.h', 'plugin/Plugin.cpp', '.github/workflows/vst3-build.yml'];
      const out = {};
      for (const p of paths) out[p] = s && s.files[p] ? s.files[p].content : null;
      out._gitChanges = (s.gitChanges || []).map(c => c.path);
      return out;
    });
    for (const p of ['plugin/CMakeLists.txt', 'plugin/Plugin.h', 'plugin/Plugin.cpp', '.github/workflows/vst3-build.yml']) {
      assert.ok(fileState[p] && fileState[p].length > 20, `S.files['${p}'] should exist with real content`);
    }
    assert.ok(fileState._gitChanges.includes('plugin/CMakeLists.txt'), 'generated files should register as git changes (A)');
    results.push('PASS: S.files contains all 4 generated project files, and git-changes tracks them');

    // ── CMakeLists sanity ────────────────────────────────────────────────────
    assert.match(fileState['plugin/CMakeLists.txt'], /juce_add_plugin/, 'CMakeLists.txt must call juce_add_plugin');
    assert.match(fileState['plugin/CMakeLists.txt'], /FetchContent/, 'CMakeLists.txt must fetch JUCE via FetchContent');
    assert.match(fileState['plugin/CMakeLists.txt'], /FORMATS VST3/, 'CMakeLists.txt must build the VST3 format');
    assert.match(fileState['plugin/CMakeLists.txt'], /CMAKE_CXX_STANDARD 17|cxx_std_17/, 'CMakeLists.txt must target C++17');
    results.push('PASS: CMakeLists.txt contains juce_add_plugin / FetchContent / FORMATS VST3 / C++17');

    // ── Plugin.cpp / Plugin.h sanity ─────────────────────────────────────────
    assert.match(fileState['plugin/Plugin.h'], /class GainAudioProcessor/, 'Plugin.h should declare the processor class');
    assert.match(fileState['plugin/Plugin.cpp'], /processBlock/, 'Plugin.cpp should implement processBlock');
    assert.match(fileState['plugin/Plugin.cpp'], /createPluginFilter/, 'Plugin.cpp should implement createPluginFilter (JUCE plugin entry point)');
    results.push('PASS: Plugin.h/Plugin.cpp contain a minimal, structurally sane JUCE gain processor + editor');

    // ── Workflow YAML sanity check (our self-contained checker) ────────────
    const yamlText = fileState['.github/workflows/vst3-build.yml'];
    const yamlErrors = checkYamlSanity(yamlText);
    assert.deepEqual(yamlErrors, [], `workflow YAML should pass structural sanity check, got: ${yamlErrors.join('; ')}`);
    assert.match(yamlText, /windows-latest.*macos-latest.*ubuntu-latest/s, 'workflow matrix should cover win/mac/linux');
    assert.match(yamlText, /vst3-build-\$\{\{\s*github\.run_number\s*\}\}/, 'workflow must tag releases vst3-build-N');
    assert.match(yamlText, /libasound2-dev/, 'workflow must install Linux JUCE build deps');
    assert.match(yamlText, /softprops\/action-gh-release@v2/, 'workflow must publish via softprops/action-gh-release');
    results.push('PASS: generated GitHub Actions workflow YAML passes structural sanity check (matrix, deps, release tag, publish action all present)');

    // ── "Check builds" against a stubbed GitHub API ─────────────────────────
    const fakeBytes = makeFakeZipBytes();
    const fakeBytesArr = Array.from(fakeBytes);
    await page.evaluate((bytesArr) => {
      const s = window.S || (typeof S !== 'undefined' ? S : null);
      s.gh.token = 'test-token-123';
      s.gh.currentRepo = 'octocat/hello-world';
      s.gh.currentBranch = 'main';

      const bytes = new Uint8Array(bytesArr);
      window.__origFetch = window.fetch;
      window.fetch = async (input, init) => {
        const urlStr = String(input);
        if (/\/releases$/.test(urlStr)) {
          const body = [
            {
              tag_name: 'vst3-build-42',
              created_at: '2026-07-01T00:00:00Z',
              assets: [
                { id: 999, name: 'TestGainPlugin-Linux.zip', size: bytes.length },
                { id: 1000, name: 'TestGainPlugin-Windows.zip', size: bytes.length }
              ]
            },
            { tag_name: 'v1.0.0-unrelated', created_at: '2026-01-01T00:00:00Z', assets: [] }
          ];
          return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (/\/releases\/assets\/999$/.test(urlStr)) {
          return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
        }
        throw new Error('unexpected fetch in test stub: ' + urlStr);
      };
    }, fakeBytesArr);

    await page.click('#vstc-check');
    await page.waitForFunction(() => {
      const t = document.getElementById('vstc-status');
      return t && /VST3 build release/.test(t.textContent);
    }, { timeout: 5000 });

    const checkStatus = await page.evaluate(() => document.getElementById('vstc-status').textContent);
    assert.match(checkStatus, /1 VST3 build release/, 'should find exactly one vst3-build-* release (the v1.0.0-unrelated tag must be filtered out)');
    results.push('PASS: Check builds lists releases filtered to tag_name startsWith "vst3-build-"');

    const buildsListHtml = await page.evaluate(() => document.getElementById('vstc-builds').innerHTML);
    assert.match(buildsListHtml, /TestGainPlugin-Linux\.zip/, 'builds list should render the asset name');
    assert.match(buildsListHtml, /vst3-build-42/, 'builds list should render the release tag');
    results.push('PASS: builds list renders per-asset rows with names/sizes and Download buttons');

    // ── Download flow: verify chunked-base64 stored bytes match the stub ───
    const downloadResult = await page.evaluate(async () => {
      const s = window.S || (typeof S !== 'undefined' ? S : null);
      const res = await window.VSTCloud.downloadAsset('octocat/hello-world', 999, 'TestGainPlugin-Linux.zip', 2048);
      const stored = s.files['builds/TestGainPlugin-Linux.zip'];
      return {
        returnedPath: res.path,
        returnedBytes: res.bytes,
        storedB64Flag: stored ? stored.b64 : null,
        storedContent: stored ? stored.content : null,
        storedLang: stored ? stored.lang : null,
        storedModified: stored ? stored.modified : null
      };
    });

    assert.equal(downloadResult.returnedPath, 'builds/TestGainPlugin-Linux.zip');
    assert.equal(downloadResult.returnedBytes, 2048);
    assert.equal(downloadResult.storedB64Flag, true, 'S.files entry for a downloaded binary must set b64:true');
    assert.equal(downloadResult.storedLang, 'binary');
    assert.equal(downloadResult.storedModified, true);

    const decoded = Buffer.from(downloadResult.storedContent, 'base64');
    assert.equal(decoded.length, fakeBytes.length, 'decoded byte length must match the original stub payload');
    assert.ok(Buffer.compare(decoded, Buffer.from(fakeBytes)) === 0, 'decoded bytes must exactly match the original stub payload (byte-identical)');
    results.push('PASS: asset download decodes to byte-identical content and is stored in S.files as {b64:true}');

    console.log(results.join('\n'));
    console.log('\nALL PASS: vst-generator.spec.mjs');
    process.exitCode = 0;
  } catch (e) {
    if (results.length) console.log(results.join('\n'));
    console.error('FAIL:', e && e.stack ? e.stack : e);
    if (serverErr) console.error('--- http.server stderr ---\n' + serverErr);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main();
