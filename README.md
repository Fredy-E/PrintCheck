# PrintCheck

<!-- prototype-status:start -->
> **Experimental concept prototype — idea exploration only.**
> This is a work-in-progress concept/demo, not a finished product or production-ready release. Implemented features and local tests demonstrate the prototype only; they do not establish real-world reliability, complete functionality, or hardware compatibility. Features may change or remain unfinished.

See [PROTOTYPE.md](PROTOTYPE.md) for publication status and verification limits.
<!-- prototype-status:end -->

A local, offline **evidence viewer** for Windows printer queue, driver, and port metadata.
It is **not a compatibility certificate**: print success, scan success, Windows protected
print mode state, Mopria certification, and IPP/eSCL capability are never tested and stay
unknown.

Two pieces:

- `collector/Collect-PrintCheck.ps1` — a user-invoked, read-only Windows snapshot of
  allowlisted print metadata into one versioned JSON document.
- `index.html` — a classic-script, dependency-free viewer that imports that JSON (or the
  built-in fictional samples), filters it, surfaces errors and unknowns, and exports
  self-contained reports (JSON and script-free HTML).

## Run the viewer

Open `index.html` directly from disk (double-click it). No server, no build step, no
install, no CDN, no runtime dependency. The page makes zero network requests, keeps no
persistent storage, and never reads print jobs.

## Run the collector (Windows)

```powershell
pwsh -NoProfile -NonInteractive -File collector/Collect-PrintCheck.ps1 -OutFile .\printcheck-collector.json
```

- `-Sample` writes clearly fictional built-in data and executes **no** queries.
- Existing output files are never overwritten silently — the refusal is enforced by an
  atomic filesystem create (`FileMode.CreateNew`), so two concurrent non-`-Force` runs can
  never both write the same path; the collector exits non-zero unless you pass `-Force`.
- Output is UTF-8 without BOM and bounded: 500 items per source, 300-character strings.
  Errors are written as a bounded canonical code plus a fixed generic message — provider
  exception text never reaches the document, and port description text is never carried.
- Documented Microsoft interfaces only: `Get-Printer`, `Get-PrinterDriver`,
  `Get-PrinterPort` (PrintManagement) and `Get-CimInstance Win32_OperatingSystem`.
- Read-only by construction: no print jobs or document names, no printer/driver/port
  install or removal, no spooler or settings changes, no WPP toggles, no network probes,
  no SNMP community strings, no `Get-Printer -Full` (so no security descriptors).

## Privacy model

Collected (allowlist only): queue `name/driverName/portName/shared/PrinterStatus`;
driver `name/environment/manufacturer/majorVersion/driverVersion`; port
`name/PrinterHostAddress/PortNumber` (description text is never carried); OS
`caption/version/build/architecture`; host name; PowerShell version; processor architecture.

Exported reports ordinalize identifiers by default (`Queue 1`, `Driver 1`, `Port 1`,
`Network 1`, `Host 1`, `Source file 1`). The opt-in checkbox includes raw identifiers in
exports. Independently of that checkbox, provider error text, port descriptions, API
labels, and unknown explanations are replaced with bounded canonical text in both modes —
imported prose never reaches a report, and unknown fields (including their raw key names)
are dropped. Other reported metadata (queue status, driver environment/manufacturer/
versions, OS caption/version/build) is exported as reported and can identify a machine —
review a report before sharing it.

## Tests

| Suite | Command | Size |
| --- | --- | --- |
| Default (core + ordinal regression) | `npm test` (= `node --test tests/core.test.cjs tests/block-key-ordinal-regression.test.cjs`) | 57 tests |
| Core only (subset) | `node --test tests/core.test.cjs` | 52 tests |
| Collector (synthetic providers) | `pwsh -NoProfile -NonInteractive -File tests/collector-tests.ps1` | 128 assertions |
| Browser (real Chrome) | `node tests/browser.cjs` | 21 steps |

Browser artifacts default to `tests/evidence/` relative to this folder. Set
`PRINTCHECK_EVIDENCE_DIR` to redirect a run without overwriting preserved evidence.

- The collector suite injects fake providers only. A child-process case shadows
  `Get-Printer`/`Get-PrinterDriver`/`Get-PrinterPort`/`Get-CimInstance` with recording
  fakes and proves that dot-sourcing the collector cannot trigger production queries;
  the production collector is never run against the test machine.
- The browser suite owns a fresh headless Chrome profile (never the user's browser),
  imports fixtures through the real file input, byte-checks real downloads, drives the
  UI by keyboard, and fails on any console/page error or any HTTP(S) request.
- `tests/cdp-browser.cjs` is copied byte-identical (sha256
  `3db68b5bcb1d2d5b2aabd12dce2cceb1bfda08cce9d547957d0f407315305c67`) from the parent
  workspace's smoke-tested helper.

## Repository layout

```
index.html  style.css  core.js  app.js
collector/Collect-PrintCheck.ps1
fixtures/                       fictional JSON fixtures (valid, hostile, empty, invalid)
tests/core.test.cjs             node:test unit suite (52 tests; subset of npm test)
tests/block-key-ordinal-regression.test.cjs   node:test ordinal-diagnostics regression (5 tests; included in npm test)
tests/collector-tests.ps1       PowerShell suite (fake providers only)
tests/browser.cjs               real-browser suite
tests/cdp-browser.cjs           byte-identical copy of the shared CDP helper
docs/schema.md                  collector document + report schema
docs/comparison.md              bounded comparison with built-in Windows tooling
docs/verification.md            exactly what was executed, with evidence paths
```

## Docs

- [docs/schema.md](docs/schema.md) — every field, every allowlist, the redaction scheme.
- [docs/comparison.md](docs/comparison.md) — what built-in Windows printer tooling does
  differently, based on Microsoft documentation.
- [docs/verification.md](docs/verification.md) — the executed test runs and their raw
  evidence paths.

## Limitations

- Metadata is a snapshot from one collection run and can go stale.
- No print or scan job is submitted or monitored; success is not tested.
- Windows protected print mode state is not queried (no documented read-only interface is
  used for it).
- Mopria certification, IPP/eSCL capability, and readiness are not tested.
- The viewer never displays or exports unknown raw fields or raw key names, even in opt-in
  mode; provider error text, port descriptions, API labels, and unknown explanations are
  canonicalized in both modes.
- Reported metadata (queue status, driver environment/manufacturer/versions, OS details)
  is exported as reported and can identify a machine — review a report before sharing it.

## License

MIT — see [LICENSE](LICENSE).
