# PrintCheck schemas

Two documents are defined here: the **collector document** (produced by
`collector/Collect-PrintCheck.ps1`, imported by the viewer) and the **report
document** (exported by the viewer as JSON, or rendered into the HTML report).

## Collector document — `printcheck.collector`, schemaVersion 1

UTF-8, no BOM. Written by the collector on explicit user invocation; `-Sample`
writes a clearly fictional document and executes no queries.

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `schema` | string | exactly `printcheck.collector` |
| `schemaVersion` | number | exactly `1` |
| `tool` | object | `{name, version, mode}`; `mode` is `production`, `sample`, or `test` (the collector's own fake-provider suite emits `test`; only `sample` sets the fiction flag in reports) |
| `generatedAt` | string | ISO-8601 UTC timestamp |
| `host` | object | host block, below |
| `sources` | object | exactly `queues`, `drivers`, `ports` |
| `unknowns` | array | `{topic, state, reason}` entries (below) |
| `limits` | object | `{maxItemsPerSource: 500, maxStringLength: 300}` |
| `provenance` | object | `{script, mode, queriesExecuted[]}` |

### Host block

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | `ok` or `failed` |
| `api` | string \| null | canonical `Get-CimInstance Win32_OperatingSystem` (the viewer substitutes its own canonical label; imported label text is ignored) |
| `error` | object \| null | canonical `{kind, message}`: an allowlisted code (`provider-error`, `provider-unavailable`, or the fallback `error`) plus its fixed generic message. Imported exception text is never carried. |
| `hostName` | string \| null | machine name (identifier; ordinalized by default in reports) |
| `powershellVersion` | string \| null | host PowerShell version |
| `processorArchitecture` | string \| null | e.g. `ARM64` |
| `os` | object \| null | `{caption, version, build, architecture}`; `null` when the host source failed |

### Source object (per `queues` / `drivers` / `ports`)

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | `ok`, `failed`, or `unavailable` |
| `api` | string \| null | canonical per source (`Get-Printer (PrintManagement)`, `Get-PrinterDriver (PrintManagement)`, `Get-PrinterPort (PrintManagement)`); imported label text is ignored |
| `error` | object \| null | canonical `{kind, message}` (allowlisted code + fixed generic message); a failing source never fails the document |
| `count` | number | raw items seen before normalization; normalized to a non-negative integer (non-numbers fall back to the observed item count) |
| `truncated` | boolean | true when items were capped at `maxItemsPerSource` |
| `droppedItemCount` | number | items dropped because they had no usable name |
| `items` | array | normalized items (exact allowlists below) |

### Item allowlists (exact field sets — anything else is dropped and counted)

| Source | Fields | Origin |
| --- | --- | --- |
| `queues` | `name`, `driverName`, `portName`, `shared`, `status` | Get-Printer: `Name`, `DriverName`, `PortName`, `Shared`, `PrinterStatus`. `status` is the reported value at collection time and never implies print success. |
| `drivers` | `name`, `environment`, `manufacturer`, `majorVersion`, `driverVersion` | Get-PrinterDriver: `Name`, `PrinterEnvironment`, `Manufacturer`, `MajorVersion`, `DriverVersion` |
| `ports` | `name`, `description`, `hostAddress`, `portNumber` | Get-PrinterPort: `Name`, `PrinterHostAddress`, `PortNumber`. The `description` field is retained in the shape but is always `null`: description text is free text from the print subsystem and is never carried by the collector or the viewer. Every SNMP field is excluded. |

Never collected, in any mode: print jobs or document names, SNMP community
strings or other secrets, printer security descriptors (Get-Printer is called
without `-Full`), port description text (discarded), anything discovered by
probing the network.

### Unknowns (canonical per-topic text)

| Topic | State | Meaning |
| --- | --- | --- |
| `mopria-certification` | `not-tested` | vendor program; metadata cannot establish it |
| `ipp-escl-capability` | `not-tested` | not reported by the queried APIs |
| `windows-protected-print-mode` | `unknown` | state is not queried by this tool |
| `print-success` | `not-tested` | no job was submitted or monitored |
| `scan-success` | `not-tested` | no scan was performed or monitored |
| `readiness` | `not-tested` | metadata never implies printing/scanning will succeed |

The viewer carries its own bounded explanation text per topic; imported
explanations are never exported. Entries with an unrecognized topic or state
are dropped with a static warning (`unknown-entry-dropped`).

## Import rules (viewer)

1. Size limit: 2,097,152 bytes (2 MiB) of UTF-8; larger imports are rejected
   before parsing.
2. Empty or whitespace-only text is rejected.
3. The text must parse as JSON and be an object.
4. The object is validated against the schema above. Validation errors are
   structured: `{code, path, message}`. Error codes:
   `import-not-object`, `import-not-text`, `import-too-large`, `import-empty`,
   `import-json-invalid`, `schema-unsupported`, `schema-version-unsupported`,
   `tool-missing`, `tool-mode-invalid`, `generated-at-invalid`, `host-invalid`,
   `source-missing`, `source-status-invalid`, `items-not-array`.
5. Non-fatal issues are warnings: `unknowns-missing`, `item-dropped`,
   `items-truncated`, `string-truncated`, `unknown-entry-dropped`. Warning
   messages and paths are static or ordinal; imported values are never echoed.
6. Unknown fields anywhere are dropped, counted (`droppedFieldCount`) and are
   never displayed or exported. Dropped-field paths are ordinal and static
   (for example `$.sources.queues.items[0].<unknown-key>#1`, capped at 100) —
   the raw key name is never echoed anywhere.
7. Diagnostics never echo imported values: the `schema-version-unsupported`
   message omits the imported version, JSON parse failures report a fixed
   message, and error/prose text is canonicalized (below).
8. A failed import clears the current dataset; exports stay disabled until a
   valid document is loaded, so stale data cannot be exported by mistake.

## Report document — `printcheck.report`, schemaVersion 1

| Field | Notes |
| --- | --- |
| `meta` | `{tool, toolVersion, generatedAt, fiction, sourceFile, identifiersIncluded, redaction{applied, scheme, proseHandling}, droppedFieldCount, warnings[]}` |
| `host`, `sources`, `unknowns` | same shapes as the collector document, with identifiers replaced when redaction applies |
| `limitations` | fixed list rendered into every report |

### Redaction (default)

Ordinal labels per distinct value, first-appearance order: `Queue N`,
`Driver N`, `Port N`, `Network N`, `Host N`; the source file label becomes
`Source file 1`. Applied to queue/driver/port names, port host addresses, the
host name, and the source-file label.

Independently of that labeling, imported prose never reaches a report in any
mode: provider error text is replaced by an allowlisted canonical code plus a
fixed generic message, port descriptions are dropped, API labels and
provenance labels are canonical, and unknown explanations are the viewer's
bounded per-topic text. `meta.redaction.proseHandling` states this in every
report.

### Opt-in (`identifiersIncluded: true`)

Raw identifiers are included; the canonical prose handling above is identical
(opt-in never re-enables imported error text, port descriptions, API labels,
or unknown explanations), and unknown raw fields are still dropped.

### HTML report

A single file with inline styles only: no scripts, no links, no images, no
external references. Every value is HTML-escaped; hostile strings render as
text. The report carries the fiction label for sample data and the redaction
state for every export.
