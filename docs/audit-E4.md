# Audit E4 — Media/Output Integrity (fullterminal branch)

**Auditor:** Agent E4 (Sonnet, read-only audit wave per docs/ORCHESTRATION.md §3.E4)
**Scope:** every path by which bytes leave (or round-trip through) SprizzleIDE's
`S.files` model — ZIP export/import, single-file download, GitHub push, live
preview, VM artifact pull, VST Cloud Build download, localStorage
persist/hydrate, and the binary-safety primitives (`fileGetBytes`/
`fileSetBytes`) everything above is built on. Standard applied: **byte-identical
or FAIL** — a 1-byte diff is a failure, no exceptions.

This report is **report-only**: no source files were modified. All test
scripts referenced below were written to scratch space, not the repo, and are
reproducible (paths given per-check). They exercise the real, unmodified
`SprizzleIDE.html` / `vm/vmterm.js` / `vst/vstcloud.js` in an actual Chromium
(playwright-core, `/opt/pw-browsers/chromium-1194`), not jsdom, so `btoa`/
`atob`/`Blob`/`TextDecoder`/`URL.createObjectURL` are the real browser
implementations — the exact APIs the user's historical corruption bugs came
from.

Test payloads used throughout: a **real, valid PNG** (hand-built 1×1 RGB PNG
with a genuine zlib-deflated IDAT stream and correct CRC32s — not just random
bytes), a **real WAV header** (44-byte RIFF/WAVE/fmt/data header) with PCM
samples containing `0xFF`/`0x80`/`0x00`, a **deliberately invalid-UTF-8 binary
blob** (lone continuation bytes, overlong sequences, surrogate-halves encoded
as UTF-8, `0xFF`/`0xFE`, embedded NUL), and a **tricky UTF-8 text file**
(emoji, CRLF line endings, accented/CJK characters).

Scripts (scratch, not committed):
- `/tmp/claude-0/-home-user-liquidGLASS/82d04b29-dbce-5039-8bbd-5e80ffff6508/scratchpad/e4/e4-audit.mjs` (checks 1–8a)
- `/tmp/claude-0/-home-user-liquidGLASS/82d04b29-dbce-5039-8bbd-5e80ffff6508/scratchpad/e4/e4-audit2.mjs` (checks 8b–8d, end-to-end corruption chain)
- `/tmp/claude-0/-home-user-liquidGLASS/82d04b29-dbce-5039-8bbd-5e80ffff6508/scratchpad/e4/e4-vm-vst.mjs` (VM syncOut + VST downloadAsset, real PNG)
- Pre-existing suites re-read/cross-checked (not modified): `tests/vm/zip-binary-roundtrip.mjs`, `tests/vm/sync-bridge.mjs`, `tests/vst/vst-generator.spec.mjs`

All three new scripts were run to completion; raw pass/fail lines are quoted
below. Overall: **28/29 new independent checks PASS; 4/4 supplementary
end-to-end checks in script 2 confirm one real, reproducible corruption bug**
(§ Findings, F1) in a path outside the original binary-safety work package's
enumerated list.

---

## PATHS TABLE

