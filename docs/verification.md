# Verification — what was actually executed

Environment: Windows 11 ARM64 host, bash (MSYS) terminal. Node v26.7.0, npm
11.19.0, PowerShell 7.6.6 (`pwsh`), Windows PowerShell 5.1.26100.9457,
Google Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`
(headless, a throwaway profile owned by `tests/cdp-browser.cjs`).

Portability note: every `build-workspace/...` handle below is workspace-local
developer evidence, not bundled or shipped with the standalone tool. The
standalone package is the runtime files listed in the README; builder logs,
`parent-qa/` records, and review artifacts stay outside it and are cited here
only as workspace-local provenance, not as shipped proof.

## Original implementation baseline (2026-10-11) — historical

These historical counts (41/106/18) are superseded and are not current; the
current baseline is in the package-correction section at the end.

| Suite | Command | Result | Raw log (workspace-local handle) |
| --- | --- | --- | --- |
| Core | `node --test tests/core.test.cjs` | 41 tests, **41 pass, 0 fail, 0 skipped**, exit 0 | `build-workspace/evidence/PrintCheck/green/01-core-tests-green.txt` |
| Collector (pwsh) | `pwsh -NoProfile -NonInteractive -File tests/collector-tests.ps1` | **106 assertions passed, 0 failed**, exit 0 | `.../evidence/PrintCheck/green/02-collector-tests-green-pwsh.txt` |
| Collector (5.1) | `PSExecutionPolicyPreference=Bypass powershell.exe -NoProfile -NonInteractive -File tests/collector-tests.ps1` | **106 assertions passed, 0 failed**, exit 0 | `.../evidence/PrintCheck/green/03-collector-tests-green-powershell51.txt` |
| Browser | `node tests/browser.cjs` | **18 steps passed, 0 failed**, exit 0 | `.../evidence/PrintCheck/green/04-browser-tests-green.txt` |

The 5.1 row uses a **per-process** `PSExecutionPolicyPreference=Bypass`
because this machine's Windows PowerShell default policy is `Restricted`
(verified with `Get-ExecutionPolicy -List`); no system setting is changed.

## RED before GREEN (TDD evidence)

All three suites were written and executed **before** their implementations
existed; the raw failing outputs are preserved:

- `.../evidence/PrintCheck/red/01-core-tests-red.txt` — `Cannot find module
  '../core.js'` (MODULE_NOT_FOUND), exit 1.
- `.../evidence/PrintCheck/red/02-collector-tests-red.txt` — collector script
  missing, exit 1.
- `.../evidence/PrintCheck/red/03-browser-tests-red.txt` — fixture missing
  (no implementation yet), exit 1.

Intermediate RED→GREEN iterations during implementation (fixed, then re-run):

- **Core**: the ordinal-label generator pluralized (`Queues 1` instead of
  `Queue 1`), and one opt-in assertion referenced the wrong hostile-fixture
  value; both fixed → 41/41.
- **Collector**: the fake-provider helper used a parameter named `$Host`
  (a read-only automatic variable) → renamed → 106/106.
- **Browser**: the shared helper's `key('Enter')` shim does not emit the
  keypress Chrome needs for button activation — the suite now sends the full
  `Input.dispatchKeyEvent` pair with `text:'\r'` through the helper's raw
  `command` API; steps now reset filter state so they are independent; one
  import assertion raced `FileReader` and now waits on the source label; and a
  mobile defect found by screenshot review + probe — the table `<caption>`
  collapsed into a 10px-wide vertical column inside a block table (probe
  measured `width:10, height:1008`) — was fixed with `display:block` for
  captions, and a **regression gate** now asserts no block-level element with
  long text is narrower than 60px at 320/390px.

## What the browser suite actually exercises (18 steps)

Loads `index.html` from `file://` with zero console/page errors and zero
HTTP(S) requests; static-scans the UI sources for URLs/fetch/XHR/storage/
HTML sinks; Tab order + visible focus ring; Enter activation of the sample
button; filter by term with empty state and Escape; status filter incl.
keyboard ArrowDown on the select; all three built-in samples; real file-input
imports of the fixtures; hostile-string import (no script execution, no
injected elements, canaries absent); invalid JSON, invalid schema, and
oversized imports rejected with bounded messages and exports disabled (stale
export cannot be clicked); racing imports (last one wins); JSON export with
default redaction + byte check; opt-in identifier export; script-free HTML
export + byte check; 320/390px overflow and collapsed-box checks with maximal
legal strings; clean screenshots; empty `localStorage`/`sessionStorage`;
final zero-error/zero-request assertion.

