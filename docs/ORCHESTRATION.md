# SprizzleIDE `fullterminal` — Orchestration Plan (RESUMABLE)

> **Purpose of this document**: if the current orchestrating agent loses access
> mid-project, ANY capable agent must be able to resume from here. It records
> the mission, locked architecture decisions, honest feasibility constraints,
> interface contracts, per-agent work packages (with ready-to-use prompts),
> the test matrix, and a living STATUS LOG at the bottom. Update the status
> log after every completed work package.

---

## 1. Mission (user requirements, verbatim intent)

Expand SprizzleIDE (single-page browser IDE, GitHub Pages hosted, works on
iPhone) with:

1. A **full bash terminal** running *in the current project/blob* — "a genuine
   miniature VM or something", **not** a simulation.
2. Ability to **add dependency packages to the project tree**.
3. **Build & compile workflows** runnable from the IDE.
4. **Compile VST plugins inside the IDE.**
5. **Compile assembly programs in both 32 & 64 bit.**
6. After implementation: audit waves (code integrity; interface usability on
   desktop+mobile; feature completeness vs. this list; state persist/hydrate
   coverage; **clean, uncorrupted media/output through every generation/output
   path**).
7. All work on branch **`fullterminal`** (created from main @ v2.8.8,
   commit d823983). Never touch `main`.

## 2. Locked architecture (decided after feasibility spikes — do not relitigate)

**VM core: v86** (x86-to-wasm JIT PC emulator, BSD-2) — a *genuine* virtual
machine in the browser. Engine + BIOS are **vendored** in-repo (no CDN):

```
vm/vendor/libv86.js|.mjs   v86 0.5.424 (from npm tarball)
vm/vendor/v86.wasm         engine wasm
vm/vendor/seabios.bin      BIOS  (from copy/v86 master)
vm/vendor/vgabios.bin      VGA BIOS
vm/vendor/xterm.js|.css    @xterm/xterm 6.0.0 (terminal UI)
```

**Two boot payloads:**

- `vm/image/testos.img` — 1.44MB floppy with a hand-assembled boot sector
  (generator: `tools/make-testos.py`, no external assembler needed). Prints
  `SPRZ-TESTOS READY`, echoes serial input uppercased. Exists so the terminal
  pipeline is **testable offline/in CI sandboxes with no network**. PROVEN
  WORKING via `tests/vm/boot-testos.mjs` (node, exit 0).
- **Alpine Linux i686 toolchain image** (real bash, apk, gcc, make, nasm,
  binutils, musl-dev, + vendored `vestige.h` VST2 header and sample projects)
  as a v86 **9p filesystem** (`alpine-fs.json` + flat chunk dir) + bzImage.
  **Cannot be built in the current dev sandbox** (Alpine CDN blocked by
  proxy) → built by GitHub Actions workflow `.github/workflows/build-vm-image.yml`
  (CI has open network), which must also **smoke-test boot headlessly in node
  before publishing**. Publish target: commit under `vm/image/` if each file
  <95MB and total reasonable; otherwise attach to a GitHub Release on this
  repo and write the release URLs into `vm/image/manifest.json`
  (`objects.githubusercontent.com` serves release assets with CORS `*`).

**Boot mode selection**: `vm/image/manifest.json`:
```json
{ "mode": "linux9p" | "floppy",
  "kernel": "vm/image/bzimage.bin", "cmdline": "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose init=/sbin/init console=ttyS0",
  "fsjson": "vm/image/alpine-fs.json", "basefs": "vm/image/alpine-rootfs-flat/",
  "fallback": "vm/image/testos.img" }
```
`vm/vmterm.js` reads the manifest; if linux assets 404 → floppy fallback with a
clear in-terminal notice. This means the branch is ALWAYS demoable.

**Terminal UI**: xterm.js bound to v86 `serial0` (console=ttyS0). New "VM" tab
in the bottom panel beside Terminal/Problems/Output. All VM JS lazy-loaded on
first open (dynamic `<script>` injection) so baseline page stays light.
Mobile: allowed but show a memory warning (needs ~256MB wasm memory; iOS may
kill the tab); the glass UI must remain intact.

**Project sync**: two-way bridge between `S.files` and guest `/root/project`
via v86 9p API (`emulator.create_file`/`read_file`, available in linux9p mode).
- Sync-in on boot + manual "⬇ project→VM" button.
- "⬆ VM→project" pulls `/root/project` back (guest writes build artifacts
  there). Guest convenience script `/usr/local/bin/sync-out` touches marker
  file `/root/project/.sprz-sync` which host polls (or manual button).