| # | Output/IO path | Code location | Tested payloads | Byte-identical? | Evidence |
|---|---|---|---|---|---|
| 1 | Core primitive: `fileGetBytes`/`fileSetBytes` | SprizzleIDE.html:1013–1040 | PNG, WAV, invalid-UTF8 blob, tricky UTF-8 text | **PASS** | checks 1a–1d, e4-audit.mjs |
| 2 | ZIP export (`buildProjectZip`/`exportProjectZip`) | SprizzleIDE.html:1129–1130 | PNG, WAV, invalid-UTF8 blob, tricky text, emoji/space/quote filename | **PASS** | checks 2a–2e (real JSZip round-trip via `zip.generateAsync`→reload→`Buffer.compare`) |
| 3 | ZIP import (`importZipFromBuffer`) + export→import→export chain | SprizzleIDE.html:1132 | Same zip as #2, re-imported into an empty project, re-exported | **PASS** | checks 3a–3f |
| 4 | Single-file download (`downloadCurrentFile`) | SprizzleIDE.html:1122 | PNG, invalid-UTF8 blob, tricky text — Blob captured via monkey-patched `HTMLAnchorElement.prototype.click` + `fetch(blob:...)` | **PASS** | checks 4a–4c |
| 5 | GitHub push (`ghPushChanges`) | SprizzleIDE.html:1322 | b64 PNG (must NOT be re-encoded) + tricky-UTF-8 text file, stubbed `fetch`, captured real PUT body | **PASS** | checks 5a, 5a2, 5b — `body.content` for the binary file equals `Buffer.from(png).toString('base64')` exactly (no double base64); text file's `body.content` base64-decodes to the exact original string |
| 6 | Live preview (`buildPreview`) | SprizzleIDE.html:1224–1248 | HTML referencing a binary `<img>`, a text CSS `<link>`, a text JS `<script src>` | **PASS** (with documented behavior note) | checks 6a–6d: CSS/JS text inlining intact, no raw base64 leaked into the assembled HTML; `<img src="logo.png">` is left as a literal relative path — see note below |
| 7 | VM artifact pull (`VMTerm.syncOut`) | vm/vmterm.js (`walkFs`/`fileSetBytes` call, tests/vm/sync-bridge.mjs pattern) | Real PNG + invalid-UTF8 blob placed in a fake `_fs` stub's `project/build/` | **PASS** | checks 5vm-a, 5vm-b, e4-vm-vst.mjs |
| 8 | VST Cloud Build download (`VSTCloud.downloadAsset`) | vst/vstcloud.js:579–618 | Real PNG served by a stubbed `fetch` as a release asset | **PASS** | check vst-a — independent re-verification of Agent C's own claim, with a real (not random) binary and a differently-shaped stub |
| 9 | persist()/hydrate() (localStorage) | SprizzleIDE.html:1964–1965 | PNG, invalid-UTF8 blob, tricky text through `JSON.stringify`→`localStorage`→`JSON.parse` | **PASS** | checks 7a–7c |
| 10 | Editor tab / textarea (`openTab`, `saveFile`, `insertAtCursor`, AI apply) | SprizzleIDE.html:983–999, 1120–1121, 1636–1637 | Manual code read (readOnly + placeholder gating already confirmed structurally); not independently fuzzed beyond Agent B's tests | **PASS** (by inspection) | `openTab` sets `ed.readOnly=true` and a placeholder string for `f.b64`, never writing the placeholder back into `S.files`; `saveFile`/`saveFileAs`/`insertAtCursor` all early-return with a warning on `.b64` files |
| 11 | AI tool file I/O (`execAITool` LIST/SEARCH/READ/REPLACE/EDIT, `mkFileFromAI`) | SprizzleIDE.html:1546–1598, 1635 | Manual code read | **PASS / N-A** | AI never writes binary — `mkFileFromAI` only ever receives model-generated text; all of LIST/SEARCH/READ/REPLACE/EDIT explicitly refuse `.b64` files with an `ERROR:` string back to the model instead of touching their bytes |
| 12 | `globalSearch` (search-everywhere overlay) | SprizzleIDE.html:1262 | Manual code read | **PASS / N-A** | `if(file.b64)return;` — binaries skipped, never treated as searchable text |
| 13 | Simulated Terminal `cat` | SprizzleIDE.html:1276 | Manual code read | **PASS** | prints a `(binary file, N bytes)` notice instead of dumping raw base64 |
| 14 | **"Open File" single-file import** (`handleFileOpen`) | SprizzleIDE.html:1071 | Real PNG through the *actual* function via a real `File` object | **FAIL** | check 8a — see Finding F1 |
| 15 | **"Open Folder" import** (`handleFolderOpen`) | SprizzleIDE.html:1072 | Real PNG through the actual function | **FAIL** | check 8c — see Finding F1 |
| 16 | **Non-ZIP drag-and-drop** (single file + folder-tree fallback branches) | SprizzleIDE.html:1094, 1099–1113 | Real PNG through the identical inline logic (readAsText) | **FAIL** | check 8d — see Finding F1 |
| 17 | GitHub **clone** (`doCloneRepo`) text-file decode | SprizzleIDE.html:1321 | Confirmed by direct emulation of its `decodeURIComponent(escape(atob(...)))` line with emoji/CRLF/CJK text | **PASS** (text only) | Decode logic is correct for the UTF-8 text it handles. Note: it is gated by a hardcoded text-extension allowlist (`textExts` regex) — binary files in the cloned repo are silently **not** fetched at all (an import completeness gap, not a corruption bug; see Finding F2) |
| 18 | End-to-end chain: corrupted import → re-download | n/a (consequence of #14) | Same PNG, opened via `handleFileOpen` then immediately `downloadCurrentFile()`'d | **FAIL** | check 8b — downloaded file is 95 bytes vs. the original 69 bytes and is not the same image at all; proves the corruption from F1 propagates all the way to a user-facing "output" (download), not just an internal representation |

---

## FINDINGS

### F1 — HIGH — Binary files silently corrupted on import via "Open File", "Open Folder", and non-ZIP drag-and-drop

**Severity:** High. This is precisely the failure mode named in the work
order: a text-decoding assumption (`FileReader.readAsText()`) applied to
arbitrary/high-byte/non-UTF-8 data, with no `b64` fallback.

**Where:**
- `SprizzleIDE.html:1071` — `handleFileOpen` (File > Open File…)
- `SprizzleIDE.html:1072` — `handleFolderOpen` (File > Open Folder…)
- `SprizzleIDE.html:1094` — drag-and-drop, no-`webkitGetAsEntry` fallback branch
- `SprizzleIDE.html:1099–1113` (`readEntry`, called from 1115) — drag-and-drop of files/folders via the `DataTransferItem` entry API

All four call sites use `new FileReader().readAsText(file)` unconditionally
and store `e.target.result` directly into `S.files[...] = {content, lang,
modified:false}` with **no `b64` flag, no byte-length check, no
`fileSetBytes()` call**. `readAsText` decodes the file's bytes as text using
the browser's Encoding Standard, which replaces every invalid/undecodable byte
sequence with U+FFFD (the replacement character) — a lossy, irreversible
transformation for any file that isn't valid UTF-8 (essentially every binary
format: PNG, JPEG, WAV, ZIP, compiled `.so`/`.wasm`, etc.).