## What was NOT executed (by design)

- The **production collector was never run against this machine**. The
  collector suite dot-sources the script with `-LibraryOnly` and injects
  synthetic providers; a child-process case shadows `Get-Printer`,
  `Get-PrinterDriver`, `Get-PrinterPort`, and `Get-CimInstance` with recording
  fakes and proves that plain dot-sourcing cannot trigger production queries.
  The only collector executions that ran were `-Sample` (clearly fictional
  built-in data, zero queries).
- No installs (no `npm install`, no Playwright), no git operations, no
  network probes, no system/settings changes, no printer/driver/spooler
  operations, no print jobs read.
- Production collector APIs are only *referenced*, per Microsoft docs:
  `Get-Printer`, `Get-PrinterDriver`, `Get-PrinterPort` (PrintManagement) and
  `Get-CimInstance Win32_OperatingSystem`.

## Artifacts

- Screenshots (fictional built-in sample only):
  `.../evidence/PrintCheck/screenshots/sample-desktop.png` (1280×900) and
  `.../evidence/PrintCheck/screenshots/sample-mobile-390.png` (390×844).
- Sample collector run: `.../evidence/PrintCheck/collector-sample/printcheck-collector-sample.json`
  (exit 0; `tool.mode: "sample"`, `queriesExecuted: []`) with
  `run-log.txt`.
- Real downloads produced by the browser suite (byte-checked in-suite):
  `.../evidence/PrintCheck/exports/printcheck-report-*.json` and `*.html`,
  plus `oversized.json` (generated invalid-size import input).
- Scratch diagnostics archived for review:
  `.../evidence/PrintCheck/probes/printcheck-enter-probe.cjs` and
  `printcheck-mobile-probe.cjs`.
- Helper provenance: `tests/cdp-browser.cjs` is byte-identical to the shared
  helper (sha256 `3db68b5bcb1d2d5b2aabd12dce2cceb1bfda08cce9d547957d0f407315305c67`).

## Format-support statement

- Collector documents: `printcheck.collector` **v1 only**. Other schema
  versions are rejected with a structured error (`schema-version-unsupported`).
- Reports: `printcheck.report` v1 (JSON) and a script-free, self-contained
  HTML rendering. No CSV, SVG, or other export formats exist.
- Browser verification covered the installed Google Chrome (headless) only;
  no other browser was tested.

## Fix round 1 (2026-10-11) — canonical prose handling and atomic writes

Triggered by the independent spec review (`review/PrintCheck/STAGE1-REPORT.md`)
and four frozen parent gates (`parent-qa/PrintCheck/`). All fix-round evidence
lives under `evidence/PrintCheck/fix-round-1/`; the original builder evidence
(`evidence/PrintCheck/{green,red,exports,screenshots,collector-sample,probes}`)
was not written to.

Behavior changes (format changes documented in `docs/schema.md`):

- Provider/collector errors are now a bounded canonical code plus a fixed
  generic message (`provider-error`, `provider-unavailable`, fallback
  `error`) at BOTH the collector and viewer normalization; imported exception
  text never reaches state, the DOM, logs, or either export mode.
- Port descriptions are never carried (collector writes `null`; the viewer
  normalizes any imported description to `null`).
