# Audit E1 — Code / Regression Integrity (fullterminal branch)

Auditor: Agent E1. Scope: docs/ORCHESTRATION.md §3 E1. Read-only audit —
no source files edited, no commits made. Repo state audited: branch
`fullterminal`, working tree clean, HEAD `222fa32`.

## SUMMARY: **CONCERNS**

All static-integrity checks pass (no syntax errors in the main script,
`vm/vmterm.js`, or `vst/vstcloud.js`). All 6 new fullterminal test suites
pass. All 10 pre-existing regression harnesses pass (only documented
benign `false` keys present). `SprizzleIDE.html`/`index.html` differ by
exactly the one expected banner line. Broken-reference sweep of the *new*
VM/VST wiring (panel tab, toolbar buttons, menu injection, lazy loader)
found nothing broken — it's all correctly guarded and consistent.

However, the binary-safety sweep (item 4) found **one real, unguarded
content-corruption path** introduced by the fullterminal binary-safety work
itself: `replaceSelectionOrFile()` (the function that applies an
auto-applied AI ` ```replace ` fenced code block) never checks
`S.files[path].b64`, unlike every sibling function that touches file
content. That's a MAJOR finding and the reason for CONCERNS rather than
PASS. Everything else found is a **pre-existing** defect, confirmed
byte-identical to the branch's base commit `d823983` (pre-fullterminal
main @ v2.8.8) — not a regression introduced by this branch's work, but
listed here since the audit surfaced it.

## TEST RESULTS (verbatim key lines)

### New (fullterminal) suites
```
$ node tests/vm/boot-testos.mjs
banner received; sending probe "hello123"
PASS: banner + uppercased echo round-trip OK
(exit 0)

$ node tests/vm/terminal-ui.spec.mjs
[page error] Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED   (blocked-CDN noise, expected)
[page error] Failed to load resource: the server responded with a status of 404 (File not found)  (expected — no manifest.json yet)
PASS: banner "SPRZ-TESTOS READY" observed in xterm buffer
PASS: serial echo "ABC" observed in xterm buffer
PASS: terminal-ui.spec.mjs — VM tab lazy-load, boot, and serial round-trip all OK
(exit 0)

$ node tests/vm/sync-bridge.mjs
[page error] ... (blocked-CDN / 404-manifest noise, expected)
PASS: sync-bridge.mjs — syncIn/syncOut binary-safe round-trip through a fake 9p stub,
marker file excluded, git-change status correct, floppy-mode honesty verified
(exit 0)

$ node tests/vm/zip-binary-roundtrip.mjs
PASS: zip-binary-roundtrip.mjs — text file (41B) and binary file (1024B) both
round-tripped byte-identically through buildProjectZip()
(exit 0)

$ node tests/vst/yaml-lint.mjs
(no output; exit 0 — see FINDINGS, this file is a library not a self-test, see below)

$ node tests/vst/vst-generator.spec.mjs
PASS: vst/vstcloud.js injected at runtime and window.VSTCloud registered
PASS: "VST Cloud Build…" menu item self-inserted into the Run menu dropdown
PASS: VSTCloud.open() shows the glass modal
PASS: modal copy is honest about VST3 build location constraints
PASS: Generate button reports 4 files generated
PASS: S.files contains all 4 generated project files, and git-changes tracks them
PASS: CMakeLists.txt contains juce_add_plugin / FetchContent / FORMATS VST3 / C++17
PASS: Plugin.h/Plugin.cpp contain a minimal, structurally sane JUCE gain processor + editor
PASS: generated GitHub Actions workflow YAML passes structural sanity check
PASS: Check builds lists releases filtered to tag_name startsWith "vst3-build-"
PASS: builds list renders per-asset rows with names/sizes and Download buttons
PASS: asset download decodes to byte-identical content and is stored in S.files as {b64:true}
ALL PASS: vst-generator.spec.mjs
(exit 0)
```

### Pre-existing regression harnesses (scratchpad)
All 10 ran, all exit 0, no unexpected `false`/error markers:

| Harness | Result |
|---|---|
| search-test.js | PASS (desktop + mobile highlight-overlay checks all true) |
| ai-test.js | PASS (tool loop, chat rendering, badReplace guard all true) |
| edit-test.js | PASS (EDIT/REPLACE tool loop, junk-suppression all true) |
| mem-echo-test.js | PASS (metered echo/notes recovery all true) |
| backend-test.js | PASS (URL/key normalization, Anthropic/Gemini checks all true) |
| ctx-test.js | PASS (only benign `needsHi`/`needsHi2`/`isMobile` false) |
| folder-test.js | PASS (subfolder create/delete, ctx menu items all true) |
| singleshot-test.js | PASS (only benign `*_isSingle:false` for large/project/local/webllm cases, which is correct behavior — single-shot is intentionally NOT used in those cases) |
| rate-test2.js | PASS (reentrancy guard, 429 handling, metered spacing — only benign `webllmMetered:false`/`meteredSpaced:false`) |
| project-ctx-test.js | PASS (Project chip order/toggle/tree-injection all true) |

No unexplained `false`/`FAIL`/uncaught error found in any of the 10.

### index.html vs SprizzleIDE.html
```
$ diff SprizzleIDE.html index.html
2151c2151
< tw('SprizzleIDE v2.7  |  Project Cache + ZIP import/export + Line Search');
---
> tw('SprizzleIDE v2.9.0-ft  |  FULL TERMINAL');
```
Exactly one line differs, as required. Confirmed.

### Static integrity
- Main `<script>` (SprizzleIDE.html, 1353 lines, HTML lines 927–2280): `node --check` → **OK**, no syntax errors.
- `vm/vmterm.js` (320 lines): `node --check` → **OK**.
- `vst/vstcloud.js` (632 lines): `node --check` → **OK**.

## FINDINGS

### MAJOR — SprizzleIDE.html:1637, invoked at :1781 — binary file corruption via AI auto-apply `replace` block
`replaceSelectionOrFile(snippet)` is the function invoked automatically
(line 1781: `else if(b.target==='active'&&b.target!=='file'){replaceSelectionOrFile(b.code);applied++;}`)
whenever a model's reply contains a ` ```replace ... ``` ` fenced block. Unlike
every other function in the codebase that mutates `S.files[path].content`
(`saveFile` :1120, `saveFileAs` :1121, the editor Tab-key handler :1191,
`applyAIBlock` mode `'replace'` :1628, and `insertAtCursor` :1636 — all of
which check `S.files[...].b64` first and refuse with a warning toast),
`replaceSelectionOrFile` performs **no b64 check at all**:
```
function replaceSelectionOrFile(snippet){if(!S.activeTab){tw('AI tried to replace code but no file is open.','warn');return;}
  const start=editor.selectionStart,end=editor.selectionEnd;
  if(start===end){editor.value=snippet;...}else{...}
  S.files[S.activeTab].content=editor.value;S.files[S.activeTab].modified=true;renderTabs();renderTree();
}
```
If a binary (`b64:true`) file is the active tab and the model emits a
` ```replace ` block (readOnly on the `<textarea>` does not stop this —
this path writes to `S.files` directly, bypassing the DOM `readOnly` flag
entirely), the file record ends up with `b64:true` / `lang:'binary'` but
`content` now holding **plain, non-base64 text**. Every downstream
binary-safe consumer that trusts `b64:true` (ZIP export via
`buildProjectZip` :1129, `downloadCurrentFile` :1122's `atob()` path inside
`fileGetBytes` :1015, `ghPushChanges` :1322's `file.b64?file.content:...`
branch, the terminal `cat` command :1276) will then try to `atob()` or
upload/download that plain text as if it were valid base64 — this is
precisely the corruption class the whole binary-safety effort (§2 of
ORCHESTRATION.md) exists to prevent, and it slipped through Agent B's
otherwise-thorough sweep.
**Suggested fix**: add `if(S.files[S.activeTab]?.b64){tw(...,'warn');return;}` at
the top of `replaceSelectionOrFile`, mirroring `insertAtCursor` line 1636 —
or simply route the line-1781 call through the existing, already-guarded
`applyAIBlock(...,'replace')` logic instead of a second, unguarded
implementation.

### MINOR (pre-existing, confirmed unchanged since base commit `d823983` — not a fullterminal regression) — SprizzleIDE.html:408-410 — dead `termWrite(...)` onclick handlers
```
<div class="menu-dd-item" onclick="termWrite('npm install','info')">...
<div class="menu-dd-item" onclick="termWrite('npm start','info')">...
<div class="menu-dd-item" onclick="termWrite('npm run build','info')">...
```
No function or variable named `termWrite` is ever defined anywhere in the
file (the real helper is `tw(text,cls)` at line 1266). Clicking any of
these three Terminal-menu shortcuts throws `ReferenceError: termWrite is
not defined` in the console and does nothing. `git show d823983:SprizzleIDE.html`
contains the identical three lines, so this predates all VM/VST/audit
work on this branch — flagged for completeness since the task asked to
confirm no pre-existing handler is broken, and this one already was.
Trivial fix if anyone wants it: rename `termWrite` → `tw` at those 3 sites.

### MINOR (pre-existing, confirmed unchanged since `d823983`) — SprizzleIDE.html:205 vs :597-598 — Problems/Output panel tabs can never show
`.hidden{display:none!important;}` (line 205) is present on both
`#panel-problems` and `#panel-output` (`class="hidden"`, lines 597-598).
`switchPanelTab()`/`switchPanelTabById()` (lines 2052-2053) toggle
visibility only via `el.style.display='flex'|'none'` — an inline style can
never beat an `!important` class rule, so clicking the "Problems" or
"Output" tab never actually reveals those panels; only "Terminal" and the
new "VM" tab (which — correctly — was NOT given the `hidden` class, only
a plain inline `display:none`) can be shown. Confirmed byte-identical to
base commit `d823983`; Agent A's own status-log entry (§6 of
ORCHESTRATION.md) already called this out as a known pre-existing quirk
deliberately left alone as out-of-scope, and confirms the new VM tab was
built to sidestep it rather than share it. Not introduced by this branch.

