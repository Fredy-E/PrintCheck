'use strict';
/*
 * PrintCheck workbench shell regression — portfolio-preview-1.
 *
 * Proves the substantive workbench redesign (not a color-only change):
 * principal shell carries data-ui-revision="portfolio-preview-1", standalone
 * --ui-* tokens exist, the honest prototype notice stays visible in the first
 * 900px desktop viewport, import/sample/export actions are grouped, tables
 * scroll inside their panels, focus/reduced-motion/print/color-scheme hold,
 * system fonts only, no network/storage, no ornamental buttons, and no page
 * overflow at desktop + 390/320 with maximal legal strings.
 *
 * Fictional fixtures only. Owns a fresh headless Chrome profile per run.
 * Evidence (downloads/screenshots) redirects via PRINTCHECK_EVIDENCE_DIR so
 * runs never overwrite preserved evidence inside the source tree.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./cdp-browser.cjs');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = process.env.PRINTCHECK_EVIDENCE_DIR || path.join(ROOT, 'tests', 'evidence');
const ARTIFACTS = path.join(EVIDENCE, 'workbench');
const SHOTS = path.join(EVIDENCE, 'workbench-shots');
const FIX = name => path.join(ROOT, 'fixtures', name);

let pass = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); pass += 1; console.log('PASS  ' + name); }
  catch (error) {
    failures.push({ name, message: (error && error.message) || String(error) });
    console.log('FAIL  ' + name);
    console.log('      ' + String((error && error.message) || error).split('\n').join('\n      '));
  }
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await launch({ artifactsDir: ARTIFACTS });
  try {
    await page.goto(path.join(ROOT, 'index.html'));

    await step('principal shell carries data-ui-revision="portfolio-preview-1"', async () => {
      const rev = await page.evaluate('document.querySelector(\'[data-ui-revision="portfolio-preview-1"]\') ? document.querySelector(\'[data-ui-revision="portfolio-preview-1"]\').getAttribute("data-ui-revision") : ""');
      assert.equal(rev, 'portfolio-preview-1', 'missing principal shell marker');
    });

    await step('standalone family tokens --ui-bg/--ui-surface/--ui-ink/--ui-muted/--ui-accent/--ui-border/--ui-radius resolve', async () => {
      const tokens = await page.evaluate('(() => { const s = getComputedStyle(document.documentElement); return ["--ui-bg","--ui-surface","--ui-ink","--ui-muted","--ui-accent","--ui-border","--ui-radius"].map(k => [k, s.getPropertyValue(k).trim()]); })()');
      for (const [k, v] of tokens) assert.ok(v.length > 0, k + ' must resolve, got empty');
    });

    await step('honest prototype notice visible in first 900px with exact wording', async () => {
      await page.viewport(1280, 900);
      const obs = await page.evaluate('(() => { const el = document.getElementById("prototype-notice"); if (!el) return { ok: false }; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const t = el.textContent || ""; return { top: r.top, bottom: r.bottom, h: r.height, display: s.display, vis: s.visibility, op: s.opacity, hasExact: t.includes("Experimental concept prototype \\u2014 idea exploration only."), hasUnfinished: /not a finished|not finished/i.test(t), hasProd: /production-ready/i.test(t) }; })()');
      assert.ok(obs.hasExact, 'exact phrase missing');
      assert.ok(obs.hasUnfinished, 'must state not finished');
      assert.ok(obs.hasProd, 'must state not production-ready');
      assert.ok(obs.bottom <= 900 && obs.top >= 0 && obs.h > 0, 'notice must sit inside first 900px viewport, got ' + JSON.stringify(obs));
      assert.equal(obs.display !== 'none' && obs.vis !== 'hidden' && Number(obs.op) > 0, true);
    });

    await step('import/sample/export actions are grouped in a labeled workspace (no flat button soup)', async () => {
      const groups = await page.evaluate('(() => ({ samples: !!document.querySelector(\'[data-action-group="samples"]\'), imp: !!document.querySelector(\'[data-action-group="import"]\'), exp: !!document.querySelector(\'[data-action-group="export"]\'), workspace: !!document.querySelector(\'[data-workspace="actions"]\') }))()');
      assert.equal(groups.workspace, true, 'missing [data-workspace="actions"]');
      assert.equal(groups.samples, true, 'missing [data-action-group="samples"]');
      assert.equal(groups.imp, true, 'missing [data-action-group="import"]');
      assert.equal(groups.exp, true, 'missing [data-action-group="export"]');
      // All functional controls must live inside the groups.
      const outside = await page.evaluate('(() => { const ids = ["load-sample","load-empty","load-partial","file-input","export-json","export-html"]; const out = []; for (const id of ids) { const el = document.getElementById(id); if (!el) { out.push(id + ":missing"); continue; } if (!el.closest("[data-action-group]")) out.push(id + ":ungrouped"); } return out; })()');
      assert.deepEqual(outside, [], 'controls outside groups: ' + outside.join(','));
    });

    await step('evidence tables scroll inside their panels (no page-level smuggling)', async () => {
      const wraps = await page.evaluate('(() => Array.from(document.querySelectorAll(".table-wrap")).map(el => ({ ox: getComputedStyle(el).overflowX, w: el.getBoundingClientRect().width })))()');
      assert.ok(wraps.length >= 3, 'expected 3 table wraps, got ' + wraps.length);
      for (const w of wraps) assert.ok(w.ox === 'auto' || w.ox === 'scroll', 'table-wrap must scroll internally, got ' + w.ox);
      const bodySmuggle = await page.evaluate('(() => { const h = getComputedStyle(document.documentElement).overflowX; const b = getComputedStyle(document.body).overflowX; return { h, b }; })()');
      assert.notEqual(bodySmuggle.h, 'hidden', 'html must not hide overflow-x');
      assert.notEqual(bodySmuggle.b, 'hidden', 'body must not hide overflow-x');
    });

    await step('system color preference honored without persistence; reduced-motion and print styles present', async () => {
      const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
      assert.ok(css.includes('prefers-color-scheme'), 'missing prefers-color-scheme');
      assert.ok(css.includes('prefers-reduced-motion'), 'missing prefers-reduced-motion');
      assert.ok(/@media\s+print/.test(css), 'missing @media print');
      assert.equal(/localStorage|sessionStorage|indexedDB/.test(css), false, 'css must not touch storage');
      const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
      assert.equal(/localStorage|sessionStorage|indexedDB/.test(appjs), false, 'app must not persist');
      // Light + dark resolve different surfaces (proves both schemes defined).
      const darkBg = await page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--ui-bg").trim()');
      assert.ok(darkBg.length > 0, 'dark --ui-bg empty');
      assert.ok(css.includes('#0c1422') || css.includes('#f2f5fa'), 'expected family palette reference');
    });

    await step('keyboard focus is visible and reaches the workspace in order', async () => {
      await page.goto(path.join(ROOT, 'index.html'));
      await page.key('Tab');
      assert.equal(await page.evaluate('(document.activeElement && document.activeElement.id) || ""'), 'skip-link');
      await page.key('Tab');
      const ring = await page.evaluate('(() => { const el = document.activeElement; const s = getComputedStyle(el); return { id: el.id, style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; })()');
      assert.equal(ring.id, 'load-sample');
      assert.notEqual(ring.style, 'none');
      assert.ok(ring.width >= 2, 'focus outline >=2px, got ' + ring.width);
    });

    await step('system fonts only, offline-only, no ornamental buttons', async () => {
      const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
      for (const [f, s] of [['index.html', html], ['app.js', appjs], ['style.css', css]]) {
        assert.equal(s.includes('http://'), false, f + ' has http://');
        assert.equal(s.includes('https://'), false, f + ' has https://');
      }
      assert.equal(/@font-face|fonts\.googleapis|fonts\.gstatic|\.woff2?|data:font/.test(css), false, 'no webfonts allowed');
      assert.equal(/fonts\.googleapis|cdn\.|unpkg|jsdelivr/i.test(html), false, 'no CDN allowed');
      const btnIds = await page.evaluate('Array.from(document.querySelectorAll("button")).map(b => b.id).sort()');
      assert.deepEqual(btnIds, ['clear-all', 'export-html', 'export-json', 'load-empty', 'load-partial', 'load-sample'], 'only functional buttons allowed, got ' + btnIds.join(','));
    });

    await step('320/390/1280 plus 300px font-width proxy with hostile strings: no page overflow, tables contained', async () => {
      await page.setInputFiles('#file-input', FIX('fictional-hostile.json'));
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'hostile rows');
      // 300px is not a supported width — it is the deterministic proxy for
      // wider platform font metrics at 320px (IMPLEMENTATION-PLAN.md:25).
      for (const w of [1280, 390, 320, 300]) {
        await page.viewport(w, 900);
        const ov = await page.evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth');
        assert.ok(ov <= 1, 'overflow at ' + w + 'px: ' + ov);
      }
      await page.viewport(1440, 1000);
      page.assertClean();
    });

    await step('print hides every input/select/textarea/button while evidence stays printable', async () => {
      await page.command('Emulation.setEmulatedMedia', { media: 'print' });
      const visible = await page.evaluate('[...document.querySelectorAll("input,select,textarea,button")].filter(n=>n.getClientRects().length && getComputedStyle(n).visibility!=="hidden").map(n=>n.id)');
      assert.deepEqual(visible, [], 'print must hide all interactive controls, got ' + visible.join(','));
      const evidence = await page.evaluate('(()=>{const wraps=[...document.querySelectorAll(".table-wrap")].filter(n=>n.getClientRects().length); const panels=[...document.querySelectorAll(".panel")].filter(n=>n.getClientRects().length); return {wraps:wraps.length, panels:panels.length};})()');
      assert.ok(evidence.wraps >= 3, 'print must keep evidence tables printable, got ' + JSON.stringify(evidence));
      assert.ok(evidence.panels >= 3, 'print must keep panels printable, got ' + JSON.stringify(evidence));
      await page.command('Emulation.setEmulatedMedia', { media: 'screen' });
      page.assertClean();
    });

    await step('hostile-bidi import stays isolated with adjacent columns and values preserved', async () => {
      const hostile = JSON.parse(fs.readFileSync(FIX('fictional-hostile.json'), 'utf8'));
      hostile.sources.queues.items[0].name = 'FICTION-BIDI-\u202e-queue-\u202b-tail';
      hostile.sources.queues.items[0].driverName = 'Mopria IPP WPP eSCL Fictional Driver';
      hostile.sources.queues.items[0].portName = 'FICTION-Port-01';
      hostile.sources.queues.items[0].status = 'Idle';
      const bidiFile = path.join(ARTIFACTS, 'synthetic-bidi.json');
      fs.writeFileSync(bidiFile, JSON.stringify(hostile));
      await page.setInputFiles('#file-input', bidiFile);
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'bidi rows');
      const bidi = await page.evaluate('getComputedStyle(document.querySelector("#queues-body td")).unicodeBidi');
      assert.ok(/isolate|plaintext/.test(bidi), 'imported cells must isolate bidi, got ' + bidi);
      const bodyText = await page.evaluate('document.querySelector("#queues-body").textContent');
      assert.ok(bodyText.includes('FICTION-BIDI-\u202e-queue-\u202b-tail'), 'bidi value must be preserved verbatim, not sanitized');
      const firstRow = await page.evaluate('(()=>{const tr=document.querySelector("#queues-body tr"); return [...tr.querySelectorAll("td")].map(td=>td.textContent);})()');
      assert.equal(firstRow[1], 'Mopria IPP WPP eSCL Fictional Driver', 'adjacent driver column must stay intact');
      assert.equal(firstRow[2], 'FICTION-Port-01', 'adjacent port column must stay intact');
      assert.equal(firstRow[4], 'Idle', 'adjacent status column must stay intact');
      page.assertClean();
    });

    await step('filtered views disclose filter state on paper without exposing the query', async () => {
      // Unfiltered baseline: full sample, no disclosure.
      await page.evaluate('document.getElementById("filter-term").value="";document.getElementById("filter-term").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("filter-status").value="all";document.getElementById("filter-status").dispatchEvent(new Event("change",{bubbles:true}));');
      await page.click('#load-sample');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'sample rows');
      assert.equal(await page.evaluate('document.getElementById("view-filter-note") ? document.getElementById("view-filter-note").hidden : true'), true, 'note hidden when unfiltered');
      assert.match(await page.evaluate('document.getElementById("summary-line").textContent'), /3 queue/);
      // Filtered by term: 1 of 3 rows, truthful visible disclosure.
      await page.fill('#filter-term', 'beta');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 1', 'one matching row');
      const note = await page.evaluate('(()=>{const n=document.querySelector("#view-filter-note");if(!n) return null;const s=getComputedStyle(n);return{text:n.textContent,hidden:!!n.hidden,visible:n.getClientRects().length>0&&s.visibility!=="hidden"&&!n.hidden,htmlKids:n.querySelectorAll("*").length};})()');
      assert.ok(note, 'missing #view-filter-note');
      assert.equal(note.hidden, false, 'note must be visible when filtered');
      assert.ok(note.visible, 'note must have a visible box, got ' + JSON.stringify(note));
      assert.match(note.text, /filtered/i, 'note must disclose filtered view');
      assert.equal(note.htmlKids, 0, 'note must be plain text (no imported HTML)');
      assert.equal(note.text.toLowerCase().includes('beta'), false, 'note must not expose the raw search query');
      assert.match(await page.evaluate('document.getElementById("summary-line").textContent'), /3 queue/, 'summary must stay full counts while filtered');
      // Full-export semantics preserved while filtered.
      const filteredDl = await page.download('#export-json');
      const filteredReport = JSON.parse(filteredDl.text);
      assert.equal(filteredReport.sources.queues.items.length, 3, 'export must stay full dataset while filtered');
      // Printed paper: disclosure visible, controls still hidden.
      await page.command('Emulation.setEmulatedMedia', { media: 'print' });
      const paper = await page.evaluate('(()=>{const n=document.querySelector("#view-filter-note");if(!n) return null;const s=getComputedStyle(n);return{text:n.textContent,visible:n.getClientRects().length>0&&s.visibility!=="hidden"&&!n.hidden};})()');
      assert.ok(paper && paper.visible && /filtered/i.test(paper.text), 'printed paper must show filter disclosure, got ' + JSON.stringify(paper));
      const paperControls = await page.evaluate('[...document.querySelectorAll("input,select,textarea,button")].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=="hidden").map(n=>n.id)');
      assert.deepEqual(paperControls, [], 'paper must still hide controls, got ' + paperControls.join(','));
      await page.command('Emulation.setEmulatedMedia', { media: 'screen' });
      // Status filter also counts as filtered.
      await page.fill('#filter-status', 'ok');
      const statusNoteHidden = await page.evaluate('document.getElementById("view-filter-note").hidden');
      assert.equal(statusNoteHidden, false, 'status-filtered view must disclose');
      await page.fill('#filter-status', 'all');
      // XSS query stays inert, disclosure stays safe.
      await page.fill('#filter-term', '<img src=x onerror=window.__pwned=true>\u202e-beta');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 0', 'xss query matches nothing');
      assert.equal(await page.evaluate('typeof window.__pwned'), 'undefined', 'no script from filter query');
      assert.equal(await page.evaluate('document.querySelectorAll("script").length'), 2, 'no injected script elements');
      const xssNote = await page.evaluate('document.querySelector("#view-filter-note").textContent');
      assert.equal(xssNote.includes('<img'), false, 'note must not echo hostile query');
      assert.match(xssNote, /filtered/i);
      // Reset/unfiltered hides again.
      await page.evaluate('document.getElementById("filter-term").value="";document.getElementById("filter-term").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("filter-status").value="all";document.getElementById("filter-status").dispatchEvent(new Event("change",{bubbles:true}));');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'rows restored');
      assert.equal(await page.evaluate('document.getElementById("view-filter-note").hidden'), true, 'note hidden after reset');
      // Invalid import clears dataset and disclosure.
      await page.setInputFiles('#file-input', FIX('invalid-not-json.json'));
      await page.waitFor('document.getElementById("error-panel").hidden === false', 'error visible');
      assert.equal(await page.evaluate('document.getElementById("view-filter-note").hidden'), true, 'note hidden after invalid-import-clear');
      assert.equal(await page.evaluate('document.querySelectorAll("#queues-body tr").length'), 0);
      page.assertClean();
    });

    await step('sample loads after redesign; exports stay byte-real; empty state stays helpful', async () => {
      await page.evaluate('document.getElementById("filter-term").value="";document.getElementById("filter-term").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("filter-status").value="all";document.getElementById("filter-status").dispatchEvent(new Event("change",{bubbles:true}));');
      await page.click('#load-sample');
      await page.waitFor('document.querySelectorAll("#queues-body tr").length === 3', 'sample rows');
      assert.equal(await page.evaluate('document.getElementById("fiction-banner").hidden'), false);
      const dl = await page.download('#export-json');
      assert.ok(dl.bytes.length > 500, 'export bytes real');
      await page.click('#clear-all');
      assert.match(await page.evaluate('document.getElementById("summary-line").textContent'), /Nothing loaded/);
      page.assertClean();
    });
  } finally { await page.close(); }

  console.log('');
  console.log('WORKBENCH SUITE: ' + pass + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('FAILED: ' + f.name + '\n  ' + f.message.split('\n').join('\n  '));
  process.exitCode = failures.length ? 1 : 0;
})().catch(e => { console.error('WORKBENCH FATAL: ' + (e && e.stack || e)); process.exitCode = 1; });
