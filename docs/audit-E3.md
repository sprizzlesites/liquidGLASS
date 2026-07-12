# Audit E3 — Requirements vs. Delivered (`fullterminal` branch)

**Auditor**: Agent E3 (report-only, read-only, no edits/commits made)
**Scope**: `docs/ORCHESTRATION.md` §1 (user requirements) vs. actual code in this
checkout. Cross-checked `docs/VM-TOOLCHAIN.md` against
`.github/workflows/build-vm-image.yml` + `tools/build-image/Dockerfile`.
**Repo state at audit time**: HEAD `222fa32` ("Agent B + integration..."),
`vm/image/` contains **only** `testos.img` — **no `manifest.json`, no
`bzimage.bin`, no Alpine rootfs** exist in this checkout. This independently
confirms the status log's claim that the CI image build has never
successfully run against this branch. Every "real toolchain" capability below
is therefore currently **inert** in this exact checkout and activates only
once `.github/workflows/build-vm-image.yml` runs and publishes.

Tests actually re-run during this audit (both passed):
- `node tests/vm/boot-testos.mjs` → PASS (banner + uppercased serial echo)
- `node tests/vm/terminal-ui.spec.mjs` → PASS (VM tab lazy-loads, boots
  floppy fallback, serial round-trip works in a real headless-chromium load
  of the unmodified `SprizzleIDE.html`)

---

