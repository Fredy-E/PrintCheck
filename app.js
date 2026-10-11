'use strict';

/*
 * PrintCheck — app.js
 *
 * DOM wiring for index.html. Classic script: no modules, no requests, no
 * persistent storage. Every dynamic value is written with textContent (never
 * with HTML strings), so imported data can never become markup or script.
 *
 * Import safety: each import takes a generation token; asynchronous reads
 * only apply when their token is still current, so a racing or stale import
 * can never overwrite a newer one, and a failed import clears the dataset
 * (exports stay disabled) instead of letting stale data be exported.
 */

(function () {
  'use strict';

  var PC = window.PrintCheck;

  var els = {
    fictionBanner: document.getElementById('fiction-banner'),
    statusLine: document.getElementById('status-line'),
    errorPanel: document.getElementById('error-panel'),
    sourceName: document.getElementById('source-name'),
    warningsLine: document.getElementById('warnings-line'),
    loadSample: document.getElementById('load-sample'),
    loadEmpty: document.getElementById('load-empty'),
    loadPartial: document.getElementById('load-partial'),
    fileInput: document.getElementById('file-input'),
    clearAll: document.getElementById('clear-all'),
    filterTerm: document.getElementById('filter-term'),
    filterStatus: document.getElementById('filter-status'),
    optIdentifiers: document.getElementById('opt-identifiers'),
    identifierNote: document.getElementById('identifier-note'),
    exportJson: document.getElementById('export-json'),
    exportHtml: document.getElementById('export-html'),
    summaryLine: document.getElementById('summary-line'),
    unknownsList: document.getElementById('unknowns-list'),
    limitationsList: document.getElementById('limitations-list')
  };

  if (!PC) {
    els.statusLine.textContent = 'PrintCheck core failed to load.';
    return;
  }

  var KINDS = ['queues', 'drivers', 'ports'];
  var KIND_SINGULAR = { queues: 'queue', drivers: 'driver', ports: 'port' };
  var KIND_LABELS = {
    queues: ['Queue', 'Driver', 'Port', 'Shared', 'Reported status'],
    drivers: ['Driver', 'Environment', 'Manufacturer', 'Major version', 'Driver version'],
    ports: ['Port', 'Description', 'Host address', 'Port number']
  };
  var KIND_CELLS = {
    queues: function (item) {
      return [item.name, item.driverName, item.portName,
        item.shared === null ? null : String(item.shared), item.status];
    },
    drivers: function (item) {
      return [item.name, item.environment, item.manufacturer, item.majorVersion, item.driverVersion];
    },
    ports: function (item) {
      return [item.name, item.description, item.hostAddress, item.portNumber];
    }
  };

  var state = {
    doc: null,
    sourceLabel: '',
    fiction: false,
    status: 'empty',
    generation: 0,
    includeIdentifiers: false,
    term: '',
    filterStatus: 'all',
    warnings: [],
    droppedFieldCount: 0,
    lastImport: { ok: false, fileName: null, errorCodes: [] }
  };

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  function setStatus(text) {
    els.statusLine.textContent = text;
  }

  function showErrors(errors) {
    els.errorPanel.textContent = '';
    if (!errors || errors.length === 0) {
      els.errorPanel.hidden = true;
      return;
    }
    errors.forEach(function (error) {
      var item = document.createElement('li');
      item.textContent = error.code + ': ' + error.message;
      els.errorPanel.appendChild(item);
    });
    els.errorPanel.hidden = false;
  }

  function row(cells, labels) {
    var tr = document.createElement('tr');
    cells.forEach(function (value, index) {
      var td = document.createElement('td');
      if (labels && labels[index]) td.setAttribute('data-label', labels[index]);
      td.textContent = value === null || value === undefined ? '\u2014' : String(value);
      tr.appendChild(td);
    });
    return tr;
  }

  function renderSource(kind) {
    var section = document.getElementById('panel-' + kind);
    var statusEl = section.querySelector('.source-status');
    var apiEl = section.querySelector('.source-api');
    var errorEl = section.querySelector('.source-error');
    var tbody = document.getElementById(kind + '-body');
    var messageEl = document.getElementById(kind + '-message');
    var badge = document.getElementById(kind + '-count');
    tbody.textContent = '';

    if (!state.doc) {
      section.hidden = false;
      statusEl.textContent = 'not loaded';
      statusEl.className = 'source-status status-not-loaded';
      apiEl.textContent = '\u2014';
      errorEl.textContent = '';
      errorEl.hidden = true;
      badge.textContent = '0';
      messageEl.textContent = '';
      messageEl.hidden = true;
      return;
    }

    var source = state.doc.sources[kind];
    var visible = state.filterStatus === 'all' || source.status === state.filterStatus;
    section.hidden = !visible;

    statusEl.textContent = source.status;
    statusEl.className = 'source-status status-' + source.status;
    apiEl.textContent = source.api || '\u2014';
    if (source.error) {
      errorEl.textContent = source.error.kind + ': ' + source.error.message;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    var data = PC.filterDataset(state.doc, { term: state.term, status: state.filterStatus });
    var items = data[kind] || [];
    badge.textContent = String(source.items.length);
    items.forEach(function (item) {
      tbody.appendChild(row(KIND_CELLS[kind](item), KIND_LABELS[kind]));
    });

    if (!visible) {
      messageEl.textContent = '';
      messageEl.hidden = true;
      return;
    }
    if (items.length === 0) {
      messageEl.textContent = state.term
        ? 'No matching rows.'
        : 'No ' + KIND_SINGULAR[kind] + ' records in this dataset.';
      messageEl.hidden = false;
    } else {
      messageEl.textContent = '';
      messageEl.hidden = true;
    }
  }

  function renderSummary() {
    if (!state.doc) {
      els.summaryLine.textContent = 'Nothing loaded.';
      return;
    }
    els.summaryLine.textContent =
      state.doc.sources.queues.items.length + ' queues \u00b7 ' +
      state.doc.sources.drivers.items.length + ' drivers \u00b7 ' +
      state.doc.sources.ports.items.length + ' ports \u00b7 ' +
      state.doc.unknowns.length + ' unknowns \u00b7 ' +
      state.droppedFieldCount + ' dropped field(s)';
  }

  function renderLists() {
    els.unknownsList.textContent = '';
    var unknowns = state.doc ? state.doc.unknowns : [];
    if (unknowns.length === 0) {
      var none = document.createElement('li');
      none.textContent = state.doc
        ? 'No unknown entries in this document; the limitations below still apply.'
        : 'Load a document to see its unknown entries.';
      els.unknownsList.appendChild(none);
    } else {
      unknowns.forEach(function (entry) {
        var li = document.createElement('li');
        li.textContent = entry.topic + ' \u2014 ' + entry.state + ': ' + entry.reason;
        els.unknownsList.appendChild(li);
      });
    }

    els.limitationsList.textContent = '';
    PC.LIMITATIONS.forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      els.limitationsList.appendChild(li);
    });
  }

  function renderBanner() {
    els.fictionBanner.hidden = !(state.doc && state.fiction);
  }

  function renderWarnings() {
    var parts = [];
    if (state.droppedFieldCount > 0) {
      parts.push(state.droppedFieldCount + ' unknown field(s) were dropped from the import (never exported).');
    }
    if (state.warnings.length > 0) {
      parts.push(state.warnings.length + ' import warning(s) \u2014 first: ' + state.warnings[0].message);
    }
    if (parts.length === 0) {
      els.warningsLine.textContent = '';
      els.warningsLine.hidden = true;
      return;
    }
    els.warningsLine.textContent = parts.join(' ');
    els.warningsLine.hidden = false;
  }

  function renderControls() {
    els.exportJson.disabled = !state.doc;
    els.exportHtml.disabled = !state.doc;
    els.clearAll.disabled = !state.doc && state.status === 'empty';
    els.sourceName.textContent = state.sourceLabel || '\u2014';
    els.identifierNote.textContent = state.includeIdentifiers
      ? 'Reports will include raw queue, host, network, hardware, and source-file identifiers. Provider error text, port descriptions, API labels, and unknown explanations stay replaced with bounded built-in text in both modes; other reported metadata is exported as reported.'
      : 'Exports ordinalize queue, host, network, hardware, and source-file identifiers by default ("Queue 1", "Network 1", "Source file 1"). Provider error text, port descriptions, API labels, and unknown explanations are replaced with bounded built-in text in both modes; other reported metadata (statuses, driver and OS details) is exported as reported \u2014 review before sharing.';
  }

  function renderAll() {
    renderBanner();
    renderSummary();
    renderLists();
    renderWarnings();
    renderControls();
    KINDS.forEach(renderSource);
  }

  // -------------------------------------------------------------------------
  // import pipeline (generation-tokened; stale or racing imports never win)
  // -------------------------------------------------------------------------

  function startImport() {
    state.generation += 1;
    return state.generation;
  }

  function failImport(token, fileName, code, message) {
    if (token !== state.generation) return;
    state.lastImport = { ok: false, fileName: fileName || null, errorCodes: [code] };
    state.doc = null;
    state.sourceLabel = fileName || '';
    state.fiction = false;
    state.warnings = [];
    state.droppedFieldCount = 0;
    state.status = 'error';
    showErrors([{ code: code, message: message }]);
    setStatus('Import failed. Previous data was cleared; exports stay disabled until a valid document is loaded.');
    renderAll();
  }

  function applyImport(token, text, fileName) {
    if (token !== state.generation) return { ok: false, stale: true };
    var result = PC.parseImportText(text, fileName);
    state.lastImport = {
      ok: result.ok,
      fileName: fileName || null,
      errorCodes: (result.errors || []).map(function (error) { return error.code; })
    };

    if (!result.ok) {
      state.doc = null;
      state.sourceLabel = fileName || '';
      state.fiction = false;
      state.warnings = [];
      state.droppedFieldCount = 0;
      state.status = 'error';
      showErrors(result.errors);
      setStatus('Import failed: ' + result.errors.length +
        ' problem(s). Previous data was cleared; exports stay disabled until a valid document is loaded.');
      renderAll();
      return result;
    }

    state.doc = result.doc;
    state.sourceLabel = fileName || 'Built-in sample';
    state.fiction = result.doc.tool.mode === 'sample';
    state.warnings = result.warnings || [];
    state.droppedFieldCount = result.droppedFieldCount || 0;
    state.status = 'loaded';
    showErrors([]);
    setStatus('Loaded ' + (state.fiction ? 'fictional sample' : 'collector document') + ': ' +
      result.doc.sources.queues.items.length + ' queues \u00b7 ' +
      result.doc.sources.drivers.items.length + ' drivers \u00b7 ' +
      result.doc.sources.ports.items.length + ' ports.');
    renderAll();
    return result;
  }

  function loadSample(name) {
    var doc = PC.getSampleDoc(name);
    if (!doc) return { ok: false };
    var token = startImport();
    return applyImport(token, JSON.stringify(doc), 'sample:' + name);
  }

  els.fileInput.addEventListener('change', function () {
    var file = els.fileInput.files && els.fileInput.files[0];
    if (!file) return;
    var token = startImport();
    var reader = new FileReader();
    reader.onerror = function () {
      failImport(token, file.name, 'import-read-failed', 'The selected file could not be read.');
    };
    reader.onload = function () {
      applyImport(token, String(reader.result), file.name);
    };
    reader.readAsText(file);
    els.fileInput.value = '';
  });

  // -------------------------------------------------------------------------
  // controls
  // -------------------------------------------------------------------------

  els.loadSample.addEventListener('click', function () { loadSample('fictional-basic'); });
  els.loadEmpty.addEventListener('click', function () { loadSample('fictional-empty'); });
  els.loadPartial.addEventListener('click', function () { loadSample('fictional-partial'); });

  els.clearAll.addEventListener('click', function () {
    state.generation += 1;
    state.doc = null;
    state.sourceLabel = '';
    state.fiction = false;
    state.status = 'empty';
    state.warnings = [];
    state.droppedFieldCount = 0;
    state.lastImport = { ok: false, fileName: null, errorCodes: [] };
    showErrors([]);
    setStatus('Cleared. Load a document to begin again.');
    renderAll();
  });

  els.filterTerm.addEventListener('input', function () {
    state.term = els.filterTerm.value;
    KINDS.forEach(renderSource);
  });

  els.filterTerm.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      els.filterTerm.value = '';
      state.term = '';
      KINDS.forEach(renderSource);
    }
  });

  els.filterStatus.addEventListener('change', function () {
    state.filterStatus = els.filterStatus.value;
    renderAll();
  });

  els.optIdentifiers.addEventListener('change', function () {
    state.includeIdentifiers = els.optIdentifiers.checked;
    renderControls();
  });

  // -------------------------------------------------------------------------
  // exports (real local downloads; no requests, no storage)
  // -------------------------------------------------------------------------

  function twoDigit(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function stamp() {
    var now = new Date();
    return String(now.getFullYear()) + twoDigit(now.getMonth() + 1) + twoDigit(now.getDate()) +
      '-' + twoDigit(now.getHours()) + twoDigit(now.getMinutes()) + twoDigit(now.getSeconds());
  }

  function exportReport(kind) {
    if (!state.doc) return;
    var report = PC.buildJsonReport(state.doc, {
      includeIdentifiers: state.includeIdentifiers,
      sourceLabel: state.sourceLabel,
      warnings: state.warnings,
      droppedFieldCount: state.droppedFieldCount
    });
    var text = kind === 'html' ? PC.buildHtmlReport(report) : JSON.stringify(report, null, 2);
    var type = kind === 'html' ? 'text/html' : 'application/json';
    var blob = new Blob([text], { type: type + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'printcheck-report-' + stamp() + '.' + kind;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  els.exportJson.addEventListener('click', function () { exportReport('json'); });
  els.exportHtml.addEventListener('click', function () { exportReport('html'); });

  // -------------------------------------------------------------------------
  // documented test hook (used by tests/browser.cjs; harmless locally)
  // -------------------------------------------------------------------------

  window.PrintCheckApp = {
    importText: function (text, fileName) {
      var token = startImport();
      return applyImport(token, text, fileName || null);
    },
    loadSample: loadSample,
    getState: function () {
      return {
        status: state.status,
        exportEnabled: !!state.doc,
        sourceLabel: state.sourceLabel,
        fiction: state.fiction,
        counts: state.doc ? {
          queues: state.doc.sources.queues.items.length,
          drivers: state.doc.sources.drivers.items.length,
          ports: state.doc.sources.ports.items.length
        } : { queues: 0, drivers: 0, ports: 0 },
        errorCodes: state.lastImport.errorCodes
      };
    }
  };

  renderAll();
})();
