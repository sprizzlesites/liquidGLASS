# Audit E2 — Interface Flow & Usability (fullterminal)

Run directly by the orchestrator after two Sonnet sub-agent attempts were
terminated by session limits. Harness: `scratchpad/e2-audit.mjs`
(playwright-core Chromium, repo served over local HTTP; desktop 1400x900 and
iPhone-UA mobile 390x844). Blocked-CDN console noise excluded by design.

## Verdict: PASS — 22/22 checks

| Area | Checks | Result |
|---|---|---|
| Bottom-panel tabs (Terminal/Problems/Output/VM) | 4 | PASS (after fix, below) |
| VM tab: lazy load, floppy boot via UI, serial echo, double-boot guard, honest sync notice, Stop | 6 | PASS |
| Menus: every onclick resolves to a defined function | 1 | PASS |
| VST Cloud Build: script loaded, modal + honest copy, Run-menu entry | 3 | PASS |
| Binary tabs: readonly + notice, text tab restores, content intact | 3 | PASS |
| Desktop console/page errors (non-CDN) | 1 | PASS (zero) |
| Mobile: dock views, VM tab reachable in Term view, no h-scroll, no page errors | 4 | PASS |

## Findings & dispositions

1. **CONFIRMED+FIXED (pre-existing since main, suspected by audit-E1 #3):**
   Problems and Output panels could NEVER be shown — their `class="hidden"`
   (`display:none!important`) beat `switchPanelTab`'s inline `style.display`.
   Fix: `switchPanelTab` now toggles the `hidden` class alongside display for
   all four panels. Verified P2/P3 PASS post-fix.
2. **False alarm (test-timing):** the initial run flagged the VM sync notice
   as missing; xterm.js parses writes asynchronously, so a same-tick buffer
   read missed it. With a 400ms settle the notice asserts correctly — code
   was right all along.
3. No dead buttons, no undefined onclick handlers, no unexpected console
   errors on either viewport.