## REQUIREMENTS TABLE

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| 1 | Full bash terminal in project/blob, genuine VM (not simulation) | **PARTIAL: IMPLEMENTED (core mechanism) / IMPLEMENTED-VIA-CI (real toolchain)** | `vm/vmterm.js:198` (`new V86(opts)`, real vendored engine `vm/vendor/libv86.js`/`v86.wasm`/`seabios.bin`, 2.4MB wasm — not a fake), xterm bound to `serial0-output-byte`/`serial0_send` (`vm/vmterm.js:135,202`). Proven genuinely executing via `tests/vm/boot-testos.mjs` (PASS, re-run live) and `tests/vm/boot-linux-smoke.mjs` (drives `gcc --version`/`nasm -v`/a real compiled program returning exit code 42 — but only runs once Alpine assets exist). Sync bridge (`syncIn`/`syncOut` in `vm/vmterm.js:226-287`) walks `S.files` and writes into the guest's 9p filesystem via `makeFs9pFs()` (`vm/vmterm.js:52-91`), unit-proven against a fake `_fs` stub (`tests/vm/sync-bridge.mjs`). | Today this checkout has **no `vm/image/manifest.json`**, so the VM boots **only** the 1.44MB `testos.img` floppy — a hand-assembled test stub with no shell, no compilers (confirmed: `docs/VM-TOOLCHAIN.md` itself calls it "No compilers, no shell utilities"). The "full bash terminal" (real Alpine bash/gcc/nasm) is real code, but is **100% dependent on a GitHub Actions run that has not happened in this repo yet** — see Finding F1 for a further landmine in that path (`linux9p-packed` mode is unhandled). Also: the pre-existing simulated "Terminal" tab (`tc` object, `SprizzleIDE.html:1270-1285`) still exists side-by-side and looks superficially similar (also has a `$` prompt) — see Discoverability. |
| 2 | Add dependency packages to the project tree | **PARTIAL — weakest requirement, mostly DOCUMENTED-ONLY / MISSING** | `docs/VM-TOOLCHAIN.md:189-221` is candid: "The VM has no network access by default... `apk add <anything>` inside the VM will fail." Two options are offered: (1) edit `tools/build-image/Dockerfile`'s `apk add` line (`Dockerfile:36-39`) and push — this modifies the **system image for all users**, requires a CI rebuild, and is a maintainer/repo-owner action, not something a project user does per-project; (2) "bring your own offline `.apk` files" — explicitly **"not implemented in this image"** (`VM-TOOLCHAIN.md:213`). `tools/build-image/build.sh` was grepped for any local apk mirror staging — **none exists**. | There is no mechanism, anywhere in the codebase, for a user to add a dependency **to their project** (vendor a library file, an offline `.apk`, an npm/pip package, etc. into `S.files`/the project tree) from inside the running IDE. The one real lever that exists (editing the Dockerfile) changes the shared VM image, not "the project," requires a full CI rebuild cycle, and isn't reachable from any UI — a user would have to know to go edit a YAML/Dockerfile and understand the CI pipeline. **A user cannot actually do what they asked** for anything beyond "wait for a maintainer to rebuild the whole VM image." **Suggested fix**: ship the small local `.apk` mirror ORCHESTRATION.md itself proposed ("~20 most useful -dev packages") inside the image so `apk add --repositories-file /dev/null /root/pkgs/*.apk` works fully offline per-session, **and** add an IDE-side "vendor a file/library into project tree" affordance (e.g. a project `vendor/` or `lib/` folder + drag-drop-in-editor import) that doesn't require rebuilding the VM at all for source-level dependencies. |
| 3 | Build & compile workflows runnable from the IDE | **PARTIAL — code exists but NO discoverable UI entry point; raw terminal only** | Real compiles are possible **once inside the VM tab** by typing `gcc`/`nasm`/`ld` commands directly at the xterm prompt (`docs/VM-TOOLCHAIN.md:61-151`). | Traced the **only** "Run"-style UI entry point, `runCode()` (`SprizzleIDE.html:1293-1304`, bound to the `Run File` menu item at line 405 and the `F5` shortcut at lines 1194/2128): for HTML it opens Live Preview; for `.py`/`.js`/`.ts`/`.rs` it dispatches into the **old simulated** `tc` terminal object (fake `npm`/`python`/`node`/`cargo`, `SprizzleIDE.html:1270-1285`); **for C files** (`lang()==='C'`, `SprizzleIDE.html:948`) and **for `.asm`/`.s` files** (unmapped by `lang()`, falls through to `'Plain Text'`) the code hits the generic else-branch at line 1303: `` `Tip: Click Preview for web files. For ${l}, use the terminal with the appropriate runtime.` `` — this message **never mentions the VM tab at all**, and for an `.asm` file literally prints "For Plain Text, use the terminal..." There is **no menu item, no button, no keyboard shortcut anywhere** that boots the VM, syncs the project in, and runs a build — the only path is: manually click the `VM` tab → click `Boot` → wait → click `⬇ To VM` → click into the xterm pane → type `gcc hello.c && ./a.out` by hand. **Flag: no discoverable UI entry point for build/compile exists; it is 100% raw terminal usage**, contradicting the spirit of "runnable from the IDE" as a first-class feature. **Suggested fix**: wire `runCode()` (or a new `Run in VM` menu item) to detect `.c`/`.asm`/`.s` files and, if the VM tab exists, offer/perform sync-in + a canned `gcc`/`nasm` invocation automatically, and fix the generic tip text to name the VM tab explicitly. |
| 4 | Compile VST plugins inside the IDE | **IMPLEMENTED (generator/UI) + IMPLEMENTED-VIA-CI (in-VM binary) / genuinely honest UI copy** | `vst/vstcloud.js` self-registers `window.VSTCloud` and inserts a real **"VST Cloud Build…"** item into the existing Run-menu dropdown (`vst/vstcloud.js:91-111`, next to "Run File" at `SprizzleIDE.html:405`); it IS wired into the shipped page (`SprizzleIDE.html:2282`: `<script src="vst/vstcloud.js" defer></script>`). Modal copy (`vst/vstcloud.js:404-424`) explicitly states real VST3 Win/macOS/Linux binaries "cannot be compiled client-side" and require GitHub Actions in the user's own repo, while candidly describing the in-VM path as "genuinely on-device... Linux-only VST2, not a DAW-distributable VST3" — **honest, not oversold**. In-VM VST2 sample: `tools/skel/vst/{vestige/vestige.h,gain-vst2.c,Makefile}` — real, independently-written VST2 ABI + gain plugin, compiles cleanly on this machine (per status log) and is baked into the image via `Dockerfile:76-88` (`COPY skel/ /root/skel/`), verified at CI boot time by `tests/vm/boot-linux-smoke.mjs:129` (`cd /root/skel/vst && make && echo VST2=OK`, recorded as non-fatal `caps.vst2`). | Cloud path (b) is a real, tested generator (`tests/vst/vst-generator.spec.mjs`, `tests/vst/yaml-lint.mjs`, both claimed PASS) but has **never been exercised through a live GitHub Actions run** (no token/repo in any sandbox) — genuinely IMPLEMENTED-VIA-CI, not yet proven end-to-end. In-VM path (a) is real code but, like requirement 1, inert until the Linux image exists in this checkout. No functional gap in honesty/design found. |
| 5 | Compile assembly, 32 **and** 64 bit | **PARTIAL** | asm32: `docs/VM-TOOLCHAIN.md:79-98`, `tests/vm/boot-linux-smoke.mjs:126` (`RC=42` hard-fails the whole smoke test if broken) — build **and run**, fully in-VM. asm64: `nasm -f elf64` assembly is a **hard CI requirement** (`boot-linux-smoke.mjs:127,181`: "documented as always expected to work"); `ld -m elf_x86_64` linking is recorded as **non-fatal** `caps.ld64` (`boot-linux-smoke.mjs:128,166`) since it depends on the Alpine binutils build. `docs/VM-TOOLCHAIN.md:105-151` states the 64-bit **execution** limitation clearly and correctly: "v86 emulates a 32-bit-capable x86 CPU — it cannot execute 64-bit (long mode) machine code. This is a hard limit of the emulator, not a missing feature." | **The 64-bit execution limitation is documented, but is NOT surfaced anywhere in the actual running app.** Grepped `SprizzleIDE.html`, `vm/vmterm.js`, `vst/vstcloud.js` for "64-bit"/"elf64"/"elf_x86_64"/"asm64" — **zero matches**. The VM tab's boot banner (`vm/vmterm.js:127`: `"SprizzleIDE VM Terminal — v86 x86 emulator (Boot to start)"`) says nothing about 32-bit-only. A user who assembles/links a 64-bit program in-VM and tries `./a.out` will simply hit a v86 crash/hang with **no forewarning from the product**, only from a markdown file they'd have to know to go read. This directly fails the audit instruction "confirm the 64-bit EXECUTION limitation is clearly surfaced to the user (not buried)" — **it is buried**. Additionally, the promised "real path to run 64-bit output" via "a GitHub Actions workflow (the same cloud-build mechanism used for VST3)" (`VM-TOOLCHAIN.md:144-151`) **does not exist as a concrete feature** — unlike VST3, which has a dedicated generator/menu/workflow/downloader (`vst/vstcloud.js`), there is **no equivalent "asm64 Cloud Build" menu item, generator, or workflow file anywhere in `.github/workflows/`** (only `build-vm-image.yml` exists, which is a maintainer CI concern, not a user-facing run-my-64-bit-binary feature). The only real path today is "download the `.o` and run it on your own machine" — true, but only reachable via `⬆ Pull from VM`, itself dependent on the not-yet-existent Linux image. **Suggested fix**: (a) print a one-line 32-bit-only notice in the VM terminal on boot (trivial, in `vmterm.js:127`) and/or in the VST/build UI copy; (b) either build the promised asm64-execution GH Actions workflow for real (mirroring `vst/vstcloud.js`'s pattern) or soften `VM-TOOLCHAIN.md`'s wording so it doesn't imply a shipped feature that doesn't exist. |
| 6 | Audit waves (E1–E4) | **META / IN PROGRESS** | `docs/ORCHESTRATION.md` §3 defines E1 (code/regression), E2 (interface flow), E3 (this report), E4 (media/output integrity). | At time of this audit, `docs/` contains **only** `ORCHESTRATION.md` and `VM-TOOLCHAIN.md` — **no `audit-E1.md`/`E2.md`/`E4.md` exist yet**, and the STATUS LOG in `ORCHESTRATION.md` has no E1/E2/E4 entries. E3 is being run in isolation; findings above that overlap E1/E2/E4 scope (e.g. manifest-mode handling is also an E1 "broken reference" class bug, discoverability is E2's explicit remit) should be cross-checked once those waves run, to avoid duplicate/conflicting fixes. |

---

## FINDINGS

### F1 — HIGH — `linux9p-packed` manifest mode is silently unhandled by `vmterm.js`
If the real Alpine image build's total size exceeds the workflow's git-friendly
threshold (very plausible for a kernel + gcc + binutils + musl-dev + nasm
rootfs), `.github/workflows/build-vm-image.yml:102-119` packs the rootfs into
a GitHub Release asset and calls `tools/build-image/mark_packed_manifest.py`,
which rewrites `manifest.json`'s `mode` field to the literal string
**`"linux9p-packed"`** (`mark_packed_manifest.py:43`) and adds a `notes` field
explicitly saying *"Until vmterm.js implements that unpack step, boot in
floppy mode using `fallback` instead."* But `vm/vmterm.js` only ever checks
`manifest.mode === 'linux9p'` (lines 173 and 191) — there is no
`'linux9p-packed'` branch, no fetch/unpack-a-`.tar.zst`-from-a-Release logic
at all. Consequence: if this is the path CI actually takes (which its own
authors flagged as the likely one, given file-count/size), the VM tab will
silently fall through to the floppy branch with the **generic** "booting
floppy test OS…" message (`vmterm.js:194`) rather than the more informative
"Linux image unavailable — falling back to floppy test OS" message (that one
only fires for `mode === 'linux9p'`, line 191) — so even the fallback
messaging degrades for exactly the scenario the pack path exists for. Net
effect: the entire real-toolchain feature set (req. 1, 3, 5, VST2-in-VM part
of 4) can remain **permanently inert even after a fully successful CI run**,
with no diagnostic pointing at why.
**Fix**: add an explicit `mode === 'linux9p-packed'` branch to `vmterm.js`'s
`boot()` that fetches `manifest.release.asset` from the GitHub Release and
unpacks it (or, simpler, fetches+inflates it into an in-memory 9p `baseurl`
v86 can read), and print a clear message if that fetch fails, rather than
falling through to the ambiguous floppy path.

### F2 — HIGH — No discoverable UI entry point for build/compile; "Run File" actively misdirects for C/asm
`runCode()`/`F5`/the `Run File` menu item (`SprizzleIDE.html:405,1194,1293-1304,2128`)
is the IDE's only "run this file" affordance. For C and assembly files it
falls to a generic tip ("use the terminal with the appropriate runtime")
that never names the VM tab, and for `.asm`/`.s` files (unmapped by `lang()`,
`SprizzleIDE.html:948`) the message nonsensically reads "For Plain Text, use
the terminal...". A user following the IDE's own affordances for "build a C
program" will be pointed at the pre-existing **simulated** Terminal tab
(`tc` object, fully fake `npm`/`cargo`/`python` output), not the genuine VM.
**Fix**: special-case C/ASM in `runCode()`'s language map to point at (or
directly drive) the VM tab; at minimum fix the tip string to say "use the VM
tab (bottom panel) for C/assembly — see docs/VM-TOOLCHAIN.md."

### F3 — MEDIUM — 64-bit execution limitation is documented but never surfaced in-app
See requirement 5 above. Zero in-app text (`vmterm.js`, `SprizzleIDE.html`,
`vst/vstcloud.js`) mentions the 32-bit-only limitation; it exists solely in
`docs/VM-TOOLCHAIN.md` and `docs/ORCHESTRATION.md`, neither of which a normal
IDE user would open. **Fix**: one line in the VM boot banner
(`vmterm.js:127`) — e.g. append "(32-bit x86 only — 64-bit binaries assemble
here but cannot run in-VM, see docs)".