### MINOR (pre-existing, confirmed unchanged since `d823983`) — SprizzleIDE.html:1964-1967 — `S.ctx` toggle state not persisted/restored
`S.ctx.{file,selection,errors,project}` (the AI context chips, including
the pre-branch "Project" chip added in commit `67ab417`) is written by
`toggleCtx()` but never included in `persist()`/`hydrate()` — the chip
selection always resets to the hard-coded default
(`file:true,selection:false,errors:false,project:false`) on reload.
`restoreSystemDefaults()` *does* reset it correctly (line 1967:
`Object.assign(S.ctx,{file:true,selection:false,errors:false,project:false})`),
so there is no restore-defaults gap — only a hydrate gap, and it treats
the old fields and the newer `project` field identically (i.e. this isn't
an inconsistency the branch introduced; the same gap already existed for
`file`/`selection`/`errors` before `project` was added). `persist()` and
`hydrate()` are byte-identical to the base commit — confirmed via diff —
so no fullterminal-branch code path touches this at all.

### MINOR (pre-existing, confirmed unchanged since `d823983`) — SprizzleIDE.html:1967 — `restoreSystemDefaults()` leaves stale `S.gitChanges`/`S.problems`/terminal history
`restoreSystemDefaults()` wipes `S.files`, tabs, AI/GH config, editor
settings, and `S.ctx`, but never clears `S.gitChanges`, `S.problems`,
`S.termHist`/`S.termIdx`, or `S.activeActivity`, nor the `#git-changes`
DOM list. Since `S.files` is wiped to `{}`, the Git Changes sidebar can be
left showing entries that reference files which no longer exist. None of
these fields are persisted to `localStorage` either way, so this is a
same-session cosmetic issue only, not a reload/corruption issue. Confirmed
byte-identical function text at base commit `d823983` — pre-existing, not
part of the VM/VST/binary-safety work.