**Proof (script: e4-audit.mjs / e4-audit2.mjs):**
```
FAIL [8a] "Open File" (handleFileOpen) on a binary PNG — byte-identical?
  {"stored_b64_flag":false,"bytesIdentical":false,"storedLen":69,
   "rawContentSample":"\"�PNG\\r\\n\\u001a\\n\\u0000...\""}
FAIL [8b] END-TO-END: PNG opened via "Open File" then re-downloaded — byte-identical?
  downloaded len=95 vs original len=69, stored as binary=false
FAIL [8c] "Open Folder" (handleFolderOpen) on a binary PNG — byte-identical?
  {"found":true,"b64":false,"bytesIdentical":false}
FAIL [8d] non-ZIP drag-and-drop single-file fallback branch (readAsText) on binary PNG — byte-identical?
  {"b64":false,"bytesIdentical":false}
```

Check 8b is the concrete, user-visible consequence: a 69-byte PNG opened via
File > Open File, then immediately re-downloaded via the Download button
(no editing in between), comes back as a 95-byte file that is not a valid PNG
— corrupted at the very first import step, and the corruption is permanent
and silently propagates through every downstream output path audited above
(ZIP export, GitHub push, preview, persist) because those paths correctly
trust the `.b64` flag, which was never set for this file in the first place.