### F4 — MEDIUM — Two lookalike "terminals" with no in-app distinction
The pre-existing simulated `Terminal` tab (`SprizzleIDE.html:590-596`, `tc`
object at 1270-1285: fake `npm install` progress, fake `cargo build`, etc.)
sits directly beside the new genuine `VM` tab (`SprizzleIDE.html:599-609`) in
the same tab strip, both presenting a `$`-style prompt. Nothing in the UI
(no tooltip, no label, no first-run notice) tells a user that one is a
cosmetic simulation and the other is a real x86 VM — a user could reasonably
assume `npm install` typed in "Terminal" did something real, or conversely
dismiss the "VM" tab as another simulation. **Fix**: add a `title=` tooltip
to each panel tab ("Simulated command demo" vs. "Real x86 VM — genuine
Linux/bash"), or a one-time inline badge/notice.

### F5 — MEDIUM — Requirement 2 (add project dependencies) has no real per-project mechanism
Detailed under the requirements table. The only two documented options both
operate on the **shared VM system image** via a maintainer CI rebuild, not
the user's project tree, and the "offline `.apk` mirror" idea from
`ORCHESTRATION.md`'s own work package (§3.D) was explicitly **not built**
("Not done here... open a follow-up if you hit this wall",
`VM-TOOLCHAIN.md:218-221`). This is the weakest-delivered requirement of the
five and should be called out to the user plainly: **today, a user cannot
add a dependency package to their project from inside the IDE** — they can
at most ask a maintainer to add a system package to the whole VM image via a
CI rebuild, which is a different thing than what was asked.

### F6 — LOW — No onboarding/welcome-screen mention of any new feature
See Discoverability section below.

### F7 — LOW — E1/E2/E4 audits have not yet run
`docs/` contains no `audit-E1.md`/`E2.md`/`E4.md`; several findings above
(F1 as a "broken reference," F2/F4/F6 as interface-usability issues) overlap
those waves' remit and should be reconciled once they run, to avoid
duplicated or conflicting fix attempts.

---

## DISCOVERABILITY

Checked: activity-bar tooltips, panel-tab labels, the `Run`/`File`/`View`
menus, the welcome screen, and any first-run/onboarding surface.

- **VM terminal**: reachable — it is a labeled tab (`VM`) in the same
  tab strip as `Terminal`/`Problems`/`Output` (`SprizzleIDE.html:582`), so a
  reasonably curious user browsing tabs would find it. However: no tooltip
  distinguishes it from the pre-existing fake `Terminal` tab (F4); the
  welcome screen's shortcut list (`SprizzleIDE.html:552-557`: `Ctrl+N`,
  `Ctrl+O`, `Ctrl+Shift+P`, "GitHub menu") **does not mention the VM tab at
  all**, despite listing lesser features like GitHub clone. A first-time
  user has no signal that a genuine VM/bash terminal was added to this IDE
  unless they happen to click through all four bottom-panel tabs.
