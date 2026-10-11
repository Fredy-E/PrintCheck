# PrintCheck — prototype status

**Experimental concept prototype — idea exploration only.** This repository shares runnable exploratory code, not a finished product or production-ready release. The repository's package version identifies this iteration; it is not a compatibility certification or release-readiness claim.

## Purpose

Explore a local evidence viewer for user-selected Windows printer metadata. Built-in examples and test fixtures are fictional. The optional read-only collector runs only when the user invokes it; opening the viewer does not inventory printers.

## What is not established

No printing or scanning test, Mopria certification, Windows Protected Print state/compatibility certification, real-printer hardware matrix, or clean-machine qualification is established. Features may change or remain unfinished. Review exported metadata before sharing it: default redaction is not a guarantee of anonymity.

## Verification provenance

The approved local source baseline, verified on 2026-10-11, passed 57 default Node tests, 21 real-Chrome cases, and 128 synthetic collector assertions in each of PowerShell 7 and Windows PowerShell 5.1. The collector tests used fake providers, not live printer inventory. Those results measure tested behavior only, not real-world reliability.

This publication copy adds prototype status text to the README and viewer plus this document; collector, runtime JavaScript and test logic are preserved from the approved source. Reviewer logs and owner data are not included.

Open `index.html` directly. For development, use `npm test`; the real-Chrome suite is `node tests/browser.cjs`. Full historical scope and limitations are in [docs/verification.md](docs/verification.md). Publication is source sharing only: no GitHub Release, deployment or support commitment is implied.
