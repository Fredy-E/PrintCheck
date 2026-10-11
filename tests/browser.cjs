'use strict';

/*
 * PrintCheck browser suite — real headless Chrome through the shared CDP
 * helper (tests/cdp-browser.cjs, copied byte-identical from the parent's
 * smoke-tested helper).
 *
 * The suite owns a fresh headless profile, opens index.html directly from
 * disk (file://), imports fixtures through the real file input, checks real
 * downloads byte-for-byte, exercises keyboard-only operation, and fails on
 * any page/console error or any HTTP(S) request made by the app.
 *
 * Screenshots and download artifacts contain fictional fixture data only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./cdp-browser.cjs');

const ROOT = path.resolve(__dirname, '..');
// Keep reruns portable and preserve previously captured evidence.
const EVIDENCE = process.env.PRINTCHECK_EVIDENCE_DIR || path.join(ROOT, 'tests', 'evidence');
const ARTIFACTS = path.join(EVIDENCE, 'exports');
const SHOTS = path.join(EVIDENCE, 'screenshots');
const FIX = name => path.join(ROOT, 'fixtures', name);

// Synthetic credential token used only by the prose-canary fixture and this
// suite; it is deliberately not a known identifier of any imported document.
const PROSE_CANARY = 'FICTION-PROSE-CANARY-7Q2';
const KEY_CANARY = 'FICTION-KEY-CANARY-7Q2';

let pass = 0;
const failures = [];

// Real downloads land in ARTIFACTS with second-resolution names, so distinct
// steps can collide; keep a per-step copy under a stable name for review.
let artifactCounter = 0;
const keepArtifact = (download, label) => {
  artifactCounter += 1;
  const ext = download.suggestedFilename.split('.').pop();
  const target = path.join(ARTIFACTS, 'kept-' + String(artifactCounter).padStart(2, '0') + '-' + label + '.' + ext);
  fs.copyFileSync(download.filename, target);
  return target;
};

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    const message = (error && error.message) || String(error);
    failures.push({ name, message });
    console.log('FAIL  ' + name);
    console.log('      ' + message.split('\n').join('\n      '));
  }
}

const rowCount = (page, selector) =>
  page.evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length');
const textOf = (page, selector) =>
  page.evaluate('(document.querySelector(' + JSON.stringify(selector) + ') || { textContent: "" }).textContent');
const propOf = (page, selector, prop) =>
  page.evaluate('(document.querySelector(' + JSON.stringify(selector) + ') || {}).' + prop);

// Keep each step independent of filter state left behind by an earlier step.
const resetFilters = async (page) => {
  await page.fill('#filter-term', '');
  await page.fill('#filter-status', 'all');
};

// The shared helper's key() shim sends keydown/keyup without the text payload
// that makes Chrome emit a keypress, so a focused button is not activated by
// key('Enter'). Send the full event pair through the helper's raw CDP command
// API (the same Input.dispatchKeyEvent mechanism a real keypress uses).
const pressEnter = async (page) => {
  await page.command('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
  });
  await page.command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  });
};

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  // Oversized import fixture (generated at run time; fictional padding only).
  const oversizedPath = path.join(ARTIFACTS, 'oversized.json');
  fs.writeFileSync(oversizedPath,
    '{"schema":"printcheck.collector","pad":"' + 'a'.repeat(2 * 1024 * 1024 + 5000) + '"}', 'utf8');

  const sampleText = fs.readFileSync(FIX('fictional-sample.json'), 'utf8');

  const page = await launch({ artifactsDir: ARTIFACTS });
  try {
    await page.goto(path.join(ROOT, 'index.html'));

    await step('page loads from file:// with zero console/page errors and zero HTTP requests', async () => {
      assert.match(await page.evaluate('document.title'), /PrintCheck/);
      assert.equal(await rowCount(page, 'script[src]'), 2, 'only the two local scripts');
      assert.equal(await propOf(page, '#fiction-banner', 'hidden'), true, 'no fiction banner before a sample loads');
      page.assertClean();
    });

    await step('UI sources are offline-only (no URLs, fetch, XHR, storage, innerHTML)', async () => {
      const sources = {
        'index.html': fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
        'app.js': fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'),
        'style.css': fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8')
      };
      for (const [file, source] of Object.entries(sources)) {
        assert.equal(source.includes('http://'), false, file + ' must not contain http://');
        assert.equal(source.includes('https://'), false, file + ' must not contain https://');
        assert.equal(/fetch\s*\(/.test(source), false, file + ' must not call fetch');
        assert.equal(source.includes('XMLHttpRequest'), false, file + ' must not use XMLHttpRequest');
        assert.equal(/localStorage|sessionStorage|indexedDB/.test(source), false, file + ' must not use persistent storage');
      }
      assert.equal(sources['app.js'].includes('innerHTML'), false, 'app.js must never use innerHTML');
    });

    await step('keyboard: Tab reaches the controls in order and focus rings are visible', async () => {
      // Deterministic focus state: navigate fresh so no earlier interaction can
      // shift Chrome's sequential-focus starting point.
      await page.goto(path.join(ROOT, 'index.html'));
      await page.key('Tab');
      const first = await page.evaluate('(document.activeElement && document.activeElement.id) || ""');
      assert.equal(first, 'skip-link', 'first Tab stop must be the skip link, got ' + first);
      await page.key('Tab');
      const ring = await page.evaluate(
        '(() => { const el = document.activeElement; const s = getComputedStyle(el);' +
        ' return { id: el.id, style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; })()');
      assert.equal(ring.id, 'load-sample', 'second Tab stop must be the sample button, got ' + ring.id);
      assert.notEqual(ring.style, 'none', 'keyboard focus must show a visible outline');
      assert.ok(ring.width >= 2, 'focus outline must be at least 2px, got ' + ring.width);
      const ids = ['skip-link', 'load-sample'];
      for (let i = 0; i < 10; i++) {
        await page.key('Tab');
        ids.push(await page.evaluate('(document.activeElement && document.activeElement.id) || ""'));
      }
      for (const needed of ['file-input', 'filter-term', 'filter-status', 'opt-identifiers']) {
        assert.ok(ids.includes(needed), 'Tab order must reach #' + needed + ' (saw ' + ids.join(',') + ')');
      }
    });

    await step('Enter activates the sample button; rows, fiction label, and keyboard-reachable exports', async () => {
      await resetFilters(page);
      await page.evaluate('document.getElementById("load-sample").focus()');
      await pressEnter(page);
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'sample rows');
      assert.equal(await propOf(page, '#fiction-banner', 'hidden'), false, 'fiction banner must be visible for sample data');
      assert.match(await textOf(page, '#fiction-banner'), /fictional/i);
      assert.equal(await propOf(page, '#export-json', 'disabled'), false, 'export enabled after a valid load');
      assert.equal(await propOf(page, '#export-html', 'disabled'), false);
      assert.match(await textOf(page, '#summary-line'), /3 queue/);
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      const ids = [];
      for (let i = 0; i < 18; i++) {
        await page.key('Tab');
        ids.push(await page.evaluate('(document.activeElement && document.activeElement.id) || ""'));
      }
      for (const needed of ['export-json', 'export-html', 'clear-all']) {
        assert.ok(ids.includes(needed), 'Tab order must reach #' + needed + ' after loading');
      }
      page.assertClean();
    });

    await step('filter: term narrows rows, empty state appears, Escape clears', async () => {
      await resetFilters(page);
      await page.fill('#filter-term', 'beta');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 1', 'one matching row');
      await page.fill('#filter-term', 'zzz');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 0', 'no matching rows');
      assert.match(await textOf(page, '#queues-message'), /No matching rows/);
      await page.evaluate('document.getElementById("filter-term").focus()');
      await page.key('Escape');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'rows restored');
      assert.equal(await propOf(page, '#filter-term', 'value'), '', 'Escape clears the filter');
      await page.click('#clear-all');
      assert.equal(await propOf(page, '#export-json', 'disabled'), true, 'export disabled after clearing');
      assert.equal(await rowCount(page, '#queues-body tr'), 0, 'rows cleared');
      page.assertClean();
    });

    await step('samples: empty-queues and partial-failure render their states; status filter works', async () => {
      await resetFilters(page);
      await page.click('#load-empty');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 0', 'empty sample rows');
      assert.match(await textOf(page, '#queues-message'), /No queue records/);
      await page.click('#load-partial');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 4', 'partial sample rows');
      assert.equal((await textOf(page, '#panel-drivers .source-status')).trim(), 'failed');
      assert.match(await textOf(page, '#panel-drivers .source-error'), /provider-error: The provider query failed/);
      assert.equal((await textOf(page, '#panel-ports .source-status')).trim(), 'unavailable');
      assert.match(await textOf(page, '#panel-ports .source-error'), /provider-unavailable: The provider is unavailable/);
      await page.fill('#filter-status', 'failed');
      await page.waitFor('document.getElementById("panel-queues").hidden === true', 'queues panel hidden');
      assert.equal(await propOf(page, '#panel-drivers', 'hidden'), false, 'failed drivers panel visible');
      assert.equal(await propOf(page, '#panel-ports', 'hidden'), true, 'unavailable ports panel hidden');
      await page.fill('#filter-status', 'all');
      await page.evaluate('document.getElementById("filter-status").focus()');
      await page.key('ArrowDown');
      await page.waitFor('document.getElementById("filter-status").value === "ok"', 'ArrowDown selects ok');
      assert.equal(await propOf(page, '#panel-queues', 'hidden'), false, 'ok queues panel visible');
      assert.equal(await propOf(page, '#panel-drivers', 'hidden'), true, 'failed panel hidden under ok filter');
      await page.fill('#filter-status', 'all');
      page.assertClean();
    });

    await step('real file input import: fixture loads with its source name', async () => {
      await resetFilters(page);
      await page.setInputFiles('#file-input', FIX('fictional-sample.json'));
      await page.waitFor('document.getElementById("source-name").textContent.includes("fictional-sample.json")', 'source label');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 4', 'imported rows');
      assert.match(await textOf(page, '#source-name'), /fictional-sample\.json/);
      assert.match(await textOf(page, '#status-line'), /Loaded/);
      page.assertClean();
    });

    await step('hostile strings stay inert text and unknown fields never render', async () => {
      await resetFilters(page);
      await page.setInputFiles('#file-input', FIX('fictional-hostile.json'));
      await page.waitFor('document.getElementById("source-name").textContent.includes("fictional-hostile.json")', 'hostile label');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'hostile rows');
      assert.equal(await page.evaluate('typeof window.__pwned'), 'undefined', 'no script execution from imported data');
      assert.equal(await rowCount(page, 'script'), 2, 'no injected script elements');
      const firstCell = await textOf(page, '#queues-body tr td');
      assert.ok(firstCell.includes('<script>'), 'hostile markup must render as literal text');
      assert.equal(await page.evaluate('document.body.textContent.includes("FICTION-JOB-CANARY")'), false);
      assert.equal(await page.evaluate('document.body.textContent.includes("FICTION-DOC-CANARY")'), false);
      assert.equal(await page.evaluate('document.body.textContent.includes("FICTION-SECRET-CANARY")'), false);
      page.assertClean();
    });

    await step('invalid JSON clears the dataset and export cannot be stale-clicked', async () => {
      await page.setInputFiles('#file-input', FIX('invalid-not-json.json'));
      await page.waitFor('document.getElementById("error-panel").hidden === false', 'error panel visible');
      assert.match(await textOf(page, '#error-panel'), /JSON/);
      assert.equal(await propOf(page, '#export-json', 'disabled'), true, 'export disabled after failed import');
      assert.equal(await rowCount(page, '#queues-body tr'), 0, 'previous rows cleared');
      let threw = false;
      try { await page.click('#export-json'); } catch { threw = true; }
      assert.ok(threw, 'clicking export after a failed import must not download stale data');
      page.assertClean();
    });

    await step('invalid schema and oversized imports are rejected with bounded messages', async () => {
      await page.setInputFiles('#file-input', FIX('invalid-schema.json'));
      await page.waitFor('document.getElementById("error-panel").hidden === false', 'schema error');
      assert.match(await textOf(page, '#error-panel'), /schemaVersion/);
      assert.equal((await textOf(page, '#error-panel')).includes('99'), false,
        'schema diagnostics must not echo the imported schemaVersion');
      assert.equal(await propOf(page, '#export-json', 'disabled'), true);
      await page.setInputFiles('#file-input', oversizedPath);
      await page.waitFor('document.getElementById("error-panel").textContent.includes("limit")', 'size error');
      assert.equal(await propOf(page, '#export-json', 'disabled'), true);
      page.assertClean();
    });

    await step('racing imports: the last import always wins', async () => {
      const result = await page.evaluate('(() => {' +
        ' const app = window.PrintCheckApp;' +
        ' app.importText(' + JSON.stringify(sampleText) + ', "race-a.json");' +
        ' app.importText("{\\"broken\\"", "race-b.json");' +
        ' const s1 = app.getState();' +
        ' app.importText("{\\"broken\\"", "race-c.json");' +
        ' app.importText(' + JSON.stringify(sampleText) + ', "race-d.json");' +
        ' const s2 = app.getState();' +
        ' return { s1, s2 }; })()');
      assert.equal(result.s1.status, 'error', 'valid-then-invalid ends in the error state');
      assert.equal(result.s1.exportEnabled, false);
      assert.equal(result.s2.status, 'loaded', 'invalid-then-valid ends loaded');
      assert.equal(result.s2.exportEnabled, true);
      assert.equal(result.s2.counts.queues, 4);
      assert.match(result.s2.sourceLabel, /race-d\.json/);
      page.assertClean();
    });

    await step('JSON export: default redaction, no secrets, real bytes', async () => {
      await resetFilters(page);
      await page.setInputFiles('#file-input', FIX('fictional-sample.json'));
      await page.waitFor('document.getElementById("source-name").textContent.includes("fictional-sample.json")', 'export label');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 4', 'rows for export');
      const download = await page.download('#export-json');
      keepArtifact(download, 'sample-default-json');
      assert.match(download.suggestedFilename, /^printcheck-report-.*\.json$/);
      assert.equal(download.bytes.length, Buffer.byteLength(download.text, 'utf8'), 'bytes must match the utf8 text');
      assert.ok(download.bytes.length > 500, 'report must not be empty');
      const report = JSON.parse(download.text);
      assert.equal(report.schema, 'printcheck.report');
      assert.equal(report.meta.identifiersIncluded, false);
      assert.equal(report.meta.redaction.applied, true);
      assert.equal(report.meta.fiction, true);
      assert.ok(Number.isFinite(Date.parse(report.meta.generatedAt)), 'generatedAt must be a real timestamp');
      assert.equal(report.meta.sourceFile, 'Source file 1');
      assert.equal(report.sources.queues.items[0].name, 'Queue 1');
      assert.equal(report.sources.queues.items[1].driverName, 'Driver 1');
      assert.equal(report.host.hostName, 'Host 1');
      assert.equal(report.sources.ports.items[0].hostAddress, 'Network 1');
      assert.equal(report.sources.ports.items[0].description, null, 'port descriptions are never exported');
      assert.equal(report.sources.queues.api, 'Get-Printer (PrintManagement)', 'API labels are canonical');
      assert.equal(report.sources.drivers.error, null);
      for (const raw of ['FICTION-Queue-Alpha', 'FICTION-SAMPLE-HOST', '192.0.2.10', 'FICTION-Port-01', 'CANARY']) {
        assert.equal(download.text.includes(raw), false, 'report must not contain: ' + raw);
      }
      page.assertClean();
    });

    await step('JSON export: explicit opt-in includes identifiers but never secrets or job data', async () => {
      await page.check('#opt-identifiers', true);
      assert.match(await textOf(page, '#identifier-note'), /include/i);
      const download = await page.download('#export-json');
      keepArtifact(download, 'sample-optin-json');
      const report = JSON.parse(download.text);
      assert.equal(report.meta.identifiersIncluded, true);
      assert.equal(report.meta.sourceFile, 'fictional-sample.json');
      assert.equal(report.sources.queues.items[0].name, 'FICTION-Queue-Alpha');
      assert.equal(report.sources.ports.items[0].description, null, 'opt-in never re-enables imported prose');
      for (const forbidden of ['CANARY', 'jobName', 'documentName', 'snmpCommunity']) {
        assert.equal(download.text.includes(forbidden), false, 'opt-in must still exclude: ' + forbidden);
      }
      await page.check('#opt-identifiers', false);
      page.assertClean();
    });

    await step('HTML export: self-contained, script-free, escaped, real bytes', async () => {
      const download = await page.download('#export-html');
      keepArtifact(download, 'sample-html');
      assert.match(download.suggestedFilename, /^printcheck-report-.*\.html$/);
      assert.equal(download.bytes.length, Buffer.byteLength(download.text, 'utf8'));
      assert.ok(download.bytes.length > 1000, 'html report must not be empty');
      assert.ok(download.text.startsWith('<!DOCTYPE html>'));
      assert.ok(download.text.endsWith('</html>'));
      assert.ok(download.text.includes('PrintCheck evidence report'));
      assert.ok(download.text.includes('Sample data'));
      assert.ok(download.text.includes('not a compatibility certificate'));
      assert.ok(download.text.includes('Queue 1'));
      for (const token of ['<script', '<link', '<img', '<iframe', 'src=', 'href=', 'onclick=', 'onerror=']) {
        assert.equal(download.text.includes(token), false, 'html report must not contain: ' + token);
      }
      const parsed = await page.evaluate('(() => {' +
        ' const doc = new DOMParser().parseFromString(' + JSON.stringify(download.text) + ', "text/html");' +
        ' return { scripts: doc.querySelectorAll("script").length, embeds: doc.querySelectorAll("link,img,iframe").length,' +
        ' styles: doc.querySelectorAll("style").length, tables: doc.querySelectorAll("table").length }; })()');
      assert.equal(parsed.scripts, 0, 'parsed report must contain zero scripts');
      assert.equal(parsed.embeds, 0, 'parsed report must contain zero external embeds');
      assert.equal(parsed.styles, 1, 'parsed report must carry its inline styles');
      assert.ok(parsed.tables >= 4, 'parsed report must contain the data tables');
      page.assertClean();
    });

    await step('prose canary import: DOM shows only canonical text, never imported prose', async () => {
      await resetFilters(page);
      await page.setInputFiles('#file-input', FIX('fictional-prose-canary.json'));
      await page.waitFor('document.getElementById("source-name").textContent.includes("fictional-prose-canary.json")', 'canary label');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 1', 'canary rows');
      const body = await page.evaluate('document.body.textContent');
      assert.equal(body.includes(PROSE_CANARY), false, 'credential canary must not render');
      assert.equal(body.includes(KEY_CANARY), false, 'raw unknown key name must not render');
      assert.match(await textOf(page, '#panel-drivers .source-error'), /error: An error was reported; details are omitted/);
      assert.equal((await textOf(page, '#panel-drivers .source-status')).trim(), 'failed', 'failure state stays visible');
      const descriptionCell = await page.evaluate('(document.querySelector("#ports-body tr td:nth-child(2)") || {}).textContent');
      assert.equal(descriptionCell, '\u2014', 'port description renders as unavailable');
      assert.match(await textOf(page, '#unknowns-list'), /Mopria certification is a vendor program/);
      assert.equal((await textOf(page, '#unknowns-list')).includes(PROSE_CANARY), false);
      assert.match(await textOf(page, '#warnings-line'), /dropped/);
      assert.equal((await textOf(page, '#warnings-line')).includes(KEY_CANARY), false);
      assert.equal(await propOf(page, '#export-json', 'disabled'), false, 'exports enabled for a valid document');
      page.assertClean();
    });

    await step('prose canary: real default JSON and HTML downloads stay canary-free', async () => {
      await page.check('#opt-identifiers', false);
      const json = await page.download('#export-json');
      keepArtifact(json, 'canary-default-json');
      assert.equal(json.text.includes(PROSE_CANARY), false, 'default JSON must not contain the credential');
      assert.equal(json.text.includes(KEY_CANARY), false, 'default JSON must not contain the raw key name');
      const report = JSON.parse(json.text);
      assert.equal(report.meta.identifiersIncluded, false);
      assert.equal(report.host.status, 'failed', 'host failure state stays visible');
      assert.deepEqual(report.sources.drivers.error, { kind: 'error', message: 'An error was reported; details are omitted.' });
      assert.equal(report.sources.queues.api, 'Get-Printer (PrintManagement)');
      assert.equal(report.sources.ports.items[0].description, null);
      assert.equal(report.sources.ports.items[0].hostAddress, 'Network 1');
      assert.equal(report.unknowns.length, 1);
      assert.equal(report.unknowns[0].reason, 'Mopria certification is a vendor program; queue metadata cannot establish it.');
      assert.ok(report.meta.droppedFieldCount >= 1, 'dropped unknown fields are counted');
      const html = await page.download('#export-html');
      keepArtifact(html, 'canary-html');
      assert.equal(html.text.includes(PROSE_CANARY), false, 'HTML must not contain the credential');
      assert.equal(html.text.includes(KEY_CANARY), false, 'HTML must not contain the raw key name');
      assert.ok(html.text.includes('details are omitted'), 'canonical error text present in HTML');
      page.assertClean();
    });

    await step('prose canary: opt-in JSON keeps raw identifiers but still no imported prose', async () => {
      await page.check('#opt-identifiers', true);
      const json = await page.download('#export-json');
      keepArtifact(json, 'canary-optin-json');
      assert.equal(json.text.includes(PROSE_CANARY), false, 'opt-in must not re-enable imported prose');
      assert.equal(json.text.includes(KEY_CANARY), false, 'opt-in must not re-enable raw key names');
      const report = JSON.parse(json.text);
      assert.equal(report.meta.identifiersIncluded, true);
      assert.equal(report.sources.queues.items[0].name, 'FICTION-Queue-Prose', 'raw identifiers are included on opt-in');
      assert.equal(report.host.hostName, 'FICTION-PROSE-HOST');
      assert.equal(report.sources.ports.items[0].description, null, 'opt-in never re-enables prose');
      await page.check('#opt-identifiers', false);
      page.assertClean();
    });

    await step('mobile 320/390 with maximal legal strings: no overflow anywhere', async () => {
      await resetFilters(page);
      await page.setInputFiles('#file-input', FIX('fictional-hostile.json'));
      await page.waitFor('document.getElementById("source-name").textContent.includes("fictional-hostile.json")', 'mobile label');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'hostile rows for mobile');
      for (const width of [390, 320]) {
        await page.viewport(width, 844);
        const overflow = await page.evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth');
        assert.ok(overflow <= 1, 'body overflow at ' + width + 'px: ' + overflow + 'px');
        const offenders = await page.evaluate('(() => {' +
          ' const limit = document.documentElement.clientWidth; const out = [];' +
          ' for (const el of document.querySelectorAll("body *")) {' +
          '   const r = el.getBoundingClientRect();' +
          '   if (r.right > limit + 1 || r.left < -1) out.push(el.tagName + (el.id ? "#" + el.id : "") + ":" + Math.round(r.right));' +
          ' } return out.slice(0, 8); })()');
        assert.deepEqual(offenders, [], 'elements crossing the viewport at ' + width + 'px');
        // Regression gate: no block-level element may collapse into a
        // one-character-per-line column (a caption did exactly that inside a
        // block table before this gate existed).
        const collapsed = await page.evaluate('(() => {' +
          ' const out = [];' +
          ' for (const el of document.querySelectorAll("body *")) {' +
          '   const display = getComputedStyle(el).display;' +
          '   if (display === "inline" || display === "inline-block" || display === "none") continue;' +
          '   const text = (el.textContent || "").trim();' +
          '   const r = el.getBoundingClientRect();' +
          '   if (text.length > 12 && r.width > 0 && r.width < 60 && r.height > 40) {' +
          '     out.push(el.tagName + (el.id ? "#" + el.id : "") + ":w" + Math.round(r.width) + "xh" + Math.round(r.height));' +
          '   }' +
          ' } return out.slice(0, 8); })()');
        assert.deepEqual(collapsed, [], 'elements collapsed into vertical text at ' + width + 'px');
      }
      await page.viewport(1440, 1000);
      page.assertClean();
    });

    await step('screenshots captured from a clean fictional sample (desktop + mobile)', async () => {
      await page.fill('#filter-term', '');
      await page.fill('#filter-status', 'all');
      await page.click('#load-sample');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'clean sample');
      assert.equal(await propOf(page, '#error-panel', 'hidden'), true, 'no error banner in the doc screenshot');
      await page.viewport(1280, 900);
      await page.screenshot(path.join(SHOTS, 'sample-desktop.png'));
      await page.viewport(390, 844);
      await page.screenshot(path.join(SHOTS, 'sample-mobile-390.png'));
      await page.viewport(1440, 1000);
      assert.ok(fs.statSync(path.join(SHOTS, 'sample-desktop.png')).size > 10000, 'desktop screenshot written');
      assert.ok(fs.statSync(path.join(SHOTS, 'sample-mobile-390.png')).size > 10000, 'mobile screenshot written');
      page.assertClean();
    });

    await step('no persistent storage of imported data', async () => {
      const storage = await page.evaluate('(() => { try { return { l: localStorage.length, s: sessionStorage.length }; }' +
        ' catch (e) { return { l: 0, s: 0, blocked: String(e && e.name) }; } })()');
      assert.equal(storage.l, 0, 'localStorage must stay empty');
      assert.equal(storage.s, 0, 'sessionStorage must stay empty');
    });

    await step('final state: zero console errors, zero HTTP requests', async () => {
      page.assertClean();
    });
  } finally {
    await page.close();
  }

  console.log('');
  console.log('BROWSER SUITE: ' + pass + ' passed, ' + failures.length + ' failed');
  for (const failure of failures) {
    console.log('FAILED: ' + failure.name);
    console.log('  ' + failure.message.split('\n').join('\n  '));
  }
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => {
  console.error('BROWSER SUITE FATAL: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