- **Compile/build commands**: **not discoverable** as a first-class feature.
  There is no `Build`/`Compile` menu, and the only "Run" entry point
  (`Run File`/`F5`) does not mention the VM for C/asm files (F2). A user
  would have to already know (from docs, not the app) to: open VM tab → Boot
  → wait → `⬇ To VM` → click into the terminal → type `gcc`/`nasm` commands
  manually. **This fails the "discoverable UI entry point" bar** — it is
  raw terminal usage with no IDE-level assistance, despite requirement 3
  asking for build workflows "runnable from the IDE."
- **VST builder**: discoverable — a real, visible **"VST Cloud Build…"**
  item is inserted into the existing `Run` menu dropdown
  (`vst/vstcloud.js:91-111`, confirmed wired via
  `SprizzleIDE.html:2282`), consistent with how other Run-menu items
  (`npm install`, `Live Preview`) are surfaced. This is the one feature of
  the five that is genuinely menu-discoverable without reading docs.
- **Welcome screen / onboarding**: no update at all. The welcome panel
  (`SprizzleIDE.html:546-563`) — the very first thing a new user sees —
  still only advertises New File / Open / Preview / GitHub clone / Sample
  Project / Setup AI. None of the five new capabilities (VM terminal,
  package install, build/compile, VST build, asm32/64) are mentioned. There
  is no modal, badge, "What's New," or changelog surfaced anywhere in the
  running app.
