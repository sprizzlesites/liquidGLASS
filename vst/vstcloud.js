// vst/vstcloud.js — VST Cloud Build (SprizzleIDE "fullterminal", work package §3.C)
//
// Self-contained classic script. Does NOT touch SprizzleIDE.html/index.html.
// On load it:
//   (a) registers window.VSTCloud = { open, generate, checkBuilds, downloadAsset }
//   (b) self-inserts a "VST Cloud Build…" item into the existing Run menu dropdown
//       (found by locating the .menu-dd-item whose label is "Run File")
//   (c) no-ops quietly if that menu isn't present yet (retries briefly, then gives up)
//
// Can be loaded either via a static <script src="vst/vstcloud.js"> tag added by
// another agent, or injected late at runtime (dynamic <script> insertion / a
// Playwright addScriptTag/evaluate call) — both paths work identically because
// all state lookups happen lazily inside open()/generate()/etc., never at
// top-level parse time.
//
// Relies on globals already defined by SprizzleIDE.html's main inline <script>
// (shared classic-script global scope): S, GH, ghGet, ghPut, ghPost, tw,
// mkFileFromAI, addGitChange, renderTree, persist, askConfirm, askPrompt,
// closeModal, openGitHubConfig, ghPushChanges. Every use is defensive
// (typeof-checked) so this file degrades gracefully if any of those aren't
// present (e.g. in a minimal test harness).
(function () {
  'use strict';

  if (window.VSTCloud) return; // idempotent — don't double-register if injected twice

  // ───────────────────────── small local helpers ─────────────────────────

  function safeTw(msg, cls) {
    try {
      if (typeof tw === 'function') { tw(msg, cls); return; }
    } catch (e) { /* fall through */ }
    // eslint-disable-next-line no-console
    console.log('[VSTCloud]', msg);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getS() {
    try { return (typeof S !== 'undefined') ? S : null; } catch (e) { return null; }
  }

  function getGhBase() {
    try { if (typeof GH !== 'undefined' && GH) return GH; } catch (e) { /* ignore */ }
    return 'https://api.github.com';
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // Chunked base64 encode — avoids call-stack blowups from
  // String.fromCharCode.apply on very large ArrayBuffers.
  function arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function sanitizeIdentifier(name, fallback) {
    var cleaned = String(name || '').replace(/[^A-Za-z0-9_]/g, '');
    if (!cleaned || /^[0-9]/.test(cleaned)) cleaned = fallback + cleaned;
    return cleaned || fallback;
  }

  // JUCE plugin/manufacturer codes must be 4 chars, first uppercase, not
  // all-uppercase/all-lowercase. Derive something plausible from user input.
  function juceCode(str, fallback) {
    var clean = String(str || '').replace(/[^A-Za-z]/g, '');
    if (!clean) clean = fallback;
    clean = (clean + fallback + 'xxxx').slice(0, 4);
    return clean[0].toUpperCase() + clean.slice(1).toLowerCase();
  }

  // ───────────────────────── Run-menu self-registration ─────────────────────────

  function injectMenuItem() {
    try {
      if (document.getElementById('vstcloud-menu-item')) return true;
      var items = document.querySelectorAll('.menu-dropdown .menu-dd-item');
      var runDropdown = null;
      for (var i = 0; i < items.length; i++) {
        var span = items[i].querySelector('span');
        if (span && span.textContent.trim() === 'Run File') {
          runDropdown = items[i].closest('.menu-dropdown');
          break;
        }
      }
      if (!runDropdown) return false;
      var sep = document.createElement('div');
      sep.className = 'menu-dd-sep';
      var item = document.createElement('div');
      item.className = 'menu-dd-item';
      item.id = 'vstcloud-menu-item';
      item.innerHTML = '<span>VST Cloud Build…</span>';
      item.addEventListener('click', function () {
        try { window.VSTCloud.open(); } catch (e) { console.error('[VSTCloud] open failed', e); }
      });
      runDropdown.appendChild(sep);
      runDropdown.appendChild(item);
      return true;
    } catch (e) {
      return false; // never throw from injection — this must be a pure no-op on failure
    }
  }

  function tryInjectWithRetry() {
    if (injectMenuItem()) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (injectMenuItem() || tries > 20) clearInterval(iv);
    }, 250);
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryInjectWithRetry);
    } else {
      tryInjectWithRetry();
    }
  } catch (e) { /* no-op — never throw at load time */ }

  // ───────────────────────── project/workflow generator ─────────────────────────

  function buildProjectFiles(rawName, rawVendor) {
    var displayName = (rawName || 'MyPlugin').trim() || 'MyPlugin';
    var displayVendor = (rawVendor || 'YourCompany').trim() || 'YourCompany';
    var targetName = sanitizeIdentifier(displayName, 'MyPlugin');
    var pluginCode = juceCode(displayName, 'Gain');
    var vendorCode = juceCode(displayVendor, 'Sprz');

    var cmake =
      'cmake_minimum_required(VERSION 3.22)\n' +
      'project(' + targetName + ' VERSION 1.0.0 LANGUAGES CXX)\n' +
      '\n' +
      'set(CMAKE_CXX_STANDARD 17)\n' +
      'set(CMAKE_CXX_STANDARD_REQUIRED ON)\n' +
      '\n' +
      '# JUCE 8, fetched at configure time (no vendored copy needed).\n' +
      'include(FetchContent)\n' +
      'FetchContent_Declare(\n' +
      '  JUCE\n' +
      '  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git\n' +
      '  GIT_TAG        8.0.4\n' +
      '  GIT_SHALLOW    TRUE\n' +
      ')\n' +
      'FetchContent_MakeAvailable(JUCE)\n' +
      '\n' +
      'juce_add_plugin(' + targetName + '\n' +
      '    COMPANY_NAME "' + displayVendor.replace(/"/g, '\\"') + '"\n' +
      '    IS_SYNTH FALSE\n' +
      '    NEEDS_MIDI_INPUT FALSE\n' +
      '    NEEDS_MIDI_OUTPUT FALSE\n' +
      '    IS_MIDI_EFFECT FALSE\n' +
      '    EDITOR_WANTS_KEYBOARD_FOCUS FALSE\n' +
      '    COPY_PLUGIN_AFTER_BUILD FALSE\n' +
      '    PLUGIN_MANUFACTURER_CODE ' + vendorCode + '\n' +
      '    PLUGIN_CODE ' + pluginCode + '\n' +
      '    FORMATS VST3\n' +
      '    PRODUCT_NAME "' + displayName.replace(/"/g, '\\"') + '")\n' +
      '\n' +
      'target_sources(' + targetName + ' PRIVATE Plugin.cpp)\n' +
      '\n' +
      'target_compile_features(' + targetName + ' PRIVATE cxx_std_17)\n' +
      '\n' +
      'target_compile_definitions(' + targetName + '\n' +
      '    PUBLIC\n' +
      '        JUCE_WEB_BROWSER=0\n' +
      '        JUCE_USE_CURL=0\n' +
      '        JUCE_VST3_CAN_REPLACE_VST2=0)\n' +
      '\n' +
      'target_link_libraries(' + targetName + '\n' +
      '    PRIVATE\n' +
      '        juce::juce_audio_utils\n' +
      '    PUBLIC\n' +
      '        juce::juce_recommended_config_flags\n' +
      '        juce::juce_recommended_lto_flags\n' +
      '        juce::juce_recommended_warning_flags)\n';

    var pluginH =
      '// Generated by VST Cloud Build (SprizzleIDE) — minimal gain VST3 plugin.\n' +
      '#pragma once\n' +
      '#include <JuceHeader.h>\n' +
      '\n' +
      'class GainAudioProcessor : public juce::AudioProcessor\n' +
      '{\n' +
      'public:\n' +
      '    GainAudioProcessor();\n' +
      '    ~GainAudioProcessor() override;\n' +
      '\n' +
      '    void prepareToPlay (double sampleRate, int samplesPerBlock) override;\n' +
      '    void releaseResources() override;\n' +
      '    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;\n' +
      '\n' +
      '    juce::AudioProcessorEditor* createEditor() override;\n' +
      '    bool hasEditor() const override { return true; }\n' +
      '\n' +
      '    const juce::String getName() const override { return JucePlugin_Name; }\n' +
      '\n' +
      '    bool acceptsMidi() const override { return false; }\n' +
      '    bool producesMidi() const override { return false; }\n' +
      '    bool isMidiEffect() const override { return false; }\n' +
      '    double getTailLengthSeconds() const override { return 0.0; }\n' +
      '\n' +
      '    int getNumPrograms() override { return 1; }\n' +
      '    int getCurrentProgram() override { return 0; }\n' +
      '    void setCurrentProgram (int) override {}\n' +
      '    const juce::String getProgramName (int) override { return {}; }\n' +
      '    void changeProgramName (int, const juce::String&) override {}\n' +
      '\n' +
      '    void getStateInformation (juce::MemoryBlock& destData) override;\n' +
      '    void setStateInformation (const void* data, int sizeInBytes) override;\n' +
      '\n' +
      '    juce::AudioParameterFloat* gainParam = nullptr;\n' +
      '\n' +
      'private:\n' +
      '    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GainAudioProcessor)\n' +
      '};\n';

    var pluginCpp =
      '// Generated by VST Cloud Build (SprizzleIDE) — minimal gain VST3 plugin.\n' +
      '#include "Plugin.h"\n' +
      '\n' +
      'GainAudioProcessor::GainAudioProcessor()\n' +
      '    : AudioProcessor (BusesProperties()\n' +
      '                        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)\n' +
      '                        .withOutput ("Output", juce::AudioChannelSet::stereo(), true))\n' +
      '{\n' +
      '    addParameter (gainParam = new juce::AudioParameterFloat ("gain", "Gain", 0.0f, 2.0f, 1.0f));\n' +
      '}\n' +
      '\n' +
      'GainAudioProcessor::~GainAudioProcessor() {}\n' +
      '\n' +
      'void GainAudioProcessor::prepareToPlay (double, int) {}\n' +
      'void GainAudioProcessor::releaseResources() {}\n' +
      '\n' +
      'void GainAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)\n' +
      '{\n' +
      '    const float g = gainParam->get();\n' +
      '    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)\n' +
      '        buffer.applyGain (ch, 0, buffer.getNumSamples(), g);\n' +
      '}\n' +
      '\n' +
      'juce::AudioProcessorEditor* GainAudioProcessor::createEditor()\n' +
      '{\n' +
      '    return new juce::GenericAudioProcessorEditor (*this);\n' +
      '}\n' +
      '\n' +
      'void GainAudioProcessor::getStateInformation (juce::MemoryBlock& destData)\n' +
      '{\n' +
      '    juce::MemoryOutputStream stream (destData, true);\n' +
      '    stream.writeFloat (gainParam->get());\n' +
      '}\n' +
      '\n' +
      'void GainAudioProcessor::setStateInformation (const void* data, int sizeInBytes)\n' +
      '{\n' +
      '    juce::MemoryInputStream stream (data, static_cast<size_t> (sizeInBytes), false);\n' +
      '    if (stream.getNumBytesRemaining() >= (int) sizeof (float))\n' +
      '        gainParam->setValueNotifyingHost (stream.readFloat());\n' +
      '}\n' +
      '\n' +
      'juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()\n' +
      '{\n' +
      '    return new GainAudioProcessor();\n' +
      '}\n';

    var workflow =
      'name: VST3 Cloud Build\n' +
      '\n' +
      'on:\n' +
      '  workflow_dispatch: {}\n' +
      '  push:\n' +
      '    paths:\n' +
      "      - 'plugin/**'\n" +
      "      - '.github/workflows/vst3-build.yml'\n" +
      '\n' +
      'jobs:\n' +
      '  build:\n' +
      '    strategy:\n' +
      '      fail-fast: false\n' +
      '      matrix:\n' +
      '        os: [windows-latest, macos-latest, ubuntu-latest]\n' +
      '    runs-on: ${{ matrix.os }}\n' +
      '    steps:\n' +
      '      - name: Checkout\n' +
      '        uses: actions/checkout@v4\n' +
      '\n' +
      '      - name: Install Linux build dependencies\n' +
      "        if: runner.os == 'Linux'\n" +
      '        run: |\n' +
      '          sudo apt-get update\n' +
      '          sudo apt-get install -y libasound2-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libfreetype6-dev libfontconfig1-dev\n' +
      '\n' +
      '      - name: Configure\n' +
      '        run: cmake -B build -S plugin -DCMAKE_BUILD_TYPE=Release\n' +
      '\n' +
      '      - name: Build\n' +
      '        run: cmake --build build --config Release --parallel\n' +
      '\n' +
      '      - name: Package VST3 bundle\n' +
      '        shell: bash\n' +
      '        run: |\n' +
      '          mkdir -p out\n' +
      '          FOUND=$(find build -type d -iname "*.vst3" | head -n1)\n' +
      '          if [ -z "$FOUND" ]; then\n' +
      '            echo "No .vst3 bundle found under build/" >&2\n' +
      '            find build -maxdepth 6 -iname "*.vst3*" >&2 || true\n' +
      '            exit 1\n' +
      '          fi\n' +
      '          NAME=$(basename "$FOUND")\n' +
      '          cd "$(dirname "$FOUND")"\n' +
      '          zip -r -X "$GITHUB_WORKSPACE/out/${NAME%.vst3}-${{ runner.os }}.zip" "$NAME"\n' +
      '\n' +
      '      - name: Upload artifact\n' +
      '        uses: actions/upload-artifact@v4\n' +
      '        with:\n' +
      '          name: vst3-${{ runner.os }}\n' +
      '          path: out/*.zip\n' +
      '\n' +
      '  release:\n' +
      '    needs: build\n' +
      '    runs-on: ubuntu-latest\n' +
      '    permissions:\n' +
      '      contents: write\n' +
      '    steps:\n' +
      '      - name: Download all build artifacts\n' +
      '        uses: actions/download-artifact@v4\n' +
      '        with:\n' +
      '          path: artifacts\n' +
      '\n' +
      '      - name: Flatten artifacts\n' +
      '        run: |\n' +
      '          mkdir -p release-assets\n' +
      "          find artifacts -type f -name '*.zip' -exec cp {} release-assets/ \\;\n" +
      '          ls -la release-assets\n' +
      '\n' +
      '      - name: Create or update GitHub Release\n' +
      '        uses: softprops/action-gh-release@v2\n' +
      '        with:\n' +
      '          tag_name: vst3-build-${{ github.run_number }}\n' +
      '          name: VST3 Build ${{ github.run_number }}\n' +
      '          files: release-assets/*.zip\n' +
      '          fail_on_unmatched_files: true\n' +
      '        env:\n' +
      '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n';

    var files = {};
    files['plugin/CMakeLists.txt'] = cmake;
    files['plugin/Plugin.h'] = pluginH;
    files['plugin/Plugin.cpp'] = pluginCpp;
    files['.github/workflows/vst3-build.yml'] = workflow;
    return files;
  }

  function writeFilesToProject(files) {
    var written = [];
    var s = getS();
    Object.keys(files).forEach(function (path) {
      var content = files[path];
      var wroteViaHelper = false;
      try {
        if (typeof mkFileFromAI === 'function') { mkFileFromAI(path, content); wroteViaHelper = true; }
      } catch (e) { /* fall back below */ }
      if (!wroteViaHelper) {
        if (s) {
          var existed = !!s.files[path];
          var langName = 'Plain Text';
          try { if (typeof lang === 'function') langName = lang(path); } catch (e) { /* ignore */ }
          s.files[path] = { content: content, lang: langName, modified: true };
          try { if (typeof addGitChange === 'function') addGitChange(path, existed ? 'M' : 'A'); } catch (e) { /* ignore */ }
        }
      }
      written.push(path);
    });
    try { if (typeof renderTree === 'function') renderTree(); } catch (e) { /* ignore */ }
    try { if (typeof persist === 'function') persist(); } catch (e) { /* ignore */ }
    return written;
  }

  // ───────────────────────── modal (built once, reused) ─────────────────────────

  var modalEl = null;
  var els = {};

  function ensureModal() {
    if (modalEl) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.id = 'vstcloud-modal';
    overlay.innerHTML =
      '<div class="modal" style="width:580px;">' +
      '  <div class="modal-header"><span class="modal-title">VST Cloud Build</span><span class="modal-close" id="vstc-close">✕</span></div>' +
      '  <div class="modal-body">' +
      '    <div style="background:var(--bg-3);border-radius:6px;padding:12px;font-size:12px;color:var(--text-1);line-height:1.7;">' +
      '      Builds real <strong style="color:var(--text-0);">VST3</strong> binaries for ' +
      '      <strong style="color:var(--text-0);">Windows, macOS and Linux</strong> using ' +
      '      <strong style="color:var(--text-0);">GitHub Actions in YOUR repository</strong> — ' +
      '      these platform binaries <strong>cannot be compiled client-side</strong> in the browser. ' +
      '      A genuine in-browser Linux <strong>VST2</strong> <code>.so</code> can be compiled directly ' +
      '      in the VM tab from <code>tools/skel/vst/</code> — that one really is built on-device, but ' +
      '      it is Linux-only and not a DAW-distributable VST3.' +
      '    </div>' +
      '    <div style="display:flex;gap:12px;">' +
      '      <div class="form-group" style="flex:1"><div class="form-label">Plugin Name</div><input class="form-input" id="vstc-name" value="MyPlugin"></div>' +
      '      <div class="form-group" style="flex:1"><div class="form-label">Vendor</div><input class="form-input" id="vstc-vendor" value="YourCompany"></div>' +
      '    </div>' +
      '    <div class="form-group">' +
      '      <div class="form-label">Target repo</div>' +
      '      <div id="vstc-repo-status" style="font-size:12px;color:var(--text-2);">Not connected</div>' +
      '    </div>' +
      '    <div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '      <button class="btn btn-secondary" id="vstc-gen">Generate project + workflow into file tree</button>' +
      '      <button class="btn btn-primary" id="vstc-push">Push &amp; start build</button>' +
      '      <button class="btn btn-secondary" id="vstc-check">Check builds</button>' +
      '    </div>' +
      '    <div class="form-hint" id="vstc-status"></div>' +
      '    <div id="vstc-builds"></div>' +
      '  </div>' +
      '  <div class="modal-footer"><button class="btn btn-secondary" id="vstc-cancel">Close</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
    modalEl = overlay;

    els = {
      name: overlay.querySelector('#vstc-name'),
      vendor: overlay.querySelector('#vstc-vendor'),
      repoStatus: overlay.querySelector('#vstc-repo-status'),
      gen: overlay.querySelector('#vstc-gen'),
      push: overlay.querySelector('#vstc-push'),
      check: overlay.querySelector('#vstc-check'),
      status: overlay.querySelector('#vstc-status'),
      builds: overlay.querySelector('#vstc-builds'),
      close: overlay.querySelector('#vstc-close'),
      cancel: overlay.querySelector('#vstc-cancel')
    };
    els.close.addEventListener('click', hide);
    els.cancel.addEventListener('click', hide);
    els.gen.addEventListener('click', function () { onGenerate(); });
    els.push.addEventListener('click', function () { onPush(); });
    els.check.addEventListener('click', function () { onCheckBuilds(); });
  }

  function hide() { if (modalEl) modalEl.classList.add('hidden'); }

  function refreshRepoStatus() {
    var s = getS();
    if (!els.repoStatus) return;
    if (!s || !s.gh || !s.gh.token) {
      els.repoStatus.textContent = 'GitHub not connected — connect via GitHub → Connect Account.';
      return;
    }
    if (!s.gh.currentRepo) {
      els.repoStatus.textContent = 'Token OK, but no repository selected — open the GitHub panel and select one.';
      return;
    }
    els.repoStatus.textContent = s.gh.currentRepo + ' @ ' + (s.gh.currentBranch || 'main');
  }

  function open() {
    ensureModal();
    refreshRepoStatus();
    if (els.status) els.status.textContent = '';
    if (els.builds) els.builds.innerHTML = '';
    modalEl.classList.remove('hidden');
  }

  // ───────────────────────── button handlers ─────────────────────────

  function onGenerate() {
    var name = els.name ? els.name.value : 'MyPlugin';
    var vendor = els.vendor ? els.vendor.value : 'YourCompany';
    try {
      var files = buildProjectFiles(name, vendor);
      var written = writeFilesToProject(files);
      if (els.status) els.status.textContent = 'Generated ' + written.length + ' file(s) into the project tree: ' + written.join(', ');
      safeTw('VST Cloud Build: generated ' + written.length + ' files (plugin/*, .github/workflows/vst3-build.yml).', 'info');
      return files;
    } catch (e) {
      if (els.status) els.status.textContent = 'Generation failed: ' + e.message;
      safeTw('VST Cloud Build generation failed: ' + e.message, 'err');
      throw e;
    }
  }

  async function onPush() {
    var s = getS();
    if (!s || !s.gh || !s.gh.token || !s.gh.currentRepo) {
      safeTw('VST Cloud Build: connect a GitHub account and select a repository first.', 'warn');
      try { if (typeof openGitHubConfig === 'function') openGitHubConfig(); } catch (e) { /* ignore */ }
      refreshRepoStatus();
      return;
    }
    // Make sure the project files exist before pushing.
    var hasPluginFiles = !!(s.files && s.files['plugin/CMakeLists.txt']);
    if (!hasPluginFiles) onGenerate();

    try {
      if (typeof ghPushChanges === 'function') {
        await ghPushChanges();
      } else {
        throw new Error('ghPushChanges() is not available in this page.');
      }
      // Best-effort explicit dispatch as a safety net in addition to the
      // push-triggered run (harmless if the push already started one).
      try {
        if (typeof ghPost === 'function') {
          await ghPost('/repos/' + s.gh.currentRepo + '/actions/workflows/vst3-build.yml/dispatches', { ref: s.gh.currentBranch || 'main' });
        }
      } catch (e) { /* push trigger is enough even if manual dispatch fails (e.g. not yet indexed) */ }
      if (els.status) els.status.textContent = 'Pushed. GitHub Actions should start a vst3-build-* release shortly — use "Check builds" to poll.';
      safeTw('VST Cloud Build: pushed plugin project + workflow to ' + s.gh.currentRepo, 'info');
    } catch (e) {
      if (els.status) els.status.textContent = 'Push failed: ' + e.message;
      safeTw('VST Cloud Build push failed: ' + e.message, 'err');
    }
  }

  async function onCheckBuilds() {
    var s = getS();
    if (!s || !s.gh || !s.gh.token || !s.gh.currentRepo) {
      safeTw('VST Cloud Build: connect a GitHub account and select a repository first.', 'warn');
      try { if (typeof openGitHubConfig === 'function') openGitHubConfig(); } catch (e) { /* ignore */ }
      refreshRepoStatus();
      return;
    }
    if (els.status) els.status.textContent = 'Checking releases…';
    try {
      var releases = await ghGet('/repos/' + s.gh.currentRepo + '/releases');
      var vstReleases = (releases || []).filter(function (r) { return r && typeof r.tag_name === 'string' && r.tag_name.indexOf('vst3-build-') === 0; });
      renderBuildsList(s.gh.currentRepo, vstReleases);
      if (els.status) els.status.textContent = vstReleases.length ? (vstReleases.length + ' VST3 build release(s) found.') : 'No VST3 Cloud Build releases found yet.';
      return vstReleases;
    } catch (e) {
      if (els.status) els.status.textContent = 'Check failed: ' + e.message;
      safeTw('VST Cloud Build: check builds failed: ' + e.message, 'err');
      return [];
    }
  }

  function renderBuildsList(repo, releases) {
    if (!els.builds) return;
    if (!releases.length) { els.builds.innerHTML = ''; return; }
    var html = releases.map(function (r) {
      var assets = (r.assets || []).map(function (a) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border);">' +
          '<span style="font-size:12px;color:var(--text-1);">' + esc(a.name) + ' <span style="color:var(--text-2);">(' + formatBytes(a.size) + ')</span></span>' +
          '<button class="btn btn-secondary vstc-dl-btn" data-repo="' + esc(repo) + '" data-id="' + a.id + '" data-name="' + esc(a.name) + '" data-size="' + a.size + '">Download</button>' +
          '</div>';
      }).join('');
      return '<div style="margin-top:10px;padding:10px;background:var(--bg-3);border-radius:6px;">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text-0);">' + esc(r.tag_name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-2);">' + esc(r.created_at || '') + '</div>' +
        assets +
        '</div>';
    }).join('');
    els.builds.innerHTML = html;
    var btns = els.builds.querySelectorAll('.vstc-dl-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (ev) {
        var b = ev.currentTarget;
        downloadAsset(b.getAttribute('data-repo'), b.getAttribute('data-id'), b.getAttribute('data-name'), b.getAttribute('data-size'));
      });
    }
  }

  async function downloadAsset(repo, assetId, name, size) {
    var s = getS();
    try {
      safeTw('Downloading ' + name + '…', 'info');
      var resp = await fetch(getGhBase() + '/repos/' + repo + '/releases/assets/' + assetId, {
        headers: {
          Authorization: 'Bearer ' + (s && s.gh ? s.gh.token : ''),
          Accept: 'application/octet-stream'
        }
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var buf = await resp.arrayBuffer();
      var b64 = arrayBufferToBase64(buf);

      // Trigger a real browser download of the binary.
      var blob = new Blob([buf]);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);

      // Also store into the project tree, binary-safe (base64).
      var path = 'builds/' + name;
      if (s) {
        var existed = !!s.files[path];
        s.files[path] = { content: b64, b64: true, lang: 'binary', modified: true };
        try { if (typeof addGitChange === 'function') addGitChange(path, existed ? 'M' : 'A'); } catch (e) { /* ignore */ }
        try { if (typeof renderTree === 'function') renderTree(); } catch (e) { /* ignore */ }
        try { if (typeof persist === 'function') persist(); } catch (e) { /* ignore */ }
      }
      safeTw('✓ Downloaded ' + name + ' (' + formatBytes(size) + ') → ' + path, 'info');
      return { path: path, base64: b64, bytes: buf.byteLength };
    } catch (e) {
      safeTw('VST Cloud Build download failed: ' + e.message, 'err');
      throw e;
    }
  }

  // ───────────────────────── public API ─────────────────────────

  window.VSTCloud = {
    open: open,
    generate: onGenerate,
    checkBuilds: onCheckBuilds,
    downloadAsset: downloadAsset,
    // exposed for tests / introspection — not part of the "stable" surface
    _buildProjectFiles: buildProjectFiles,
    _arrayBufferToBase64: arrayBufferToBase64,
    _injectMenuItem: injectMenuItem
  };
})();