- **Binary safety**: `S.files[path]` gains optional `{b64:true}` — content
  stored base64 for binary artifacts. EVERY output path must honor it:
  ZIP export (JSZip `{base64:true}`), single-file download (decode → Blob),
  GitHub push (already base64 — skip re-encode), preview (skip binaries),
  editor (open read-only hex/notice, do not corrupt), persist/hydrate.

**Compile workflows** (in-VM, real toolchain):
- C: `gcc hello.c && ./a.out` (i686).
- **asm 32-bit**: `nasm -f elf32` + `ld -m elf_i386` → runs in VM.
- **asm 64-bit**: `nasm -f elf64` assembles fine on i686. Linking: use
  `ld -m elf_x86_64` if Alpine binutils has the emulation (CI must test;
  if absent, document object-only + provide GH-Actions asm64 build+run
  workflow as the execution path). **v86 cannot EXECUTE 64-bit code** —
  this is a hard emulator limit; execution of 64-bit output happens via the
  cloud workflow (or a future blink/wasm x86-64 usermode emulator, stretch).
- **VST**: two honest paths:
  (a) *in-IDE literal*: minimal Linux VST2 `.so` compiled in-VM with vendored
      `vestige.h` (single-header VST2 ABI reimpl., LGPL, used widely) +
      sample `gain-plugin.c`. Genuine plugin binary built entirely in-browser.
  (b) *usable-in-your-DAW*: "VST3 Cloud Build" — generator writes a JUCE/
      CMake GitHub Actions workflow + minimal plugin project into the user's
      repo (existing GH token integration), workflow builds real VST3 for
      win/mac/linux and uploads to a Release; IDE polls and downloads
      artifacts via API asset endpoint (CORS-safe). A macOS/Windows VST3
      binary CANNOT be produced purely client-side — say so in UI copy.

**File ownership map (conflict avoidance)**:
- `SprizzleIDE.html` — ONLY Agent A edits it (hook points, panel DOM, lazy
  loader, menu items). Everyone else ships standalone JS that self-registers.
- `vm/vmterm.js` — Agent A creates; Agent B extends (sync section marked).
- `vst/vstcloud.js` + `tools/skel/vst/**` — Agent C only.
- `.github/workflows/*`, `tools/build-image/**` — Agent D only.
- `index.html` on this branch = copy of SprizzleIDE.html with banner
  `v2.9.0-ft | FULL TERMINAL` (same perl one-liner as main branch history).

## 3. Work packages & agent prompts

Run A, C, D in parallel (disjoint files), then B, then audits E1–E4, then fix
wave + final sync/push. All implementation agents: **Sonnet**. Every agent
gets: this file, plus the specific contract below. Agents must run their own
tests and report PASS/FAIL honestly.

### A — VM terminal UI integration  [files: SprizzleIDE.html, vm/vmterm.js, tests/vm/]
Add bottom-panel tab `VM` (id `panel-vm`, tab button beside Terminal): dark
container `#vmterm-mount`, toolbar (`Boot`, `Stop`, `⬇ Sync to VM`,
`⬆ Pull from VM`, status dot+text). First open → dynamically load
`vm/vendor/xterm.css/js`, `vm/vendor/libv86.js`, `vm/vmterm.js`, then
`VMTerm.init(mountEl)`. `vm/vmterm.js` exposes
`window.VMTerm={init,boot,stop,isRunning,syncIn,syncOut,_emulator}`:
reads `vm/image/manifest.json` (fetch relative), boots per mode
(`linux9p`: kernel+filesystem+cmdline; `floppy`: fda buffer), binds xterm⇄
serial0 (`serial0-output-byte` → term.write; `term.onData` → serial0_send),
wires status events, terminal fit on panel resize + mobile view switch.
Also update `switchPanelTab`/`switchPanelTabById` for the new tab (they
currently hardcode three panels). Sync buttons call VMTerm.syncIn/syncOut
(stubs OK — Agent B fills). Node test: reuse/extend `tests/vm/boot-testos.mjs`;
add DOM smoke test via Playwright (local http server `python3 -m http.server`,
chromium at `http://127.0.0.1:PORT/SprizzleIDE.html` — NOTE sandbox blocks
CDNs from the browser; page must tolerate FontAwesome/webllm failing).
Glass styling to match existing panels; keyboard focus handling on mobile.