- Source/host `api` labels and `provenance` labels are canonical; imported
  label text is ignored. Unknown explanations are the viewer's canonical
  per-topic text; unrecognized topics/states are dropped with a static warning.
- Diagnostics never echo imported values: `schema-version-unsupported` omits
  the imported version, JSON parse failures use a fixed message, and
  dropped-field paths are ordinal/static (`$.…<unknown-key>#N`) — raw key
  names never appear anywhere.
- `count`/`limits` numbers normalize to non-negative integers (non-numbers
  fall back to the observed item count).
- `Write-PrintCheckDoc` no longer uses check-then-write: no-`-Force` uses
  `FileMode.CreateNew` (atomic; concurrent writers cannot both succeed),
  `-Force` keeps deliberate overwrite semantics; the stream is a bounded
  UTF-8-no-BOM `StreamWriter` disposed in `finally`.
- The `-Sample` host `powershellVersion` is labeled as the actual collector
  runtime (`"7.6.6 (actual collector runtime; sample content is fictional)"`).
- UI/docs claims now state the exact behavior (canonical prose handling plus
  a review-before-sharing note for reported metadata) instead of promising
  that arbitrary strings can never contain secrets.

Fix-round-1 suite runs (historical; superseded by the current baseline at the
end — the 52/128/21 counts below are not current):

| Suite | Command | Result | Log (workspace-local handle) |
| --- | --- | --- | --- |
| Core | `node --test tests/core.test.cjs` | **52 tests, 52 pass, 0 fail**, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/green/01-core-tests-green.txt` |
| Collector (pwsh) | `pwsh -NoProfile -NonInteractive -File tests/collector-tests.ps1` | **128 assertions passed, 0 failed**, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/green/02-collector-tests-green-pwsh.txt` |
| Collector (5.1) | `PSExecutionPolicyPreference=Bypass powershell.exe -NoProfile -NonInteractive -File tests/collector-tests.ps1` | **128 assertions passed, 0 failed**, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/green/03-collector-tests-green-powershell51.txt` |
| Browser | `node tests/browser.cjs` | **21 steps passed, 0 failed**, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/green/04-browser-tests-green.txt` |

The 5.1 rows use a **per-process** `PSExecutionPolicyPreference=Bypass`
(machine default policy is `Restricted`); no system setting is changed.

RED before GREEN (historical genuine failing runs of the new/updated tests
before the fixes; preserved with original counts, not rerun):

- `build-workspace/evidence/PrintCheck/fix-round-1/red/01-core-red.txt` — 52 tests, 38 pass, **14 fail**, exit 1.
- `build-workspace/evidence/PrintCheck/fix-round-1/red/02-collector-red-pwsh.txt` — 128 assertions, 112 pass,
  **16 fail**, exit 1 (including the deterministic atomic-race case: both
  writers exit 0 on the old check-then-write path).
- `build-workspace/evidence/PrintCheck/fix-round-1/red/03-browser-red.txt` — 21 steps, 13 pass, **8 fail**, exit 1.
- `build-workspace/evidence/PrintCheck/fix-round-1/red/04-parent-gates-before-fix.txt` — all four frozen parent
  gates RED (1/1, 7/7, 1/1 fail; `SYNTHETIC_PROVIDER_CREDENTIAL_LEAK=True`).

Frozen parent gates after the fix (historical; read/run only — files not modified):

| Gate | Result | Log (workspace-local handle) |
| --- | --- | --- |
| `error-redaction-regression.test.cjs` | 1/1 pass, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/parent-gates/01-error-redaction-green.txt` |
| `free-text-diagnostics-regression.test.cjs` | 7/7 pass, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/parent-gates/02-free-text-diagnostics-green.txt` |
| `atomic-create-regression.test.cjs` | 1/1 pass, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/parent-gates/03-atomic-create-green.txt` |
| `synthetic-provider-privacy-regression.ps1` (pwsh) | leak=False, PASS, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/parent-gates/04-synthetic-provider-privacy-green-pwsh.txt` |
| `synthetic-provider-privacy-regression.ps1` (5.1) | leak=False, PASS, exit 0 | `build-workspace/evidence/PrintCheck/fix-round-1/parent-gates/05-synthetic-provider-privacy-green-powershell51.txt` |

