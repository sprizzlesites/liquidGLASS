# Audit E2 — Interface Flow (Desktop + Mobile)

**Scope**: SprizzleIDE `fullterminal` branch, `SprizzleIDE.html` served locally
(`python3 -m http.server 8811`), driven with `playwright-core` +
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome --no-sandbox`. Desktop
1400x900 and mobile 390x844 (iPhone UA, `isMobile:true`, `hasTouch:true`).
Report-only — no source files were edited. All throwaway driver scripts live
under `/tmp/claude-0/.../scratchpad/e2/*.mjs` (not committed).

## SUMMARY: **CONCERNS**

The VM feature itself (boot/stop/sync/keyboard/mobile-notice/glass styling)
works correctly and matches the orchestration plan's honest-fallback design.
No new console errors or uncaught exceptions were produced by any VM/VST
control. However, this audit found **one pre-existing, user-visible dead-UI
bug** that squarely fails this audit's "every bottom-panel tab shows the
right panel and hides others" requirement: the **Problems** and **Output**
bottom-panel tabs never actually display their content — clicking them blanks
the panel instead of showing anything. This is not something Agents A/B/C/D
introduced for this feature (Agent A's status-log entry explicitly flagged
awareness of it and left it alone as "out of scope/pre-existing"), but it is
real, currently reproducible, and directly inside this audit's checklist, so
it is reported as a CONCERN rather than waved through. Two low-severity UX
nits (silent no-op re-clicks of Boot/Stop, and no inline status text on a
blocked "Check builds" click) are also noted. Everything else — VM tab lazy
load/boot/stop/toolbar/sync-notices, VST modal open/close/generate/push/check,
activity-bar views, mobile dock, glass styling, keyboard focus — is a clean
PASS.

---

## 1. Bottom-panel tabs / activity-bar views / VST menu (desktop 1400x900)

### 1a. Bottom-panel tabs — **FAIL (pre-existing bug, in-scope)**
Script: `desktop1.mjs`. Clicked each `.panel-tab` and read the **computed**
`display` of `#panel-terminal` / `#panel-problems` / `#panel-output` /
`#panel-vm`.

| tab clicked | terminal | problems | output | vm |
|---|---|---|---|---|
| terminal | flex | none | none | none |
| problems | none | **none** | none | none |
| output | none | none | **none** | none |
| vm | none | none | none | flex |

Clicking **Problems** or **Output** correctly hides Terminal/VM but the
target panel itself stays `display:none` — the bottom panel goes entirely
blank. Root cause (confirmed by direct inspection): `SprizzleIDE.html` lines
597-598 give both `<div id="panel-problems" class="hidden" …>` and
`<div id="panel-output" class="hidden" …>` the class `hidden`, and
`.hidden{display:none!important}` (line 205 CSS). `switchPanelTab()` (line
2052) only ever sets `.style.display='flex'` on these elements via inline
style — it never removes the `hidden` class — and a class rule with
`!important` always wins over an inline style, `!important` or not. So the
inline `flex` is silently overridden forever. `#panel-terminal` and
`#panel-vm` don't have `class="hidden"` in the markup, which is exactly why
only those two tabs work.
- **Repro**: open `SprizzleIDE.html`, click the **Problems** tab (or
  **Output**) in the bottom panel. Panel area goes blank; DevTools shows
  `getComputedStyle(panel-problems).display === 'none'` even though
  `panel-problems.style.display === 'flex'`.
- **Confirms it's not a CSS-cascade illusion**: the exact same
  toggle-both-class-and-style pattern is used correctly elsewhere in this
  same file for the activity-bar sidebar views (`setActivity()`, line 2083:
  `el.style.display=show?'flex':'none'; el.classList.toggle('hidden',!show);`)
  — i.e., the fix pattern already exists in the codebase, it just wasn't
  applied to the two older bottom-panel tabs.
- **Severity**: HIGH (2 of 4 bottom-panel tabs are completely non-functional;
  directly inside this audit's pass/fail bar).
- **Suggested fix**: in `switchPanelTab()`, either drop `class="hidden"` from
  the `panel-problems`/`panel-output` markup (matching `panel-terminal`/
  `panel-vm`), or add `document.getElementById('panel-'+name).classList
  .remove('hidden')` / re-add `hidden` to the others alongside the existing
  inline-style toggle, exactly like `setActivity()` already does.
- Not caused by, and not touched by, any of the VM/VST/sync work — pre-dates
  this branch's new panel-vm tab, which deliberately avoided the same trap
  (per Agent A's own status-log note) by using a bare inline `display:none`
  with no `hidden` class.

### 1b. Activity-bar views — **PASS**
Script: `desktop1.mjs` / `debugActivity.mjs`. `files`/`search`/`git`/`github`
buttons all exist, correctly get `.active`, and — verified via computed
`display` of `#files-panel` / `#search-panel-sidebar` / `#git-panel-sidebar`
/ `#github-panel-sidebar` — each view shows itself and hides the other three
with no exceptions:
```
files:  {files:flex, search:none, git:none,  github:none}
search: {files:none, search:flex, git:none,  github:none}
git:    {files:none, search:none, git:flex,  github:none}
github: {files:none, search:none, git:none,  github:flex}
```
`settings` is a gear-icon button that opens `#settings-modal` (not an
activity-view) — confirmed it opens and its `.modal-close` closes it cleanly.

### 1c. VST Cloud Build menu item — **PASS**
Script: `desktop1.mjs`. Opening the **Run** menu (click → `.menu-open` class
→ dropdown becomes visible) shows: `Run File`, `Live Preview`, `npm install`,
`npm start`, `npm build`, **`VST Cloud Build…`** — the new item is present
and in the right menu. Clicking it opens `#vstcloud-modal`
(`visibleOverlayCount:1`, title "VST Cloud Build"); clicking `.modal-close`
closes it (`visibleOverlayCount` back to 0). No exceptions.

---

## 2. VM tab lifecycle (desktop) — **PASS**
Script: `desktop_vm.mjs`. All in floppy/test-OS fallback mode (no
`vm/image/manifest.json` exists yet on this branch, exactly as documented in
§5/§6 of `ORCHESTRATION.md` — the one 404 for `vm/image/manifest.json` seen
in every run is this expected, by-design probe, not a bug).
- **Lazy load**: switching to the VM tab injects xterm/libv86/vmterm and
  `window.VMTerm._term` appears within the wait window. PASS.
- **Toolbar buttons present**: `Boot`, `Stop`, `⬇ To VM`, `⬆ From VM` — all 4,
  matching the work package. PASS.
- **Sync buttons before boot**: `vmtermSyncIn()`/`vmtermSyncOut()` do not
  throw and `vmtermSyncIn()` prints the honest in-terminal notice: *"sync
  requires the Linux VM image (this session is running the floppy/test-OS
  fallback, which has no project filesystem — see docs/ORCHESTRATION.md)."*
  Exact match confirmed programmatically. PASS.
- **Boot**: click → `SPRZ-TESTOS READY` observed in the xterm buffer within
  the 60s budget (actual time ~ a few seconds). `VMTerm.isRunning()` → `true`,
  status dot/text → `running` (green `rgb(78,201,160)`). PASS.
- **Double-boot guard**: calling `vmtermBoot()` again immediately after an
  already-successful boot does not throw and does not produce a second
  `[vmterm] booting floppy test OS…`/`SPRZ-TESTOS READY` sequence in the
  buffer (only one instance of each present) — confirmed both empirically and
  in source: `vm/vmterm.js:154` `if (this._booting || this.isRunning())
  return;`. PASS (functionally guarded).
- **Sync buttons while running (still floppy mode)**: same honest notice
  reprinted, still no throw. PASS.
- **Stop**: click → `isRunning()` → `false`, status text → `stopped`. Calling
  `vmtermStop()` again afterward does not throw (`vm/vmterm.js:216`:
  `if (!this._emulator) { this._fs=null; return; }`). PASS.
- **Screenshot**: `docs/audit-E2-desktop-vm.png` — VM tab visible, active,
  booted, toolbar all visible, status dot green "running".

### Minor nit (LOW severity)
Re-clicking **Boot** while already running, or **Stop** while already
stopped, is a silent no-op — no toast/status line distinguishes "ignored,
already running" from a fresh action, and neither button is visually
disabled/greyed while running. Functionally harmless (verified: no duplicate
VM instance, no crash, no dangling emulator), but technically a "no feedback"
edge relative to this audit's bar. Suggested fix: a one-line `tw('VM already
running','warn')` (mirrors the pattern already used by `vst/vstcloud.js`'s
own guarded buttons) or toggle a `disabled` attribute on Boot while
`isRunning()`.

---

## 3. Dead/disabled-control sweep

### VM toolbar — **PASS** (see §2 above; all 4 buttons produce visible,
correct effects; the only gap is the LOW-severity re-click nit above, not a
dead button).

### VST Cloud Build modal — **PASS**
Script: `vst_buttons.mjs`, run with no GitHub token/repo configured (worst
case for "does it silently do nothing").

| button | threw? | feedback observed |
|---|---|---|
| Generate project + workflow into file tree | no | inline status text: `Generated 4 file(s) into the project tree: plugin/CMakeLists.txt, plugin/Plugin.h, plugin/Plugin.cpp, .github/workflows/vst3-build.yml`; confirmed the 4 files really land in `S.files` |
| Push & start build (no GH token) | no | `safeTw(...,'warn')` toast/terminal line **and** `#github-modal` opens (`openGitHubConfig()`) |
| Check builds (no GH token) | no | same warn toast; `#github-modal` opens again; terminal panel text contains "connect a GitHub account…" |
| Close (✕) | no | `#vstcloud-modal` gets `.hidden` back |

One nit: the modal's own inline `#vstc-status` line stays empty on the
blocked Check-builds click (the warn feedback lands in the terminal +
GitHub-config modal instead of the modal's own status line) — real,
visible feedback happens, just not in the most locally-obvious place.
Cosmetic, not counted as a failure.

---

## 4. Mobile (390x844, iPhone UA, `isMobile:true`, `hasTouch:true`) — **PASS**
Scripts: `mobile1.mjs`, `mobile_dock_full.mjs`.
- `isMobileDevice()` correctly returns `true` under the iPhone UA.
- Glass dock (`#mob-dock`) present, all 4 buttons (Code/Files/Term/AI) exist,
  visible, and **within the 390px viewport** (`dockRect.x:14, right:376`,
  each button rect inside bounds) — nothing pushed offscreen.
- Clicking each dock button (`editor`/`files`/`terminal`/`ai`) correctly
  flips `#app[data-mview]` to match every time.
- **VM reachable via dock → bottom-panel flow**: `Term` dock button →
  `data-mview="terminal"` → bottom panel visible → panel-tabs row visible →
  `switchPanelTabById('vm')` → `window.VMTerm._term` appears, `#panel-vm`
  computed `display !== 'none'`. Exactly the flow the work package asked to
  confirm still works.
- **Mobile memory notice**: on Boot, the xterm buffer contains
  `[system] The VM needs significant memory (32-256MB) and works best on
  desktop. Mobile browsers (especially iOS Safari) may kill the tab.` before
  the boot sequence — confirmed present and shown once. `SPRZ-TESTOS READY`
  still reached within the 60s budget on mobile too.
- **Glass styling spot-check**: `getComputedStyle('#header').backdropFilter`
  → `blur(24px) saturate(1.7)`; `getComputedStyle('#mob-dock').backdropFilter`
  → `blur(30px) saturate(1.8)`. Both present and non-empty.
- **No horizontal page overflow**: `document.documentElement.scrollWidth
  (390) <= window.innerWidth (390)`.
- Screenshot: `docs/audit-E2-mobile-vm.png`. Visual review of the screenshot
  shows the header's "GitHub" menu item and the status bar's "Ln 1, Col 1"
  text partially cut off at the viewport edge — **investigated, not a
  regression**: `#header-scroll` and `#status-bar` both use deliberate
  `overflow-x:auto; white-space:nowrap` on mobile (pre-existing app-wide
  design, not new for this branch) so both strips scroll horizontally by
  design; a user can swipe them to reach the clipped items. Likewise the
  xterm text lines that appear to "cut off" mid-word (e.g. "…emulator
  (Boo" / "t to start)") are normal, *correct* terminal hard-wrap at a
  narrower column count that the VM tab's manual resize logic computed for
  the 390px mount — the wrapped continuation starts at column 0 and nothing
  is actually lost. Neither is a real bug.

---

## 5. Keyboard focus / input path (desktop) — **PASS**
Script: `desktop_vm.mjs`.
- xterm renders a real `<textarea class="xterm-helper-textarea" tabindex="0">`
  inside `#vmterm-mount`.
- Clicking into the terminal mount focuses that textarea
  (`document.activeElement === textarea` confirmed).
- **Real keyboard path**: `page.keyboard.type('hello')` (i.e. genuine DOM key
  events through `term.onData`, not a simulated API call) produced `HELLO`
  echoed back from the guest — proves `term.onData → serial0_send` is wired
  end-to-end, not just the reverse direction.
- **Programmatic path** (`VMTerm._emulator.serial0_send('xyz')`) also echoed
  `XYZ` correctly — both directions of the serial bridge work.

---

## Findings summary (severity / what / repro / fix)

1. **HIGH — Problems/Output bottom-panel tabs never show content (pre-existing, not new-work-introduced, but in-scope for this audit).**
   Repro: click **Problems** or **Output** tab in bottom panel → panel goes
   blank forever (`getComputedStyle(...).display` stuck at `none` despite
   inline `style.display='flex'`) because both elements carry
   `class="hidden"` (`display:none!important`) that `switchPanelTab()` never
   clears. Fix: remove `class="hidden"` from `#panel-problems`/`#panel-output`
   markup (matching `#panel-terminal`/`#panel-vm`), or toggle the `hidden`
   class alongside the inline style the same way `setActivity()` already
   does for the sidebar views.

2. **LOW — Boot/Stop re-clicks are silent no-ops.** Clicking Boot while
   already running, or Stop while already stopped, correctly does nothing
   harmful (guarded in `vm/vmterm.js`) but gives no user-visible
   acknowledgement and the buttons aren't visually disabled while running.
   Suggested: a short `tw('VM already running/stopped','warn')` line or a
   `disabled` toggle on Boot while `VMTerm.isRunning()`.

3. **LOW — VST modal's inline status line stays blank on a blocked "Check
   builds" click** (no GH token). Real feedback does happen (warn toast in
   the terminal + the GitHub-connect modal opens), just not echoed into the
   VST modal's own `#vstc-status` line the way the equivalent success/failure
   paths do. Cosmetic inconsistency, not a functional dead button.

No other dead controls, no uncaught `pageerror` exceptions, and no console
errors beyond the explicitly-expected blocked-CDN noise
(FontAwesome/cdnjs/esm.run `ERR_TUNNEL_CONNECTION_FAILED`) and the
by-design `vm/image/manifest.json` 404 probe (floppy-fallback detection)
were observed across all desktop and mobile runs.

## Screenshots
- `/home/user/liquidGLASS/docs/audit-E2-desktop-vm.png` — desktop 1400x900,
  VM tab active, booted, `running` status.
- `/home/user/liquidGLASS/docs/audit-E2-mobile-vm.png` — mobile 390x844
  (iPhone UA), reached via dock → Term → VM tab, booted, mobile memory
  notice visible, glass dock intact.