### B — Project sync bridge + binary-safe S.files  [files: vm/vmterm.js (sync section), SprizzleIDE.html ONLY if unavoidable, tests/vm/]
Implement syncIn: walk `S.files`, `emulator.create_file('project/'+path, bytes)`
(create dirs implicitly — check v86 API: `create_file` under `filesystem`
root; use `emulator.fs9p` mkdir as needed). syncOut: recursive
`read_dir/read_file` of `project/`, write back to `S.files` (text if UTF-8
decodable & <2MB, else `{b64:true}`), addGitChange('M'|'A'), renderTree.
Marker-file poll (2s while VM tab active): guest `touch /root/project/.sprz-sync`
→ auto syncOut + toast. S.files binary support wired through ALL output paths
(see §2 binary safety list) — this is audit-critical. Tests: node harness with
a fake fs9p stub (VMTerm must route all 9p calls through `VMTerm._fs` so tests
can inject a stub); plus JSZip round-trip test proving a PNG-like binary
survives export byte-identical.

### C — VST cloud build + in-VM VST sample  [files: vst/vstcloud.js, tools/skel/vst/**, tests/]
`vst/vstcloud.js` self-registers menu item (append to Run menu dropdown via
DOM on load) `VST Cloud Build…` → glass modal: (1) writes into S.files a
minimal JUCE CMake plugin project (`plugin/CMakeLists.txt`, `Plugin.cpp`,
`.github/workflows/vst3-build.yml` — matrix win/mac/linux, uploads VST3 zips
as Release assets tagged `vst3-build-N`); (2) uses existing gh push helpers to
commit; (3) polls releases via existing `ghGet`, lists assets, downloads via
API asset endpoint (`Accept: application/octet-stream`, token auth,
objects.githubusercontent CORS) into S.files as `{b64:true}` + offers browser
download. Also vendor `tools/skel/vst/vestige/vestige.h` + `gain-vst2.c` +
Makefile (used by the in-VM path; Agent D bakes same skel into the VM image).
UI copy must be honest about where each binary can run. Tests: stubbed-fetch
node/playwright test of generator output validity (YAML parses, CMake sane)
and downloader flow.

### D — CI image build + in-VM toolchain workflows  [files: .github/workflows/build-vm-image.yml, tools/build-image/**]
Workflow (manual `workflow_dispatch` + push-to-branch trigger): ubuntu runner,
`docker run --platform linux/386 i386/alpine:3.19` → `apk add bash gcc musl-dev
make nasm binutils busybox-extras`; copy `tools/skel/**` to `/root/skel`;
export container fs; clone copy/v86 (tools/fs2json.py + docs/alpine.md — follow
that doc's kernel/initrd guidance EXACTLY; kernel with 9p/virtio for
`root=host9p`); generate `alpine-fs.json` + flat dir; node headless boot smoke
test (expect login/prompt over serial within 120s, run `gcc --version`,
`nasm -v`, `echo 'int main(){return 42;}' > t.c && gcc t.c && ./a.out; echo $?`
expect 42, `nasm -f elf64` object success, test `ld -m elf_x86_64` presence and
RECORD result into manifest `caps` field); publish (commit if small enough
else Release + manifest URLs). Also write `docs/VM-TOOLCHAIN.md`: exact
commands for C, asm32 (build+run), asm64 (assemble[+link]), VST2 sample build,
`apk add` package install (needs network=false → document `apk add --repositories-file /dev/null /root/pkgs/*.apk` offline flow OR ship a small local apk mirror dir in image with the ~20 most useful -dev packages; decide in-CI by size).

### E — Audit wave (after A–D integrated; all Sonnet; read-only + report)
- **E1 code/regression**: run ALL suites in `scratchpad`/`tests/`; grep for
  broken references; verify persist()/hydrate() cover any NEW S.* state
  (vm prefs, vst state) and `restoreSystemDefaults` resets it; verify main-
  branch features unbroken (AI chat, search overlay, folders, mobile dock).
- **E2 interface flow**: Playwright desktop+mobile: every panel reachable,
  VM tab boots floppy fallback offline, buttons disabled/enabled correctly,
  no dead buttons, glass styling intact, no console errors (except known
  blocked-CDN noise in sandbox).