**Why this slipped through:** the §2/§3.B binary-safety work package
enumerated "ZIP export, single-file download, GitHub push, preview, editor,
persist/hydrate" as the output paths to audit for `.b64` honoring — all of
those were fixed correctly (see PASS rows above). `importZipFromBuffer` (ZIP
import) was also proactively fixed by Agent B (their status-log entry notes
this was "not explicitly called out... but squarely the same corruption
class"). However, the three *other* pre-existing local-file-ingestion paths
(single-file open, folder open, non-ZIP drag/drop) were not in either list and
were not touched by the binary-safety effort — they still use their original,
pre-VM-work `readAsText`-only implementation.

**Suggested fix (not applied — report-only):** route all four call sites
through `file.arrayBuffer()` (or `FileReader.readAsArrayBuffer`) +
`fileSetBytes(path, bytes)` instead of `readAsText`, mirroring exactly what
`importZipFromBuffer` already does correctly at SprizzleIDE.html:1132. This is
a mechanical, low-risk fix — `fileSetBytes` already exists and already
contains the correct UTF-8-vs-binary detection logic used everywhere else.

### F2 — LOW / informational — GitHub "Clone repo" silently skips binary files (no corruption, but a completeness gap)

**Where:** `doCloneRepo`, SprizzleIDE.html:1321, `textExts` regex filter.

`doCloneRepo` only fetches blobs whose extension matches a hardcoded allowlist
of text extensions (`js|jsx|ts|tsx|py|html|css|json|md|txt|yaml|...`). Binary
files in the cloned repo (images, compiled artifacts, audio, etc.) are never
requested from the GitHub Contents API at all — they simply don't appear in
the cloned project tree. This is **not a corruption bug** (nothing is
mis-decoded; the text files that *are* cloned decode correctly — verified by
directly emulating the function's `decodeURIComponent(escape(atob(blob.content.replace(/\n/g,''))))`
line against emoji/CRLF/CJK content, which matched exactly). It is flagged as
a completeness gap adjacent to the binary-safety effort: a user cloning a repo
with real media assets will find them silently missing rather than present
and correct. Low severity because it fails safe (nothing corrupted, nothing
silently wrong-but-present) — but worth a UI note ("clone only imports text
source files") or a follow-up to route matched-but-excluded blobs through the
same `fileSetBytes`/`{b64:true}` path used everywhere else, size/rate-limit
permitting.

### Documented (non-bug) behavior: `buildPreview` and binary `<img>` references

`buildPreview` (SprizzleIDE.html:1224) correctly refuses to inline binary CSS/JS
files (`&&!cssFile.b64` / `&&!jsFile.b64` guards) — verified no raw base64 leaks
into the assembled HTML (check 6c). However, an `<img src="logo.png">`
referencing a project binary is left as a literal relative path in the
preview HTML. Since the preview is served from a `blob:` URL with no
filesystem/HTTP backing for that relative path, the browser's `<img>` request
for `logo.png` will 404 inside the preview iframe — the image will not
display. This is **not corruption** (no bytes are touched or mis-encoded) and
is architecturally reasonable given the sandboxed blob-preview design, but it
is a real user-visible limitation worth calling out in product docs/UI copy:
*images/binary assets referenced from previewed HTML will not render in Live
Preview.* No fix suggested here since it's a design tradeoff, not a bug, and
outside this audit's byte-integrity mandate.

---

## Paths that could not be fully tested headlessly

- **Real end-to-end browser download** (the OS save-file-picker / actual disk
  write triggered by `a.click()` on a real `download` attribute): headless
  Chromium has no OS-level download surface to assert against. Best-effort
  check performed instead: monkey-patched `HTMLAnchorElement.prototype.click`
  to capture the `blob:` URL that would have been downloaded, then
  `fetch()`'d that exact blob URL and byte-compared its content — this proves
  the Blob itself is byte-identical, which is the only thing SprizzleIDE's
  code controls; the browser's own download mechanism (writing that Blob to
  disk) is outside the application's code and outside what a headless
  audit can exercise.
- **Real OS drag-and-drop** (`DataTransfer`/`DataTransferItem` from an actual
  OS file drag): Playwright/CDP cannot synthesize a real OS drag-drop event
  with file payloads. Best-effort: the drop handlers' *exact* inline logic
  (SprizzleIDE.html:1094 and 1099–1113) was invoked directly with a real
  `File` object standing in for the dropped file — this exercises the same
  `FileReader`/`readAsText` code that would run on a genuine drop, just without
  synthesizing the browser drag gesture itself. This is how Finding F1's drop
  paths were confirmed.
- **Real v86 Linux guest boot + genuine 9p filesystem** (as opposed to the
  fake `_fs` stub): per the ORCHESTRATION.md status log, no `manifest.json`/
  linux9p image exists yet in this sandbox (Agent D's CI image build has never
  run — no Docker+Alpine network access here), so `VMTerm.syncOut()` has never
  been exercised against a real booted guest, only the documented `_fs` stub
  contract (`{mkdir,write,read,readdir}`). This audit re-verified the stub-based
  claim independently with a **real PNG** (not just small hand-picked byte
  arrays) and non-UTF-8 garbage, and it passed — but the underlying 9p
  transport itself (real `emulator.fs9p` binary read/write fidelity) remains
  unverified end-to-end, consistent with what Agents B/D already flagged as an
  open risk unrelated to binary-safety logic itself.
- **Real GitHub API round-trip** (`ghPushChanges`, VST `downloadAsset`): no
  live token/repo available in this sandbox (consistent with Agents C/D's
  notes). Both were verified by stubbing `window.fetch` and asserting the
  exact request body / response handling the real code constructs — this
  proves SprizzleIDE's own encode/decode logic is correct; it does not prove
  GitHub's API behaves as assumed (which is outside this audit's scope; it's
  a battle-tested API, not custom code).
- **Real VST3 binaries from Cloud Build**: as Agent C already noted, no
  end-to-end JUCE/CMake/GitHub Actions run has happened. This audit only
  re-confirmed the client-side download/store leg (`downloadAsset`) is
  byte-safe, given *some* bytes come back from the Releases asset endpoint —
  it does not (and cannot, headlessly) validate that those bytes constitute a
  working VST3 plugin.

---

## Summary

Of the output/IO paths the original binary-safety work package (§2/§3.B)
targeted — ZIP export, ZIP import, single-file download, GitHub push, live
preview, VM artifact pull, persist/hydrate — **every one passed byte-identical
verification** against real binary payloads (valid PNG, valid WAV, and
deliberately invalid-UTF-8/high-byte data), independently re-tested in a real
browser rather than trusted from the implementers' own test suites. The VST
Cloud Build download path (outside the original list but squarely an "output
method") also passed.

One genuine, reproducible corruption bug was found (**F1**): three
pre-existing, pre-VM-era local-file-ingestion paths — **"Open File", "Open
Folder", and non-ZIP drag-and-drop** — still silently mangle any binary file
via an unconditional `FileReader.readAsText()`, with no `.b64` detection. This
was proven not just in isolation but end-to-end (open → download), showing a
clean PNG becomes corrupted the moment it's imported through these three
menu/gesture paths, before any export logic even runs. Since the user's
explicit hard requirement is clean output through **every** available
generation/output method, and one of the most natural ways to get a binary
asset into the project in the first place is exactly these three paths, this
should be fixed before considering the binary-safety effort complete.
