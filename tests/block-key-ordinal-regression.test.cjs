'use strict';
/*
 * PrintCheck — block-key ordinal regression (fix-round-2, builder-owned).
 *
 * Covers GAP-R2-1 sibling-site class: unknown key NAMES must never form
 * diagnostic paths at $.tool / $.sources, plus the other nesting levels,
 * through every importer path and both export modes.
 * Synthetic fictional data only. No network, no storage, no real printers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const PC = require('../core.js');

const FIXED_TIME = '2026-10-11T10:00:00.000Z';
// Static/ordinal only (mirrors tests/core.test.cjs:133).
const STATIC_RE = /^\$(\.[A-Za-z]+|\.sources\.[a-z]+|\.sources\.[a-z]+\.items\[\d+\])*(\.<unknown-key>#\d+)$/;

function injectOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
}

function surfacesFor(doc) {
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, true, 'fixture must validate: ' + JSON.stringify(checked.errors));
  const out = { checked };
  out.normalized = JSON.stringify(checked.doc);
  for (const includeIdentifiers of [false, true]) {
    const report = PC.buildJsonReport(doc, { generatedAt: FIXED_TIME, includeIdentifiers });
    out['json-' + includeIdentifiers] = JSON.stringify(report);
    out['html-' + includeIdentifiers] = PC.buildHtmlReport(report);
  }
  // Text-import path carries the same hostile keys through JSON.
  const viaText = PC.parseImportText(JSON.stringify(doc), 'fiction-r2.json');
  assert.equal(viaText.ok, true, 'text import must validate: ' + JSON.stringify(viaText.errors));
  out.viaText = viaText;
  out.viaTextJson = JSON.stringify(viaText);
  return out;
}

function assertNoLeak(surfaces, canaries) {
  for (const canary of canaries) {
    for (const [name, text] of Object.entries(surfaces)) {
      if (name === 'checked' || name === 'viaText') continue;
      assert.equal(String(text).includes(canary), false, name + ' leaked key/value: ' + canary);
    }
    // Dropped-field array and whole result objects must also be clean.
    assert.equal(JSON.stringify(surfaces.checked.droppedFields).includes(canary), false,
      'droppedFields leaked: ' + canary);
    assert.equal(JSON.stringify(surfaces.checked).includes(canary), false,
      'validator result leaked: ' + canary);
    assert.equal(JSON.stringify(surfaces.viaText).includes(canary), false,
      'text-import result leaked: ' + canary);
  }
}

function assertAllOrdinal(droppedFields) {
  for (const p of droppedFields) {
    assert.ok(STATIC_RE.test(p), 'dropped-field path must be static/ordinal: ' + p);
  }
}

test('tool-block unknown key names stay ordinal via validator and text import', () => {
  const keys = ['FICTION-TOOL-KEY-SECRET-X9', '__proto__', 'constructor', 'FICTION.DOTTED.X9'];
  const doc = PC.getSampleDoc('fictional-basic');
  const baseline = PC.validateCollectorDoc(PC.getSampleDoc('fictional-basic'));
  for (const k of keys) injectOwn(doc.tool, k, { message: 'FICTION-OPAQUE-VALUE-X9' });
  const s = surfacesFor(doc);
  assert.equal(s.checked.droppedFieldCount, baseline.droppedFieldCount + keys.length);
  assert.equal(s.viaText.droppedFieldCount, baseline.droppedFieldCount + keys.length);
  for (let i = 1; i <= keys.length; i++) {
    assert.ok(s.checked.droppedFields.includes('$.tool.<unknown-key>#' + i),
      'missing $.tool ordinal #' + i + ': ' + JSON.stringify(s.checked.droppedFields));
    assert.ok(s.viaText.droppedFields.includes('$.tool.<unknown-key>#' + i),
      'text import missing $.tool ordinal #' + i);
  }
  assertNoLeak(s, [...keys, 'FICTION-OPAQUE-VALUE-X9']);
  assertAllOrdinal(s.checked.droppedFields);
  assertAllOrdinal(s.viaText.droppedFields);
  // Normalized tool block keeps only the allowlist.
  assert.deepEqual(Object.keys(s.checked.doc.tool).sort(), ['mode', 'name', 'version']);
  // Prototype members preserved, not polluted.
  assert.equal(Object.prototype.hasOwnProperty.call(doc.tool, '__proto__'), true);
  assert.equal(({ polluted: 1 }).polluted, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(PC.validateCollectorDoc(doc).doc.tool.polluted, undefined);
});

test('sources-block unknown key names stay ordinal via validator and text import', () => {
  const keys = ['FICTION-SOURCE-KEY-SECRET-X9', '__proto__', 'constructor'];
  const doc = PC.getSampleDoc('fictional-basic');
  const baseline = PC.validateCollectorDoc(PC.getSampleDoc('fictional-basic'));
  for (const k of keys) injectOwn(doc.sources, k, { status: 'ok', items: [] });
  const s = surfacesFor(doc);
  assert.equal(s.checked.droppedFieldCount, baseline.droppedFieldCount + keys.length);
  assert.equal(s.viaText.droppedFieldCount, baseline.droppedFieldCount + keys.length);
  for (let i = 1; i <= keys.length; i++) {
    assert.ok(s.checked.droppedFields.includes('$.sources.<unknown-key>#' + i),
      'missing $.sources ordinal #' + i + ': ' + JSON.stringify(s.checked.droppedFields));
    assert.ok(s.viaText.droppedFields.includes('$.sources.<unknown-key>#' + i));
  }
  assertNoLeak(s, [...keys, 'FICTION-OPAQUE-VALUE-X9']);
  assertAllOrdinal(s.checked.droppedFields);
  assertAllOrdinal(s.viaText.droppedFields);
  assert.deepEqual(Object.keys(s.checked.doc.sources).sort(), ['drivers', 'ports', 'queues']);
});

test('other nesting levels stay ordinal and value-free', () => {
  const K = 'FICTION-NEST-KEY-SECRET-X9';
  const V = 'FICTION-NEST-VALUE-SECRET-X9';
  const doc = PC.getSampleDoc('fictional-basic');
  const baseline = PC.validateCollectorDoc(PC.getSampleDoc('fictional-basic')).droppedFieldCount;
  injectOwn(doc.host, K, V);
  injectOwn(doc.host.os, K, V);
  injectOwn(doc.limits, K, V);
  injectOwn(doc.provenance, K, V);
  doc[K] = V;
  injectOwn(doc.sources.queues, K, V);
  doc.sources.queues.items[0][K] = V;
  doc.sources.drivers.items[0][K] = V;
  doc.sources.ports.items[0][K] = V;
  const s = surfacesFor(doc);
  // 9 injected unknowns.
  assert.equal(s.checked.droppedFieldCount, baseline + 9);
  assert.equal(s.viaText.droppedFieldCount, baseline + 9);
  for (const expected of [
    '$.host.<unknown-key>#1',
    '$.host.os.<unknown-key>#1',
    '$.limits.<unknown-key>#1',
    '$.provenance.<unknown-key>#1',
    '$.<unknown-key>#1',
    '$.sources.queues.<unknown-key>#1',
    '$.sources.queues.items[0].<unknown-key>#1',
    '$.sources.drivers.items[0].<unknown-key>#1',
    '$.sources.ports.items[0].<unknown-key>#1'
  ]) {
    assert.ok(s.checked.droppedFields.includes(expected), 'missing ' + expected + ': ' + JSON.stringify(s.checked.droppedFields));
  }
  assertNoLeak(s, [K, V]);
  assertAllOrdinal(s.checked.droppedFields);
  assertAllOrdinal(s.viaText.droppedFields);
  // Counts never negative.
  assert.ok(s.checked.droppedFieldCount >= 0);
  assert.ok(s.viaText.droppedFieldCount >= 0);
});

test('unknown key counts group per parent with ordinals', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  doc.tool['FICTION-A-X9'] = 1;
  doc.tool['FICTION-B-X9'] = 2;
  doc.sources['FICTION-C-X9'] = { status: 'ok', items: [] };
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.ok, true);
  assert.ok(checked.droppedFields.includes('$.tool.<unknown-key>#1'));
  assert.ok(checked.droppedFields.includes('$.tool.<unknown-key>#2'));
  assert.ok(checked.droppedFields.includes('$.sources.<unknown-key>#1'));
  assert.equal(JSON.stringify(checked).includes('FICTION-A-X9'), false);
  assert.equal(JSON.stringify(checked).includes('FICTION-B-X9'), false);
  assert.equal(JSON.stringify(checked).includes('FICTION-C-X9'), false);
});

test('inherited members are not counted as dropped', () => {
  const doc = PC.getSampleDoc('fictional-basic');
  const baseline = PC.validateCollectorDoc(PC.getSampleDoc('fictional-basic')).droppedFieldCount;
  // No own unknowns added; inherited toString/valueOf must not drop.
  const checked = PC.validateCollectorDoc(doc);
  assert.equal(checked.droppedFieldCount, baseline);
});