- **E3 requirements audit**: §1 list vs. reality; flag anything missing or
  only-documented-not-implemented; verify honest UI copy where capability is
  cloud-delegated (VST3, asm64 execution).
- **E4 media/output integrity**: ZIP export/import round-trip (binary +
  text), single-file download, GH push encoding, preview blob, VM artifact
  pull → download (byte-identical checks), persist/hydrate of b64 files.

## 4. Test matrix (must be green before calling done)
| Test | How |
|---|---|
| testos boot + serial round-trip | `node tests/vm/boot-testos.mjs` |
| VM tab lazy-load + boot (floppy) in browser | Playwright + local http server |
| syncIn/syncOut with fs9p stub | node harness |
| Binary ZIP round-trip byte-identical | node/JSZip harness |
| VST generator output valid | YAML/CMake lint harness |
| All pre-existing suites (search, AI, folders, rate, backend, ctx, singleshot) | scratchpad `*.js` harnesses |
| CI image boot + gcc/nasm smoke | inside build-vm-image.yml (CI only) |

## 5. Honest constraints (tell the user; do not paper over)
- v86 executes 32-bit x86 only → 64-bit asm assembles (and possibly links)
  in-VM; *runs* via cloud workflow. Real Win/macOS VST3 binaries come from
  the cloud build path, not client-side.
- The Alpine image cannot be produced from this dev sandbox (network policy);
  the CI workflow is the build path. Until its first successful run, the VM
  tab operates in floppy/testos fallback mode.
- iOS Safari may kill tabs at VM memory sizes; feature is desktop-first.
- GitHub Pages serves this branch only if Pages is switched to it (or use
  raw.githubusercontent preview); deployment note for user.