- **Mobile**: the VM tab is reached through the same bottom-panel tab strip
  used on desktop (no separate mobile nav path found), so it is at least
  equally (un)discoverable on mobile as desktop; the one mobile-specific
  affordance is a memory-warning notice printed *inside* the xterm buffer
  after `Boot` is pressed (`vmterm.js:130-133`), not before, i.e. a user
  already has to have found and clicked Boot to see it.

**Overall discoverability verdict**: 1 of 5 requirements (VST Cloud Build)
has a real, findable menu entry point. The other four are functionally
"terminal only" or "read the docs first" — a plain gap against the audit
instruction to check for menus/tooltips/onboarding.

---

## Toolchain doc cross-check (`docs/VM-TOOLCHAIN.md` vs. actual `apk add` list)

`tools/build-image/Dockerfile:36-39` installs exactly:
`alpine-base openrc agetty alpine-conf linux-$KERNEL linux-firmware-none bash gcc musl-dev make nasm binutils busybox-extras`

Every tool `VM-TOOLCHAIN.md` claims is present is in fact in that list:
`bash` ✓, `gcc`/`musl-dev` (C) ✓, `nasm` ✓, `binutils` (`ld`) ✓, `make` ✓
(referenced by `tools/skel/vst/Makefile`). No doc claim was found that names
a tool absent from the apk list (e.g. no claim of `clang`, `python`, `git`,
`cmake`, or `node` being available in-VM — correctly, none of those are
installed, and the doc never says otherwise). The one place the doc's wording
outruns the shipped code is the asm64 "GitHub Actions workflow... the same
cloud-build mechanism used for VST3" line (`VM-TOOLCHAIN.md:146-147`) — no
such workflow exists in `.github/workflows/` (see F3/requirement 5); this is
a doc-vs-code mismatch, not a missing apk package.
