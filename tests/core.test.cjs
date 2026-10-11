'use strict';

/*
 * PrintCheck — core unit tests (node:test, zero dependencies).
 *
 * Contract for core.js: pure logic only. No DOM, no network, no storage.
 * Loads both as a classic browser script (window.PrintCheck) and as a
 * CommonJS module (module.exports). These tests run the same code the
 * browser runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PC = require('../core.js');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const FIXED_TIME = '2026-10-11T10:00:00.000Z';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reportText(report) {
  return JSON.stringify(report);
}

// ---------------------------------------------------------------------------
// module surface
// ---------------------------------------------------------------------------

test('exposes the documented API surface', () => {
  assert.equal(typeof PC.validateCollectorDoc, 'function');
  assert.equal(typeof PC.parseImportText, 'function');
  assert.equal(typeof PC.redactDoc, 'function');
  assert.equal(typeof PC.buildJsonReport, 'function');
  assert.equal(typeof PC.buildHtmlReport, 'function');
  assert.equal(typeof PC.filterDataset, 'function');
  assert.equal(typeof PC.matchItem, 'function');
  assert.equal(typeof PC.getSampleDoc, 'function');
  assert.equal(typeof PC.htmlEscape, 'function');
  assert.equal(typeof PC.utf8ByteLength, 'function');
  assert.equal(typeof PC.VERSION, 'string');
  assert.deepEqual(PC.SAMPLE_NAMES, ['fictional-basic', 'fictional-empty', 'fictional-partial']);
  assert.equal(PC.LIMITS.MAX_IMPORT_BYTES, 2 * 1024 * 1024);
  assert.equal(PC.LIMITS.MAX_ITEMS, 500);
  assert.equal(PC.LIMITS.MAX_STRING, 300);
});

test('attaches window.PrintCheck when a browser-like global exists', () => {
  const cacheKey = require.resolve('../core.js');
  const previousWindow = global.window;
  global.window = {};
  delete require.cache[cacheKey];
  require('../core.js');
  assert.equal(typeof global.window.PrintCheck, 'object');
  assert.equal(typeof global.window.PrintCheck.validateCollectorDoc, 'function');
  delete require.cache[cacheKey];
  if (previousWindow === undefined) delete global.window;
  else global.window = previousWindow;
  // Reload the module for the remaining tests (cache was cleared).
  delete require.cache[cacheKey];
  require('../core.js');
});

test('core.js source contains no network, storage, or DOM references', () => {
  const source = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  for (const token of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage',
    'indexedDB', 'document.', 'innerHTML', 'http://', 'https://', 'WebSocket']) {
    assert.equal(source.includes(token), false, 'core.js must not contain: ' + token);
  }
});

// ---------------------------------------------------------------------------
// validateCollectorDoc — happy path
// ---------------------------------------------------------------------------

test('validates the fictional sample fixture', () => {
  const result = PC.validateCollectorDoc(fixture('fictional-sample.json'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.doc.schema, 'printcheck.collector');
  assert.equal(result.doc.schemaVersion, 1);
  assert.equal(result.doc.tool.mode, 'sample');
  assert.equal(result.doc.sources.queues.items.length, 4);
  assert.equal(result.doc.sources.drivers.items.length, 3);
  assert.equal(result.doc.sources.ports.items.length, 3);
  assert.equal(result.doc.host.hostName, 'FICTION-SAMPLE-HOST');
});

test('normalized queue items carry exactly the allowlisted fields', () => {
  const result = PC.validateCollectorDoc(fixture('fictional-sample.json'));
  const item = result.doc.sources.queues.items[0];
  assert.deepEqual(Object.keys(item).sort(),
    ['driverName', 'name', 'portName', 'shared', 'status']);
  assert.equal(item.name, 'FICTION-Queue-Alpha');
  assert.equal(item.shared, false);
  assert.equal(item.status, 'Idle');
});

test('normalized driver and port items carry exactly the allowlisted fields', () => {
  const result = PC.validateCollectorDoc(fixture('fictional-sample.json'));
  assert.deepEqual(Object.keys(result.doc.sources.drivers.items[0]).sort(),
    ['driverVersion', 'environment', 'majorVersion', 'manufacturer', 'name']);
  assert.deepEqual(Object.keys(result.doc.sources.ports.items[0]).sort(),
    ['description', 'hostAddress', 'name', 'portNumber']);
});

test('unknown top-level and item fields are dropped and counted (never passed through)', () => {
  const hostile = fixture('fictional-hostile.json');
  const result = PC.validateCollectorDoc(hostile);
  assert.equal(result.ok, true);
  assert.ok(result.droppedFieldCount >= 3, 'hostile fixture has several unknown fields');
  const text = JSON.stringify(result.doc);
  assert.equal(text.includes('CANARY'), false);
  assert.equal(text.includes('jobName'), false);
  assert.equal(text.includes('documentName'), false);
  assert.equal(text.includes('snmpCommunity'), false);
  // Fix round 1: dropped-field diagnostics use ordinal static paths and never
  // echo the raw key name (a raw key can itself carry a secret).
  assert.ok(result.droppedFields.includes('$.<unknown-key>#1'),
    'top-level unknown keys get ordinal static paths: ' + JSON.stringify(result.droppedFields));
  assert.equal(JSON.stringify(result.droppedFields).includes('jobHistory'), false,
    'raw key names are never echoed in dropped-field diagnostics');
  for (const path of result.droppedFields) {
    assert.ok(/^\$(\.[A-Za-z]+|\.sources\.[a-z]+|\.sources\.[a-z]+\.items\[\d+\])*\.<unknown-key>#\d+$/.test(path),
      'dropped-field path must be static/ordinal: ' + path);
  }
});

test('missing unknowns is tolerated with a warning (limitations list still shown by the app)', () => {
  const doc = clone(fixture('fictional-sample.json'));
  delete doc.unknowns;
  const result = PC.validateCollectorDoc(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => w.code === 'unknowns-missing'));
});

test('queue items without a usable name are dropped individually with a warning', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.sources.queues.items.push({ driverName: 'Fictional Orphan Driver' });
  doc.sources.queues.items.push({ name: '   ' });
  const result = PC.validateCollectorDoc(doc);
  assert.equal(result.ok, true);
  assert.equal(result.doc.sources.queues.items.length, 4);
  assert.equal(result.doc.sources.queues.droppedItemCount, 2);
  assert.ok(result.warnings.some(w => w.code === 'item-dropped'));
});

test('item counts beyond MAX_ITEMS are truncated with a warning', () => {
  const doc = clone(fixture('fictional-sample.json'));
  const items = [];
  for (let i = 0; i < 620; i++) {
    items.push({ name: 'FICTION-Queue-' + String(i).padStart(4, '0'), shared: false, status: 'Idle' });
  }
  doc.sources.queues.items = items;
  doc.sources.queues.count = 620;
  const result = PC.validateCollectorDoc(doc);
  assert.equal(result.ok, true);
  assert.equal(result.doc.sources.queues.items.length, 500);
  assert.equal(result.doc.sources.queues.truncated, true);
  assert.ok(result.warnings.some(w => w.code === 'items-truncated'));
});

test('overlong strings are truncated to MAX_STRING with a warning', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.sources.queues.items[0].name = 'FICTION-' + 'A'.repeat(600);
  const result = PC.validateCollectorDoc(doc);
  assert.equal(result.ok, true);
  assert.equal(result.doc.sources.queues.items[0].name.length, 300);
  assert.ok(result.warnings.some(w => w.code === 'string-truncated'));
});

// ---------------------------------------------------------------------------
// validateCollectorDoc — structured failures
// ---------------------------------------------------------------------------

function expectError(doc, code) {
  const result = PC.validateCollectorDoc(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.code === code),
    'expected error code ' + code + ' in ' + JSON.stringify(result.errors));
  for (const e of result.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.message, 'string');
  }
}

test('rejects a document with an unsupported schema name', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.schema = 'something.else';
  expectError(doc, 'schema-unsupported');
});

test('rejects an unsupported schemaVersion', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.schemaVersion = 99;
  expectError(doc, 'schema-version-unsupported');
});

test('rejects a missing tool block and an invalid tool mode', () => {
  const doc = clone(fixture('fictional-sample.json'));
  delete doc.tool;
  expectError(doc, 'tool-missing');
  const doc2 = clone(fixture('fictional-sample.json'));
  doc2.tool.mode = 'whatever';
  expectError(doc2, 'tool-mode-invalid');
});

test('rejects an unparseable generatedAt', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.generatedAt = 'not-a-date';
  expectError(doc, 'generated-at-invalid');
});

test('rejects a missing host block and an invalid host status', () => {
  const doc = clone(fixture('fictional-sample.json'));
  delete doc.host;
  expectError(doc, 'host-invalid');
  const doc2 = clone(fixture('fictional-sample.json'));
  doc2.host.status = 'maybe';
  expectError(doc2, 'host-invalid');
});

test('rejects a missing source and an invalid source status', () => {
  const doc = clone(fixture('fictional-sample.json'));
  delete doc.sources.queues;
  expectError(doc, 'source-missing');
  const doc2 = clone(fixture('fictional-sample.json'));
  doc2.sources.ports.status = 'sorta';
  expectError(doc2, 'source-status-invalid');
});

test('rejects non-array items on an ok source', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.sources.queues.items = 'nope';
  expectError(doc, 'items-not-array');
});

test('rejects a non-object document', () => {
  const result = PC.validateCollectorDoc([1, 2, 3]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.code === 'import-not-object'));
});

// ---------------------------------------------------------------------------
// parseImportText — size and parse limits
// ---------------------------------------------------------------------------

test('parseImportText accepts a valid fixture', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'fictional-sample.json'), 'utf8');
  const result = PC.parseImportText(text, 'fictional-sample.json');
  assert.equal(result.ok, true);
  assert.equal(result.doc.sources.queues.items.length, 4);
  assert.equal(result.sourceFile, 'fictional-sample.json');
});

test('parseImportText rejects imports over the byte limit', () => {
  const text = '{"pad":"' + 'a'.repeat(2 * 1024 * 1024 + 10) + '"}';
  const result = PC.parseImportText(text, 'oversized.json');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.code === 'import-too-large'));
});

test('parseImportText rejects empty text and invalid JSON', () => {
  assert.ok(PC.parseImportText('   ', 'empty.json').errors.some(e => e.code === 'import-empty'));
  const bad = PC.parseImportText('{"schema": "printcheck.collector", not json', 'bad.json');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.code === 'import-json-invalid'));
});

test('parseImportText rejects valid JSON that is not an object', () => {
  const result = PC.parseImportText('[1,2,3]', 'array.json');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.code === 'import-not-object'));
});

// ---------------------------------------------------------------------------
// redaction and reports
// ---------------------------------------------------------------------------

test('default JSON report ordinalizes identifiers deterministically', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const opts = { generatedAt: FIXED_TIME, sourceLabel: 'fictional-sample.json', warnings: [] };
  const r1 = PC.buildJsonReport(doc, opts);
  const r2 = PC.buildJsonReport(doc, opts);
  assert.deepEqual(r1, r2, 'same input must produce the same report');
  assert.equal(r1.schema, 'printcheck.report');
  assert.equal(r1.schemaVersion, 1);
  assert.equal(r1.meta.identifiersIncluded, false);
  assert.equal(r1.meta.redaction.applied, true);
  assert.equal(r1.meta.sourceFile, 'Source file 1');
  assert.equal(r1.meta.fiction, true);
  assert.equal(r1.meta.generatedAt, FIXED_TIME);
  assert.equal(r1.sources.queues.items[0].name, 'Queue 1');
  assert.equal(r1.sources.queues.items[1].name, 'Queue 2');
  assert.equal(r1.sources.queues.items[1].driverName, 'Driver 1', 'duplicate driver shares its label');
  assert.equal(r1.sources.queues.items[2].driverName, 'Driver 2');
  assert.equal(r1.sources.queues.items[0].portName, 'Port 1');
  assert.equal(r1.host.hostName, 'Host 1');
  assert.equal(r1.sources.ports.items[0].hostAddress, 'Network 1');
  assert.equal(r1.sources.ports.items[1].hostAddress, 'Network 2');
});

test('default JSON report never contains raw identifiers, secrets, or unknown fields', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, sourceLabel: 'fictional-sample.json' });
  const text = reportText(report);
  for (const raw of ['FICTION-Queue-Alpha', 'FICTION-SAMPLE-HOST', '192.0.2.10', 'FICTION-Port-01', 'Fictional Universal Print Driver v4']) {
    assert.equal(text.includes(raw), false, 'report must not contain raw identifier: ' + raw);
  }
  assert.equal(text.includes('CANARY'), false);
});

test('opt-in identifiers keep raw names but still drop secrets, job data, and unknown fields', () => {
  const hostile = PC.validateCollectorDoc(fixture('fictional-hostile.json')).doc;
  const report = PC.buildJsonReport(hostile, {
    generatedAt: FIXED_TIME, sourceLabel: 'fictional-hostile.json', includeIdentifiers: true
  });
  assert.equal(report.meta.identifiersIncluded, true);
  assert.equal(report.meta.redaction.applied, false);
  assert.equal(report.meta.sourceFile, 'fictional-hostile.json');
  assert.equal(report.sources.queues.items[0].name, hostile.sources.queues.items[0].name,
    'opt-in mode keeps the raw (hostile) name');
  assert.ok(report.sources.queues.items[0].name.startsWith('<script>'));
  assert.notEqual(report.sources.queues.items[0].name, 'Queue 1');
  const text = reportText(report);
  assert.equal(text.includes('CANARY'), false);
  assert.equal(text.includes('jobName'), false);
  assert.equal(text.includes('documentName'), false);
  assert.equal(text.includes('snmpCommunity'), false);
});

test('port descriptions are never carried into state or reports (default or opt-in)', () => {
  const raw = fixture('fictional-sample.json');
  assert.ok(raw.sources.ports.items[0].description.includes('192.0.2.10'), 'fixture sanity: raw description embeds the address');
  const doc = PC.validateCollectorDoc(raw).doc;
  assert.equal(doc.sources.ports.items[0].description, null, 'normalized state drops the description text');
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, sourceLabel: 'fictional-sample.json' });
  assert.equal(report.sources.ports.items[0].description, null);
  const optIn = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, sourceLabel: 'fictional-sample.json', includeIdentifiers: true });
  assert.equal(optIn.sources.ports.items[0].description, null, 'opt-in must not re-enable imported prose');
  const html = PC.buildHtmlReport(report);
  assert.equal(html.includes('Fictional TCP/IP port'), false, 'HTML report must not carry the description text');
});

test('source error text is canonical in state and in both export modes', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-partial-failure.json')).doc;
  assert.deepEqual(doc.sources.drivers.error,
    { kind: 'provider-error', message: 'The provider query failed; error details are omitted.' });
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, sourceLabel: 'fictional-partial-failure.json' });
  assert.deepEqual(report.sources.drivers.error,
    { kind: 'provider-error', message: 'The provider query failed; error details are omitted.' });
  assert.equal(JSON.stringify(report).includes('FICTION-Queue-Alpha'), false);
  assert.equal(JSON.stringify(report).includes('Fictional failure'), false);
  const optIn = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, includeIdentifiers: true });
  assert.equal(JSON.stringify(optIn).includes('Fictional failure'), false, 'opt-in must not re-enable imported error text');
  assert.equal(report.sources.drivers.status, 'failed', 'failure state stays visible');
});

test('redactDoc exposes the label maps it applied', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const redacted = PC.redactDoc(doc, { includeIdentifiers: false });
  assert.equal(redacted.maps.queues['FICTION-Queue-Alpha'], 'Queue 1');
  assert.equal(redacted.maps.ports['FICTION-Port-01'], 'Port 1');
  assert.equal(redacted.maps.networks['192.0.2.10'], 'Network 1');
  assert.equal(redacted.maps.host['FICTION-SAMPLE-HOST'], 'Host 1');
});

test('buildJsonReport refuses a document that was not validated first', () => {
  assert.throws(() => PC.buildJsonReport({ schema: 'printcheck.collector' }, {}),
    err => err && err.code === 'invalid-doc');
});

test('report carries the canonical unknowns and limitations', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME });
  const topics = report.unknowns.map(u => u.topic);
  for (const topic of ['mopria-certification', 'ipp-escl-capability', 'windows-protected-print-mode',
    'print-success', 'scan-success', 'readiness']) {
    assert.ok(topics.includes(topic), 'missing unknown topic: ' + topic);
  }
  const mopria = report.unknowns.find(u => u.topic === 'mopria-certification');
  assert.equal(mopria.reason, 'Mopria certification is a vendor program; queue metadata cannot establish it.',
    'unknown explanations are the viewer\u2019s canonical bounded text');
  assert.ok(report.limitations.some(l => /not a compatibility certificate/i.test(l)));
  assert.ok(report.limitations.some(l => /replaced with bounded built-in text/i.test(l)));
});

test('driver-name substrings never flip capability unknowns (Mopria/IPP/WPP/eSCL false positives)', () => {
  const doc = clone(fixture('fictional-sample.json'));
  doc.sources.drivers.items[0].name = 'Mopria IPP WPP eSCL Fictional Universal Driver';
  const validated = PC.validateCollectorDoc(doc);
  assert.equal(validated.ok, true);
  const report = PC.buildJsonReport(validated.doc, { generatedAt: FIXED_TIME });
  const text = reportText(report);
  assert.equal(text.includes('"certified"'), false);
  assert.equal(text.includes('"supported"'), false);
  assert.equal(text.includes('"ready"'), false);
  const mopria = report.unknowns.find(u => u.topic === 'mopria-certification');
  assert.equal(mopria.state, 'not-tested');
  const wpp = report.unknowns.find(u => u.topic === 'windows-protected-print-mode');
  assert.equal(wpp.state, 'unknown');
});

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

test('HTML report is self-contained, script-free, and labeled', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, sourceLabel: 'fictional-sample.json' });
  const html = PC.buildHtmlReport(report);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('PrintCheck evidence report'));
  assert.ok(html.includes('Sample data'));
  assert.ok(html.includes('not a compatibility certificate'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.endsWith('</html>'));
  for (const token of ['<script', '<link', '<img', '<iframe', 'src=', 'onerror=', 'onclick=', 'href="http']) {
    assert.equal(html.includes(token), false, 'HTML report must not contain: ' + token);
  }
  assert.ok(html.includes('Queue 1'));
});

test('HTML report escapes hostile strings', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-hostile.json')).doc;
  // Default mode carries the hostile manufacturer; opt-in carries the hostile
  // queue name (the hostile port description no longer exists as a sink).
  const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME });
  const html = PC.buildHtmlReport(report);
  assert.ok(html.includes('&lt;img src=x onerror=window.__pwned=true&gt;'), 'hostile markup must be escaped');
  assert.equal(html.includes('<img src=x'), false);
  const optIn = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, includeIdentifiers: true });
  const optInHtml = PC.buildHtmlReport(optIn);
  assert.ok(optInHtml.includes('&lt;script&gt;'), 'hostile identifier markup must be escaped');
  assert.equal(optInHtml.includes('<script>window.__pwned'), false);
});

test('htmlEscape covers the HTML-significant characters', () => {
  assert.equal(PC.htmlEscape('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(PC.htmlEscape('plain text'), 'plain text');
});

test('utf8ByteLength counts bytes, not code units', () => {
  assert.equal(PC.utf8ByteLength('a'), 1);
  assert.equal(PC.utf8ByteLength('é'), 2);
  assert.equal(PC.utf8ByteLength('→'), 3);
  assert.equal(PC.utf8ByteLength('🚀'), 4);
});

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

test('matchItem matches substrings case-insensitively over the given fields only', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const queue = doc.sources.queues.items[0];
  assert.equal(PC.matchItem(queue, 'alpha', ['name', 'driverName']), true);
  assert.equal(PC.matchItem(queue, 'ALPHA', ['name']), true);
  assert.equal(PC.matchItem(queue, 'alpha', ['driverName']), false);
  assert.equal(PC.matchItem(queue, 'zzz', ['name', 'driverName', 'portName']), false);
});

test('filterDataset filters rows by term and sources by status', () => {
  const doc = PC.validateCollectorDoc(fixture('fictional-sample.json')).doc;
  const beta = PC.filterDataset(doc, { term: 'beta', status: 'all' });
  assert.equal(beta.queues.length, 1);
  assert.equal(beta.queues[0].name, 'FICTION-Queue-Beta');
  const none = PC.filterDataset(doc, { term: 'zzz', status: 'all' });
  assert.equal(none.queues.length, 0);
  assert.equal(none.drivers.length, 0);
  const failed = PC.filterDataset(doc, { term: '', status: 'failed' });
  assert.deepEqual(failed.visibleSources, []);
  assert.equal(failed.queues.length, 0);

  const partial = PC.validateCollectorDoc(fixture('fictional-partial-failure.json')).doc;
  const partialFailed = PC.filterDataset(partial, { term: '', status: 'failed' });
  assert.deepEqual(partialFailed.visibleSources, ['drivers']);
  const partialOk = PC.filterDataset(partial, { term: '', status: 'ok' });
  assert.deepEqual(partialOk.visibleSources, ['queues']);
  assert.equal(partialOk.queues.length, 4);
});

// ---------------------------------------------------------------------------
// built-in samples
// ---------------------------------------------------------------------------

test('built-in samples validate and are clearly fictional', () => {
  for (const name of PC.SAMPLE_NAMES) {
    const doc = PC.getSampleDoc(name);
    const result = PC.validateCollectorDoc(doc);
    assert.equal(result.ok, true, name + ' must validate: ' + JSON.stringify(result.errors));
    assert.equal(result.doc.tool.mode, 'sample', name + ' must be flagged as sample mode');
  }
  assert.equal(PC.getSampleDoc('fictional-basic').sources.queues.items.length, 3);
  assert.equal(PC.getSampleDoc('fictional-empty').sources.queues.items.length, 0);
  assert.equal(PC.getSampleDoc('fictional-partial').sources.drivers.status, 'failed');
});

test('getSampleDoc returns a fresh copy each call', () => {
  const first = PC.getSampleDoc('fictional-basic');
  first.sources.queues.items[0].name = 'MUTATED';
  const second = PC.getSampleDoc('fictional-basic');
  assert.notEqual(second.sources.queues.items[0].name, 'MUTATED');
});

test('every sample queue name is marked FICTION- so exported reports are unmistakable', () => {
  for (const name of PC.SAMPLE_NAMES) {
    const doc = PC.getSampleDoc(name);
    for (const item of doc.sources.queues.items) {
      assert.ok(item.name.startsWith('FICTION-'), item.name + ' must be visibly fictional');
    }
  }
});

// ---------------------------------------------------------------------------
// fix round 1 — canonical prose handling (parent gate equivalents)
// ---------------------------------------------------------------------------

const CANARY = 'FICTION-FREETEXT-CANARY-7Q2';

function reportSurfaces(doc) {
  const surfaces = [];
  for (const includeIdentifiers of [false, true]) {
    const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, includeIdentifiers });
    surfaces.push(['json-' + includeIdentifiers, JSON.stringify(report)]);
    surfaces.push(['html-' + includeIdentifiers, PC.buildHtmlReport(report)]);
  }
  return surfaces;
}

test('unknown credential-bearing provider error is not retained in state or any export', () => {
  const doc = PC.getSampleDoc('fictional-partial');
  doc.sources.drivers.error.message = 'Provider rejected password=' + CANARY + ' at \\\\fiction-private-host\\queue 198.51.100.244';
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, true);
  assert.equal(JSON.stringify(checked.doc).includes(CANARY), false, 'normalized state must not keep the credential');
  assert.equal(checked.doc.sources.drivers.status, 'failed', 'failure state stays visible');
  assert.deepEqual(checked.doc.sources.drivers.error,
    { kind: 'provider-error', message: 'The provider query failed; error details are omitted.' });
  const surfaces = [['normalized', JSON.stringify(checked.doc)], ...reportSurfaces(doc)];
  for (const [name, text] of surfaces) {
    assert.equal(text.includes(CANARY), false, name + ': untrusted free-text errors must not preserve credentials');
  }
});

test('free-text mutation matrix: opaque prose never survives state, JSON or HTML in either mode', () => {
  const mutations = {
    'failed host error': d => { d.host.status = 'failed'; d.host.error = { kind: 'provider-error', message: 'password=' + CANARY }; },
    'provider error kind': d => { d.sources.drivers.error.kind = CANARY; },
    'port description': d => { d.sources.ports.items[0].description = 'password=' + CANARY + ' at \\\\fiction-server\\share'; },
    'unknown explanation': d => { d.unknowns[0].reason = 'password=' + CANARY; },
    'unknown topic': d => { d.unknowns[0].topic = CANARY; },
    'unknown state': d => { d.unknowns[0].state = CANARY; },
    'source API label': d => { d.sources.queues.api = CANARY; },
    'host API label': d => { d.host.api = CANARY; },
    'provenance script label': d => { d.provenance.script = CANARY; },
    'provenance query label': d => { d.provenance.queriesExecuted = [CANARY]; }
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const doc = PC.getSampleDoc(label === 'port description' ? 'fictional-basic' : 'fictional-partial');
    mutate(doc);
    const checked = PC.validateCollectorDoc(doc);
    assert.equal(checked.ok, true, label + ' must still validate');
    const surfaces = [['normalized', JSON.stringify(checked.doc)], ...reportSurfaces(doc)];
    const leaked = surfaces.filter(([, text]) => text.includes(CANARY)).map(([name]) => name);
    assert.deepEqual(leaked, [], label + ' leaked into: ' + leaked.join(', '));
  }
});

test('invalid schema diagnostics never echo the imported schemaVersion', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  doc.schemaVersion = CANARY;
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(e => e.code === 'schema-version-unsupported'));
  assert.equal(JSON.stringify(checked.errors).includes(CANARY), false);
  assert.equal(JSON.stringify(checked).includes(CANARY), false);
});

test('discarded-field diagnostics never preserve opaque key names', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  doc.sources.queues.items[0][CANARY] = 'discard me';
  doc[CANARY] = 'discard me too';
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, true);
  assert.ok(checked.droppedFieldCount >= 2);
  assert.equal(JSON.stringify(checked).includes(CANARY), false);
  assert.ok(checked.droppedFields.includes('$.sources.queues.items[0].<unknown-key>#1'));
  assert.ok(checked.droppedFields.includes('$.<unknown-key>#1'));
});

test('JSON parse diagnostics never echo imported text', () => {
  const bad = PC.parseImportText(CANARY + ' is not json', 'canary.json');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.code === 'import-json-invalid'));
  assert.equal(JSON.stringify(bad.errors).includes(CANARY), false);
  assert.equal(bad.errors[0].message, 'File is not valid JSON; nothing was imported.');
});

test('provider errors normalize to bounded canonical codes and fixed messages', () => {
  const checked = PC.validateCollectorDoc(PC.getSampleDoc('fictional-partial'));
  assert.deepEqual(checked.doc.sources.drivers.error,
    { kind: 'provider-error', message: 'The provider query failed; error details are omitted.' });
  assert.deepEqual(checked.doc.sources.ports.error,
    { kind: 'provider-unavailable', message: 'The provider is unavailable; details are omitted.' });
  const unknownKind = PC.getSampleDoc('fictional-partial');
  unknownKind.sources.drivers.error = { kind: 'weird-kind', message: 'arbitrary text' };
  const fallback = PC.validateCollectorDoc(unknownKind);
  assert.deepEqual(fallback.doc.sources.drivers.error,
    { kind: 'error', message: 'An error was reported; details are omitted.' });
  const noError = PC.getSampleDoc('fictional-basic');
  assert.equal(PC.validateCollectorDoc(noError).doc.sources.queues.error, null);
});

test('API and provenance labels are canonical per source; imported labels are ignored', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  doc.sources.queues.api = CANARY;
  doc.sources.drivers.api = CANARY;
  doc.sources.ports.api = CANARY;
  doc.host.api = CANARY;
  doc.provenance.script = CANARY;
  doc.provenance.mode = 'bogus-mode';
  doc.provenance.queriesExecuted = [CANARY, 'Get-Printer (PrintManagement)'];
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.doc.sources.queues.api, 'Get-Printer (PrintManagement)');
  assert.equal(checked.doc.sources.drivers.api, 'Get-PrinterDriver (PrintManagement)');
  assert.equal(checked.doc.sources.ports.api, 'Get-PrinterPort (PrintManagement)');
  assert.equal(checked.doc.host.api, 'Get-CimInstance Win32_OperatingSystem');
  assert.equal(checked.doc.provenance.script, 'collector/Collect-PrintCheck.ps1');
  assert.equal(checked.doc.provenance.mode, null);
  assert.deepEqual(checked.doc.provenance.queriesExecuted, ['Get-Printer (PrintManagement)']);
  assert.equal(JSON.stringify(checked.doc).includes(CANARY), false);
});

test('unknowns keep only canonical topics/states with the canonical explanation', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  doc.unknowns = [
    { topic: 'mopria-certification', state: 'not-tested', reason: CANARY },
    { topic: CANARY, state: 'unknown', reason: 'discard me' },
    { topic: 'readiness', state: 'verified', reason: 'discard me' }
  ];
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, true);
  assert.equal(checked.doc.unknowns.length, 1);
  assert.deepEqual(checked.doc.unknowns[0], {
    topic: 'mopria-certification',
    state: 'not-tested',
    reason: 'Mopria certification is a vendor program; queue metadata cannot establish it.'
  });
  assert.equal(JSON.stringify(checked).includes(CANARY), false);
  assert.equal(checked.warnings.filter(w => w.code === 'unknown-entry-dropped').length, 2);
});

test('counts normalize to non-negative integers; non-numbers fall back to the observed count', () => {
  const base = PC.getSampleDoc('fictional-basic');
  const negative = clone(base);
  negative.sources.queues.count = -5;
  assert.equal(PC.validateCollectorDoc(negative).doc.sources.queues.count, 0, 'negative counts clamp to 0');
  const fractional = clone(base);
  fractional.sources.queues.count = 2.5;
  assert.equal(PC.validateCollectorDoc(fractional).doc.sources.queues.count, 2, 'fractional counts floor');
  const stringy = clone(base);
  stringy.sources.queues.count = '5';
  assert.equal(PC.validateCollectorDoc(stringy).doc.sources.queues.count, 3, 'non-numbers fall back to the observed item count');
  const big = clone(base);
  big.sources.queues.count = 620;
  assert.equal(PC.validateCollectorDoc(big).doc.sources.queues.count, 620, 'large counts are preserved');
});

test('report meta documents canonical prose handling and no stale sanitizer claim', () => {
  const report = PC.buildJsonReport(PC.getSampleDoc('fictional-basic'), { generatedAt: FIXED_TIME });
  assert.equal(report.meta.redaction.applied, true);
  assert.equal(Object.prototype.hasOwnProperty.call(report.meta.redaction, 'sanitizedFields'), false,
    'the identifier-substitution sanitizer no longer exists');
  assert.match(report.meta.redaction.proseHandling, /canonical/i);
  const optIn = PC.buildJsonReport(PC.getSampleDoc('fictional-basic'), { generatedAt: FIXED_TIME, includeIdentifiers: true });
  assert.equal(optIn.meta.redaction.applied, false);
  assert.match(optIn.meta.redaction.proseHandling, /identical in both export modes/i);
});

test('normalization is idempotent (reports re-validate the normalized document safely)', () => {
  const first = PC.validateCollectorDoc(fixture('fictional-hostile.json'));
  const second = PC.validateCollectorDoc(first.doc);
  assert.equal(second.ok, true);
  assert.deepEqual(second.doc, first.doc);
});