New browser steps (3 of 21, historical): prose-canary import via the real file
input (DOM canonical, key names never render), real default JSON + HTML
downloads canary-free, real opt-in JSON canary-free with raw identifiers
present. The suite now also keeps a distinct copy of every download
(`build-workspace/evidence/PrintCheck/fix-round-1/exports/kept-01…kept-06-*.json|html`) and
`build-workspace/evidence/PrintCheck/fix-round-1/artifact-recheck.txt`
re-verifies those files from disk independently. Screenshots from the clean
fictional sample:
`build-workspace/evidence/PrintCheck/fix-round-1/screenshots/sample-desktop.png`, `sample-mobile-390.png`.
A real `-Sample` CLI run (plus refusal and `-Force` runs) is recorded in
`build-workspace/evidence/PrintCheck/fix-round-1/collector-sample/run-log.txt`.

Not executed: the production collector was still never run against this
machine (synthetic providers only, with cmdlet shadowing); no installs, no
git operations, no network probes, no system/settings changes. The
`fictional-prose-canary.json` fixture and the credential tokens it contains
exist only in that fixture, `tests/browser.cjs`, and the declared-fictional
RED-run artifact.

## Current baseline — package correction round 1 (2026-10-11)

This is the current result. Older 41/106/18 and 52/128/21 counts above are
historical and are not current; historical logs were not rerun.

Default entrypoint (fresh run from `work/PrintCheck` for this correction):

| Suite | Command | Result | Log (workspace-local handle) |
| --- | --- | --- | --- |
| Default (`npm test`) | `node --test tests/core.test.cjs tests/block-key-ordinal-regression.test.cjs` | **57 tests, 57 pass, 0 fail, 0 skipped**, exit 0 | `build-workspace/evidence/PrintCheck/package-correction-round-1/npm-test.txt` |
| Core only (subset) | `node --test tests/core.test.cjs` | 52 tests | (subset of the default 57; see README) |
| Ordinal regression only | `node --test tests/block-key-ordinal-regression.test.cjs` | 5 tests | (included in the default 57) |

Parent-verified baseline (workspace-local records cited, not rerun here and
not shipped with the standalone tool):

- Full core 57/57, exit 0 — `build-workspace/parent-qa/PrintCheck/post-fix-round-2/full-core.log`
  (backed by `build-workspace/parent-qa/POST-FIX-ROUND2-UNIT-SUMMARY.json`).
- Frozen Node gates 11/11, exit 0 — `build-workspace/parent-qa/PrintCheck/post-fix-round-2/frozen-node-gates.log`
  (same summary record).
- Real-Chrome browser 21/21, exit 0 — `build-workspace/parent-qa/PrintCheck/post-fix-round-2/full-browser.log`
  (backed by `build-workspace/parent-qa/POST-FIX-ROUND2-BROWSER-SUMMARY.json`).
  Browser was not rerun for this docs-only correction because runtime,
  collector, helper, and tests are unchanged; that prior 21/21 result stands.
- Synthetic collector 128/128 in both `pwsh` and Windows PowerShell 5.1
  (fake providers only; production collector never run against this machine).
  Collector counts are unchanged by this correction, so no new collector run
  was needed.

Scope preserved: this tool is not a compatibility certificate; print/scan
success, Windows protected print mode state, Mopria certification, and
IPP/eSCL capability are never tested and stay unknown. No real
printer/hardware verification was performed; no live printer inventory,
capture, installs, network probes, or system/settings changes were made for
this correction. The production collector was never run.