## 6. STATUS LOG (append-only; newest last)
- [orchestrator/fable] branch `fullterminal` created from main d823983 (v2.8.8), pushed.
- [orchestrator/fable] spikes done: npm reachable; alpine CDN + foreign GH API blocked in sandbox; v86 engine+BIOS+xterm vendored under vm/vendor/.
- [orchestrator/fable] `tools/make-testos.py` + `vm/image/testos.img` + `tests/vm/boot-testos.mjs` — PASS (banner + uppercased serial echo; had to pad floppy to 1.44MB for SeaBIOS geometry).
- [orchestrator/fable] this plan committed. Next: launch agents A, C, D in parallel; then B; then E1–E4.
- [agent-A] VM tab wired into SprizzleIDE.html (4th panel-tab beside Terminal/Problems/Output; `switchPanelTab`/`switchPanelTabById` updated; lazy loader `loadVMTermLazy()` sequentially injects vm/vendor/xterm.css→xterm.js→libv86.js→vm/vmterm.js on first activation with onerror→red status dot + in-mount error text; toolbar buttons Boot/Stop/⬇To VM/⬆From VM guarded by `window.VMTerm&&...` existence checks). `vm/vmterm.js` created: `window.VMTerm={init,boot,stop,isRunning,syncIn,syncOut,_emulator,_fs,_term}`; boots per `vm/image/manifest.json` (`linux9p`→bzimage+9p filesystem, 256MB; `floppy`/missing manifest→vendored testos.img, 64MB, currently always this path since no manifest exists yet — Agent D's job); xterm⇄serial0 bound both directions; status dot/text wired to emulator-started/stopped events; manual (no-fit-addon) cols/rows resize on window resize; mobile notice (`isMobileDevice()`) printed once inside the xterm buffer itself (not raw HTML) warning about memory/iOS tab kills — verified working under an iPhone UA in a real headless-chromium check. syncIn/syncOut are honest stubs that print `[sync not yet implemented — Agent B]` and return false; all 9p access funnels through `VMTerm._fs` per the file-ownership contract so Agent B can inject a stub. index.html regenerated as an exact copy of SprizzleIDE.html with only the banner line changed to `v2.9.0-ft | FULL TERMINAL` (verified via diff: exactly 1 line differs). NOT done / left for others: real syncIn/syncOut (Agent B), manifest.json + linux9p image (Agent D) — until then the VM tab is floppy-fallback only, which is expected/by design per §5. Did not touch vst/, .github/, tools/build-image/, or the pre-existing Problems/Output tab `class="hidden"` (noticed it combines with an inline `style.display` set from JS in a way that a strict CSS-cascade reading says should never show — left alone as out-of-scope/pre-existing; new panel-vm avoids the same pattern by using an inline `display:none` instead of the `hidden` class so it isn't affected). TESTS: `node tests/vm/boot-testos.mjs` → PASS (banner + uppercased echo). New `tests/vm/terminal-ui.spec.mjs` (playwright-core, chromium at /opt/pw-browsers/chromium-1194, serves repo root via `python3 -m http.server 8801`, desktop 1400x900) → PASS: VM tab lazy-load observed, Boot produces `SPRZ-TESTOS READY` in the xterm buffer within 60s, `VMTerm._emulator.serial0_send('abc')` produces `ABC` in the buffer. Ran both suites twice back-to-back, consistently green. Note: `playwright-core` isn't installed at the repo root — added `tests/vm/node_modules/playwright-core` as a symlink to the globally-installed `playwright`'s bundled copy (`/opt/node22/lib/node_modules/playwright/node_modules/playwright-core`) so the spec resolves it; this symlink lives only under `tests/vm/` per the file-ownership rule but will need a real dependency (or equivalent) on CI/other machines instead of relying on this sandbox's global install.
- [agent-C] VST Cloud Build shipped, touching only `vst/vstcloud.js` (new), `tools/skel/vst/**` (new), `tests/vst/**` (new) — did not edit SprizzleIDE.html/index.html/vm/**/.github/** at all (confirmed via `git status`/`git diff` before finishing; the SprizzleIDE.html changes present in the tree are Agent A's/B's concurrent edits, not mine). `vst/vstcloud.js` is a self-contained classic script that (a) registers `window.VSTCloud={open,generate,checkBuilds,downloadAsset}`, (b) self-inserts a "VST Cloud Build…" item into the existing Run-menu dropdown by locating the `.menu-dd-item` labelled "Run File" (with a 250ms/20-try retry loop for late DOM, and a silent no-op if the menu is never found — never throws), (c) is designed to be loadable either via a static `<script src>` another agent adds or injected at runtime (proved by the test, which injects it via `page.addScriptTag` against the unmodified page rather than depending on any integration point). It builds a glass modal (reusing the page's existing `.modal-overlay/.modal/.form-*/.btn-*` CSS classes so it matches the app's styling with zero new CSS) with honest copy: real VST3 win/mac/linux binaries require GitHub Actions in the user's own repo and "cannot be compiled client-side"; the in-VM path (`tools/skel/vst/`) is called out as genuinely on-device but Linux-only VST2, not a DAW-distributable VST3. Buttons: **Generate** writes `plugin/CMakeLists.txt` (JUCE 8 via FetchContent, `juce_add_plugin ... FORMATS VST3`, C++17), `plugin/Plugin.h`/`Plugin.cpp` (minimal `GainAudioProcessor`: stereo in/out, one gain param, `processBlock`/`createEditor` via `juce::GenericAudioProcessorEditor`, `createPluginFilter()` entry point) and `.github/workflows/vst3-build.yml` into `S.files` via the existing `mkFileFromAI`/`addGitChange`/`renderTree`/`persist` helpers (falls back to direct `S.files` writes if `mkFileFromAI` isn't present). **Push & start build** calls the existing global `ghPushChanges()` (prompts for a commit message, pushes all modified files including the new workflow) then best-effort fires an explicit `workflow_dispatch` via `ghPost` as a redundant safety net; guarded by `S.gh.token`/`S.gh.currentRepo` checks that redirect to `openGitHubConfig()` if missing. **Check builds** calls the existing `ghGet('/repos/'+repo+'/releases')`, filters `tag_name.startsWith('vst3-build-')`, and renders per-asset rows with size + Download button. **Download** fetches `GH+'/repos/'+repo+'/releases/assets/'+id` with `Authorization: Bearer <token>` + `Accept: application/octet-stream`, chunked-`btoa`-encodes the ArrayBuffer (32KB chunks, no call-stack blowups on large files), triggers a real browser download via `Blob`+`a[download]`, and stores it into `S.files['builds/'+name] = {content:base64, b64:true, lang:'binary', modified:true}` plus `addGitChange`/`renderTree`/`persist`. The generated workflow: `workflow_dispatch` + `push.paths: plugin/**`, matrix `[windows-latest, macos-latest, ubuntu-latest]`, Linux step installs `libasound2-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libfreetype6-dev libfontconfig1-dev`, `cmake -B build -S plugin -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release --parallel`, a `find`-based robust `.vst3` bundle locator + `zip` packaging step (handles the per-OS path/extension differences), uploads per-OS artifacts, then a `release` job downloads all of them and publishes via `softprops/action-gh-release@v2` tagged `vst3-build-${{github.run_number}}`. `tools/skel/vst/`: `vestige/vestige.h` (~215-line from-scratch VST2.4 ABI reimplementation — `AEffect` struct, `audioMasterCallback`/dispatcher/process typedefs, full `AEffectOpcodes` enum, `VstEvent(s)`/`VstMidiEvent` — written independently, not copied from any existing vestige.h distribution, since the ABI itself isn't copyrightable), `gain-vst2.c` (complete VST2 gain effect: `VSTPluginMain` builds a real `AEffect*`, `processReplacing` multiplies every channel by a clamped `[0,1]` gain param, dispatcher answers `effOpen/Close/GetEffectName/GetVendorString/GetProductString/GetVstVersion/CanBeAutomated/GetPlugCategory/...`, plus the classic non-Windows `asm("main")` alias trick so older Linux hosts that look for symbol `main` still find the entry point), `Makefile` (`gcc -shared -fPIC -o gain.so gain-vst2.c`, plus `clean`). Compiled and verified for real on this machine: `gcc -shared -fPIC -Wall -Wextra -I. -o gain.so gain-vst2.c` → clean build, zero warnings, `nm -D gain.so` shows both `VSTPluginMain` and `main` exported as real ELF symbols (native x86-64 here; Agent D's i686 Alpine image is the actual in-VM target and should cross-compile the same source without changes since nothing here is arch-specific). TESTS: `tests/vst/yaml-lint.mjs` — a self-contained, dependency-free structural YAML sanity checker (tabs, indentation-stack validity, quote balance, block-scalar (`|`/`>`) awareness) per the "no runtime deps in the repo" constraint; cross-validated during development against real `js-yaml` (installed only into the scratch dir, never the repo) on the actual generated workflow text — both agreed it parses clean, matrix/jobs/keys all present. `tests/vst/vst-generator.spec.mjs` (playwright-core, chromium at `/opt/pw-browsers/chromium-1194`, serves the repo via `python3 -m http.server 8803`, loads the real unmodified `SprizzleIDE.html`, then runtime-injects `vst/vstcloud.js` via `page.addScriptTag`) → **ALL PASS**: script injects and registers `window.VSTCloud`; menu item self-inserts into the real Run dropdown; modal opens with the honest client-side-limits copy; Generate (via the actual UI button, not a direct API call) writes all 4 files into `S.files` and they show up in `S.gitChanges`; CMakeLists contains `juce_add_plugin`/`FetchContent`/`FORMATS VST3`/C++17; Plugin.h/.cpp contain the processor class, `processBlock`, and `createPluginFilter`; the generated workflow YAML passes the structural sanity check and contains the win/mac/linux matrix, the Linux JUCE deps, the `vst3-build-${{github.run_number}}` tag, and `softprops/action-gh-release@v2`; "Check builds" against a stubbed `window.fetch` correctly filters an unrelated `v1.0.0-unrelated` release out and finds exactly the one `vst3-build-42` release; the builds list renders asset rows; and the download flow (`VSTCloud.downloadAsset`) against a 2048-byte stubbed asset produces `S.files['builds/...'] = {b64:true, lang:'binary', modified:true}` whose base64 content decodes **byte-identical** to the original stub payload (`Buffer.compare === 0`). Ran twice back-to-back, both green, exit 0. Added `tests/vst/node_modules/playwright-core` as a symlink to the same global playwright install (mirroring Agent A's `tests/vm/` precedent) and extended `.gitignore` with `tests/vst/node_modules/` accordingly — no runtime/repo dependency added, this is dev/test tooling only. Honest gaps for the audit wave: the generated JUCE/CMake project is structurally sound and was checked with a real parser-equivalent (js-yaml) plus targeted assertions, but was **not** built end-to-end through actual GitHub Actions/JUCE/CMake (no live repo/token available in this sandbox) — that first real run is the remaining trust gap or "sample projects" not yet been fully validated, out of scope for this dev sandbox and no keys/repo available to conduct a real workflow run. Did not touch persist()/hydrate()/restoreSystemDefaults (no new top-level `S.*` state was introduced — `S.files`/`S.gitChanges` already persist and already get reset by existing code paths).
- [agent-D] CI image build pipeline shipped, touching only `.github/workflows/build-vm-image.yml` (new), `tools/build-image/{Dockerfile,build.sh,mark_packed_manifest.py,.gitignore}` (new), `docs/VM-TOOLCHAIN.md` (new), `tests/vm/boot-linux-smoke.mjs` (new) — confirmed via `git status`/`git diff` before finishing that SprizzleIDE.html/index.html/vm/vmterm.js/vst/** changes present in the tree are Agents A/B/C's concurrent work, not mine. Fetched and read the REAL upstream v86 Alpine recipe directly from raw.githubusercontent.com before writing anything (docs/alpine.md does not exist upstream; the actual proven recipe is `tools/docker/alpine/{Dockerfile,Readme.md,build.sh}` + `examples/alpine.html` + `tools/fs2json.py`/`tools/copy-to-sha256.py`, all inspected line-by-line). Two deliberate deviations from the literal work-package wording, both because the fetched upstream source is more reliable than the a-priori guess: (1) single `docker build`+`create`+`export` (not two separate `docker run` invocations for kernel-vs-rootfs) — `linux-virt` + `mkinitfs -F "base virtio 9p" ...` all happen in one image build, exactly like upstream's own Dockerfile; (2) `fs2json.py`/`copy-to-sha256.py` are run directly against the exported tar (both scripts accept a tar-or-directory, confirmed by reading their argparse code) instead of extracting to a mounted directory first — simpler, no sudo/loop-mount needed. `tools/build-image/Dockerfile`: `i386/alpine:3.19` (per the work package; upstream defaults to 3.21.0, both are valid apk repos) + `alpine-base openrc agetty alpine-conf linux-virt linux-firmware-none bash gcc musl-dev make nasm binutils busybox-extras`; busybox `init`+`/etc/inittab` kept exactly as Alpine ships it (alpine-base's stock inittab already chains into OpenRC's sysinit/boot/shutdown runlevels, which is what actually mounts /proc, /sys, /dev — documented in-file why a hand-rolled `/sbin/init` or `/etc/fstab` proc/sys entries were deliberately NOT written: reproducing the vendor-proven combination is far lower first-try-CI-failure risk); only the getty lines are touched (`ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100`, stock ttyS0 line removed first to avoid a dual-getty race, empty root password via `chpasswd`); `COPY skel/ /root/skel/` reads from a build-context staging dir that `build.sh` populates from the *sibling* Agent C's `tools/skel/` (with a placeholder+README fallback if that path doesn't exist yet at build time, so this workflow's first run before Agent C's PR lands still succeeds, just with `caps.vst2:false`); trims `/usr/share/man,doc,licenses,i18n` for git-friendliness. `tools/build-image/build.sh`: stages skel, `docker build --platform linux/386`, `docker create`+`export`, deletes the `.dockerenv` export artifact, extracts standalone `vm/image/bzimage.bin`+`vm/image/initramfs.img` by grepping the tar member list for `boot/vmlinuz-*`/`boot/initramfs-*`, `git clone --depth1 copy/v86` fresh (not vendored) purely to borrow `tools/fs2json.py`/`tools/copy-to-sha256.py`, runs both against the tar (deliberately WITHOUT `--zstd` — v86 does support zstd 9p chunks per a direct read of `vm/vendor/libv86.mjs`'s `pa`/`yc` loader code, but skipped to avoid a `pip install zstandard` failure mode for a size win that isn't needed once the rootfs is trimmed), `du -sh` report. `.github/workflows/build-vm-image.yml`: `workflow_dispatch` + `push` to `tools/build-image/**`/the workflow file itself on `fullterminal`; sanity-checks `docker run --platform linux/386` works natively on the x86_64 runner (no QEMU needed, documented why) before the real build; runs `build.sh` then `node tests/vm/boot-linux-smoke.mjs`; size-checks (per-file <90MB AND total <300MB → commit vm/image/* directly with `[skip ci]`; else pack `alpine-rootfs-flat/` into a `alpine-rootfs.tar.zst` GitHub Release asset tagged `vm-image-latest`, keep the small metadata files committed, and rewrite `manifest.json` to `mode:"linux9p-packed"` with a `notes` field via the standalone `tools/build-image/mark_packed_manifest.py` — pulled out of an inline heredoc after discovering PyYAML would reject a flush-left heredoc body inside a `|` block scalar, see validation below). `tests/vm/boot-linux-smoke.mjs`: boots `{bzimage,initrd,filesystem:{basefs,baseurl}}` (all local-fs paths — confirmed by reading `vm/vendor/libv86.mjs`'s loader, which detects `process.versions.node` and reads paths via `fs.promises` directly, so no HTTP server is needed for the node harness, matching `boot-testos.mjs`'s existing pattern) with the exact command script specified, sentinel-marker-terminated so it doesn't hang waiting for markers that legitimately won't appear (e.g. `VST2=OK` if `tools/skel/vst` isn't there yet); hard-fails (nonzero exit) only on prompt-timeout/no-gcc/no-nasm/RC≠42/no-A64, and records `caps.ld64`/`caps.vst2` as non-fatal booleans per the work package; writes `vm/image/manifest.json` with the contracted fields (`mode,kernel,cmdline,fsjson,basefs,fallback`) PLUS an added `initrd` field and a `bzimage_initrd_from_filesystem:true` hint — **flagging as an open risk for Agent A/B integration**: the section-2 manifest contract as originally written has no `initrd` key, but a 9p-root Linux boot needs one (the "virt" kernel flavor is almost all modules); if `vm/vmterm.js` only reads `kernel`/`cmdline`/`fsjson`/`basefs` from the manifest it will fail to mount root — it must also pass `initrd: {url: manifest.initrd}` (or alternatively rely on the `bzimage_initrd_from_filesystem` flag and omit bzimage/initrd entirely, since the same kernel+initramfs files also live inside the 9p fs at `/boot/`, which v86 can autodetect). Also note `cmdline` in the emitted manifest is the section-2 contract string with `modules=virtio_pci tsc=reliable` appended (copied verbatim from upstream's own proven `examples/alpine.html`) — a superset, not a break, for any consumer treating it as space-separated kernel args. VALIDATION (all run in this sandbox, since the actual Alpine build itself cannot run here — no Alpine CDN access, confirmed once again by a live `curl` 404/reachability check against raw.githubusercontent.com succeeding while `apk`-style Alpine CDN access is the thing that's blocked): `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-vm-image.yml'))"` → **PASS** (pyyaml 6.0.1 already present, no scratchpad install needed) after fixing a real bug this caught — an embedded `git commit <<'EOF'` heredoc and a `python3 <<'PYEOF'` heredoc were both flush-left inside `run: |` block scalars, which YAML's indentation rules treat as prematurely closing the block; fixed by switching to multiple `-m` flags for the commit message and extracting the Python into standalone `mark_packed_manifest.py`. `node --check tests/vm/boot-linux-smoke.mjs` → **PASS**. `bash -n` + `shellcheck` (installed via apt for this check) on `build.sh` → **clean, zero findings**; shellchecked every embedded `run:` block extracted from the workflow YAML too → clean except two expected false positives (SC2296 on `${{ github.ref_name }}`, which is a GitHub Actions template token substituted before bash ever sees it, not real bash syntax; SC2015 info-level note on an intentional `A && B || true` idempotent-delete pattern). Ran the *existing* `node tests/vm/boot-testos.mjs` after all edits to confirm the floppy-fallback proof-of-pipeline is untouched → still **PASS**. Also ran `node tests/vm/boot-linux-smoke.mjs` directly against this sandbox (no built assets) to confirm its preflight check fails clearly rather than hanging/crashing → correctly printed a "run tools/build-image/build.sh first" message and exited 1. Cleaned up a stray `tools/build-image/__pycache__/` created by my own `py_compile` validation run (removed + gitignored) that had been swept into an automatic mid-session "WIP checkpoint" commit (`307fd52`, an infra durability snapshot across all agents' in-flight work, not something I committed myself — no `git commit`/`push` was run by me per the rules). OPEN RISKS for the audit wave: (1) the manifest `initrd` gap above — needs Agent A/B's `vmterm.js` to be checked/updated to consume it, or this whole pipeline's boot will silently fail to mount root even though the image built and smoke-tested fine in CI; (2) this entire pipeline is UNTESTED end-to-end for real (no Docker+Alpine-CDN network in this sandbox) — its very first live signal will be its first real run on `push`/`workflow_dispatch` in GitHub Actions; if the base image tag, package set, or `mkinitfs` feature list has drifted upstream since this was written, that first run is where it'll surface, not here; (3) size is unverified — a real Alpine+gcc+kernel rootfs may or may not land under the 90MB-per-file/300MB-total thresholds after trimming; the release-asset fallback path is written and shellchecked but likewise never exercised against a real tarball.