### NOTE (test-harness gap, not a product-code defect) — tests/vst/yaml-lint.mjs
This file is a pure ESM library (`export function checkYamlSanity`,
`export function assertYamlSane`) with no top-level self-test or CLI
entry point — its own header comment says "Usage: import {
checkYamlSanity } from './yaml-lint.mjs'". Running
`node tests/vst/yaml-lint.mjs` directly (as the test matrix in
ORCHESTRATION.md §4 and this audit's own instructions literally specify)
does nothing and exits 0 — a trivially "green" result that isn't actually
testing anything when invoked standalone. The real assertions only run
inside `tests/vst/vst-generator.spec.mjs`, which does correctly import and
exercise `assertYamlSane` against the real generated workflow YAML (and
that suite passed, see TEST RESULTS above), so the underlying capability
*is* verified — just not by the specific command the test matrix names.
Recommend either giving `yaml-lint.mjs` a direct-run branch
(`if (import.meta.url === 'file://'+process.argv[1]) { ...self-test... }`)
or updating the test-matrix docs to point at `vst-generator.spec.mjs` for
this check.

## NON-ISSUES CHECKED

- `switchPanelTab`/`switchPanelTabById` (SprizzleIDE.html:2052-2053): correctly
  extended to the 4-tab array `['terminal','problems','output','vm']`,
  matching the 4 real `.panel-tab` DOM nodes in document order (lines
  579-582). No off-by-one or stale 3-element array left over.
- `vmtermBoot/Stop/SyncIn/SyncOut()` wrapper functions (SprizzleIDE.html:2074-2077):
  all guarded with `window.VMTerm&&VMTerm.X&&VMTerm.X()`, safe no-ops before
  the lazy loader finishes.
- `loadVMTermLazy()` (SprizzleIDE.html:2057-2072): sequential script/css
  injection with per-file `onerror` → red status dot + in-mount error text;
  double-invocation guarded by `_vmtermLoadState`.
- `vst/vstcloud.js` menu self-registration: `.menu-dd-item`/`.menu-dropdown`/
  `.menu-dd-sep` CSS classes all exist in SprizzleIDE.html; "Run File" text
  match + `.closest('.menu-dropdown')` correctly locates the real Run menu
  (confirmed live in vst-generator.spec.mjs).
- `window.V86` / `window.Terminal` globals: confirmed exported by
  `vm/vendor/libv86.js` (`window.V86=P`) and `vm/vendor/xterm.js` UMD
  wrapper; both proven live by the passing terminal-ui/sync-bridge suites.
- `vm/vmterm.js`'s `VMTerm._fs` (`makeFs9pFs`) contract: `{mkdir,write,read,readdir}`
  matches what `syncIn`/`syncOut`/`walkFs`/the marker poll all actually call;
  gated correctly on `_mode==='linux9p' && emulator.fs9p` (fixes the latent
  `manifest.filesystem` gate bug the orchestration log says Agent B found —
  confirmed the fix is in place at vmterm.js:200).
- `vm/image/manifest.json` does not exist yet (expected — CI image build
  hasn't run); `boot()` correctly falls back to the floppy testos.img path,
  and `tests/vm/boot-linux-smoke.mjs` (CI-only, not in the required matrix)
  fails clearly and immediately with a helpful message rather than hanging —
  verified: exit code 1, "FAIL: missing required asset for 'bzimage'...".
- All 22 `.b64` check sites across `openTab`, `fileGetBytes`/`fileSetBytes`,
  `saveFile`, `saveFileAs`, `downloadCurrentFile`, `buildProjectZip`,
  `buildPreview`'s CSS/JS inliners, `globalSearch`, terminal `cat`,
  `ghPushChanges`, `execAITool` (LIST/SEARCH/READ/REPLACE/EDIT),
  `insertAtCursor`, `applyAIBlock`, `projectTreeText`, `buildSys`,
  `aiSingleShot`, `buildSingleShotSys` — all correct except the one MAJOR
  finding above.
- `importZipFromBuffer`/`handleZipImport`/drag-drop-zip path: correctly
  routes every zip entry through `fileSetBytes(name, uint8array)` rather
  than forcing `.async('string')` — binary ZIP entries are not corrupted
  on import.
- `vst/vstcloud.js`'s `downloadAsset()`: correctly stores
  `{content:b64, b64:true, lang:'binary', modified:true}` and the byte
  round-trip was proven identical via `Buffer.compare===0` inside
  vst-generator.spec.mjs.
- No new top-level `S.*` state was introduced by the VM/VST work (only a
  per-file optional `.b64` flag on existing `S.files[path]` entries, which
  round-trips through `JSON.stringify`/`JSON.parse` for free) — confirmed
  by diffing `persist()`/`hydrate()`/`restoreSystemDefaults()` against the
  base commit `d823983` and finding them byte-identical. No localStorage
  keys beyond the pre-existing `nide_ai/nide_gh/nide_files/nide_editor/nide_settings`
  are used anywhere in `vm/vmterm.js` or `vst/vstcloud.js`.
- Mobile bottom-dock (`mobSetView`) has no dedicated "VM" view button —
  this is an interface-completeness question for the E2 audit wave, not a
  broken reference (the VM tab is still reachable inside the bottom panel
  once `mobSetView('terminal')` reveals it); noted here only to avoid
  double-flagging in E2.
