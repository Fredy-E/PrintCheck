'use strict';

/*
 * PrintCheck — core.js
 *
 * Pure, dependency-free logic shared by the browser UI (app.js) and the Node
 * unit tests (tests/core.test.cjs). Loads as a classic browser script
 * (window.PrintCheck) and as a CommonJS module (module.exports).
 *
 * Nothing here touches the network, storage, timers, or the DOM. Every
 * function is a pure transform over plain JSON data so it can be unit-tested
 * outside a browser.
 *
 * Contract notes
 *   - validateCollectorDoc / parseImportText return
 *     { ok, errors:[{code,path,message}], warnings:[...], droppedFields,
 *       droppedFieldCount, doc }.
 *   - Unknown fields are dropped, never passed through (allowlist model);
 *     dropped-field diagnostics use ordinal static paths (never raw key names).
 *   - Imported prose is never carried: provider errors become a bounded
 *     canonical code plus a fixed generic message, port descriptions are
 *     dropped, API/provenance labels are canonical per source, and unknown
 *     explanations are the viewer's own bounded text per known topic.
 *   - Identifiers are ordinalized by default in reports ("Queue 1"), never
 *     in the on-screen view.
 *   - Unknowns (WPP state, Mopria certification, IPP/eSCL capability, print
 *     and scan success) stay unknown/not-tested; unrecognized topics or
 *     states are dropped with a static warning.
 */

(function (factory) {
  'use strict';
  var api = factory();
  var isCommonJs = (typeof module === 'object' && module && module.exports);
  if (isCommonJs) module.exports = api;
  if (typeof window !== 'undefined' && window) {
    window.PrintCheck = api;
  } else if (!isCommonJs && typeof globalThis !== 'undefined') {
    globalThis.PrintCheck = api;
  }
})(function () {
  'use strict';

  var VERSION = '0.1.0';
  var COLLECTOR_SCHEMA = 'printcheck.collector';
  var COLLECTOR_SCHEMA_VERSION = 1;
  var REPORT_SCHEMA = 'printcheck.report';
  var REPORT_SCHEMA_VERSION = 1;
  var ALLOWED_MODES = ['production', 'sample', 'test'];

  // Bounded canonical error codes and their fixed generic messages. Imported
  // error text is never carried into state, the DOM, logs, or reports.
  var ERROR_KINDS = {
    'provider-error': 'The provider query failed; error details are omitted.',
    'provider-unavailable': 'The provider is unavailable; details are omitted.',
    'error': 'An error was reported; details are omitted.'
  };

  // Canonical per-topic unknown explanations (fixed text, never imported).
  var UNKNOWN_TOPICS = {
    'mopria-certification': 'Mopria certification is a vendor program; queue metadata cannot establish it.',
    'ipp-escl-capability': 'IPP and eSCL support are not reported by the Windows APIs this collector uses.',
    'windows-protected-print-mode': 'Windows protected print mode state is not queried by this tool; check Windows Settings on the target machine.',
    'print-success': 'No print job was submitted or monitored; this tool never reads print jobs.',
    'scan-success': 'No scan was performed or monitored.',
    'readiness': 'Queue, driver, and port metadata does not imply that printing or scanning will succeed.'
  };
  var UNKNOWN_STATES = ['unknown', 'not-tested'];

  // Canonical API labels per source and for the host (schema v1 fixes these).
  var SOURCE_API = {
    queues: 'Get-Printer (PrintManagement)',
    drivers: 'Get-PrinterDriver (PrintManagement)',
    ports: 'Get-PrinterPort (PrintManagement)'
  };
  var HOST_API = 'Get-CimInstance Win32_OperatingSystem';
  var QUERY_LABELS = [HOST_API, SOURCE_API.queues, SOURCE_API.drivers, SOURCE_API.ports];
  var PROVENANCE_SCRIPT = 'collector/Collect-PrintCheck.ps1';
  var PROVENANCE_MODES = ['production', 'sample', 'test'];

  var LIMITS = Object.freeze({
    MAX_IMPORT_BYTES: 2 * 1024 * 1024,
    MAX_ITEMS: 500,
    MAX_STRING: 300,
    MAX_WARNINGS: 50,
    MAX_DROPPED_FIELDS: 100
  });

  var SOURCE_IDS = ['queues', 'drivers', 'ports'];
  var QUEUE_FIELDS = ['name', 'driverName', 'portName', 'shared', 'status'];
  var DRIVER_FIELDS = ['name', 'environment', 'manufacturer', 'majorVersion', 'driverVersion'];
  var PORT_FIELDS = ['name', 'description', 'hostAddress', 'portNumber'];
  var KIND_FIELDS = { queues: QUEUE_FIELDS, drivers: DRIVER_FIELDS, ports: PORT_FIELDS };
  var SOURCE_KEYS = ['status', 'api', 'error', 'count', 'truncated', 'droppedItemCount', 'items'];
  var HOST_KEYS = ['status', 'api', 'error', 'hostName', 'powershellVersion', 'processorArchitecture', 'os'];
  var OS_KEYS = ['caption', 'version', 'build', 'architecture'];
  var TOOL_KEYS = ['name', 'version', 'mode'];
  var TOP_KEYS = ['schema', 'schemaVersion', 'tool', 'generatedAt', 'host', 'sources', 'unknowns', 'limits', 'provenance'];

  var LIMITATIONS = [
    'PrintCheck is a local evidence viewer, not a compatibility certificate.',
    'Queue, driver, and port metadata is a snapshot from one collection run and can go stale.',
    'No print or scan job was submitted or monitored; print and scan success are not tested.',
    'Windows protected print mode state is not queried by this tool.',
    'Mopria certification, IPP/eSCL capability, and device readiness are not tested.',
    'Provider error text, port descriptions, API labels, and unknown explanations are replaced with bounded built-in text in every report; imported prose is never exported.',
    'Other reported metadata (queue status, driver environment, manufacturer, versions, OS details) is exported as reported and can identify a machine \u2014 review a report before sharing.'
  ];

  // -------------------------------------------------------------------------
  // tiny helpers
  // -------------------------------------------------------------------------

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function utf8ByteLength(text) {
    if (typeof text !== 'string') return 0;
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  function htmlEscape(value) {
    var text = String(value === null || value === undefined ? '' : value);
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nonNegativeInteger(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    return Math.max(0, Math.floor(value));
  }

  function matchItem(item, term, fields) {
    if (!item || typeof term !== 'string') return false;
    var needle = term.toLowerCase();
    if (needle.length === 0) return true;
    for (var i = 0; i < fields.length; i++) {
      var value = item[fields[i]];
      if (value === null || value === undefined) continue;
      if (String(value).toLowerCase().indexOf(needle) !== -1) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // validation (allowlist model)
  // -------------------------------------------------------------------------

  function validateCollectorDoc(input) {
    var errors = [];
    var warnings = [];
    var droppedFields = [];
    var droppedFieldCount = 0;

    function fail(code, path, message) {
      errors.push({ code: code, path: path, message: message });
    }
    function warn(code, path, message) {
      if (warnings.length < LIMITS.MAX_WARNINGS) warnings.push({ code: code, path: path, message: message });
    }
    var dropCounts = Object.create(null);
    function drop(parentPath) {
      droppedFieldCount += 1;
      var ordinal = (dropCounts[parentPath] || 0) + 1;
      dropCounts[parentPath] = ordinal;
      if (droppedFields.length < LIMITS.MAX_DROPPED_FIELDS) {
        // Static ordinal path: the raw key name is never echoed anywhere.
        droppedFields.push(parentPath + '.<unknown-key>#' + ordinal);
      }
    }
    function result(doc) {
      var ok = errors.length === 0;
      return {
        ok: ok,
        errors: errors,
        warnings: warnings,
        droppedFields: droppedFields,
        droppedFieldCount: droppedFieldCount,
        doc: ok ? doc : null
      };
    }

    function boundedString(value, path) {
      if (typeof value !== 'string') return null;
      var text = value.trim();
      if (text.length === 0) return null;
      if (text.length > LIMITS.MAX_STRING) {
        warn('string-truncated', path || '$', 'String truncated to ' + LIMITS.MAX_STRING + ' characters.');
        return text.slice(0, LIMITS.MAX_STRING);
      }
      return text;
    }

    function boundedScalar(value, path) {
      if (typeof value === 'number' && isFinite(value)) return String(value);
      if (typeof value === 'string') return boundedString(value, path);
      return null;
    }

    function normalizeError(value) {
      if (!isPlainObject(value)) return null;
      var rawKind = typeof value.kind === 'string' ? value.kind.trim() : '';
      var hasMessage = typeof value.message === 'string' && value.message.trim().length > 0;
      if (rawKind.length === 0 && !hasMessage) return null;
      // Only the bounded canonical code survives; the imported message is
      // discarded and replaced with the fixed generic text for that code.
      var kind = has(ERROR_KINDS, rawKind) ? rawKind : 'error';
      return { kind: kind, message: ERROR_KINDS[kind] };
    }

    if (!isPlainObject(input)) {
      fail('import-not-object', '$', 'The collector document must be a JSON object.');
      return result(null);
    }

    if (input.schema !== COLLECTOR_SCHEMA) {
      fail('schema-unsupported', '$.schema', 'Expected schema "' + COLLECTOR_SCHEMA + '".');
      return result(null);
    }
    if (input.schemaVersion !== COLLECTOR_SCHEMA_VERSION) {
      fail('schema-version-unsupported', '$.schemaVersion',
        'Unsupported schemaVersion; this viewer understands version ' + COLLECTOR_SCHEMA_VERSION + '.');
      return result(null);
    }

    var tool = input.tool;
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0 ||
        typeof tool.version !== 'string' || tool.version.length === 0) {
      fail('tool-missing', '$.tool', 'A tool block with name and version is required.');
    } else if (ALLOWED_MODES.indexOf(tool.mode) === -1) {
      fail('tool-mode-invalid', '$.tool.mode', 'tool.mode must be one of: ' + ALLOWED_MODES.join(', ') + '.');
    } else {
      for (var toolKey in tool) {
        if (has(tool, toolKey) && TOOL_KEYS.indexOf(toolKey) === -1) drop('$.tool');
      }
    }

    if (typeof input.generatedAt !== 'string' || isNaN(Date.parse(input.generatedAt))) {
      fail('generated-at-invalid', '$.generatedAt', 'generatedAt must be an ISO-8601 timestamp string.');
    }

    var normHost = null;
    var host = input.host;
    if (!isPlainObject(host) || (host.status !== 'ok' && host.status !== 'failed')) {
      fail('host-invalid', '$.host', 'A host block with status "ok" or "failed" is required.');
    } else {
      normHost = {
        status: host.status,
        api: HOST_API,
        error: normalizeError(host.error),
        hostName: boundedString(host.hostName, '$.host.hostName'),
        powershellVersion: boundedString(host.powershellVersion, '$.host.powershellVersion'),
        processorArchitecture: boundedString(host.processorArchitecture, '$.host.processorArchitecture'),
        os: null
      };
      for (var hostKey in host) {
        if (has(host, hostKey) && HOST_KEYS.indexOf(hostKey) === -1) drop('$.host');
      }
      if (host.status === 'ok' && isPlainObject(host.os)) {
        normHost.os = {
          caption: boundedString(host.os.caption, '$.host.os.caption'),
          version: boundedString(host.os.version, '$.host.os.version'),
          build: boundedString(host.os.build, '$.host.os.build'),
          architecture: boundedString(host.os.architecture, '$.host.os.architecture')
        };
        for (var osKey in host.os) {
          if (has(host.os, osKey) && OS_KEYS.indexOf(osKey) === -1) drop('$.host.os');
        }
      }
    }

    function normalizeItem(kind, raw, path) {
      var name = boundedString(raw.name, path + '.name');
      if (!name) return null;
      if (kind === 'queues') {
        return {
          name: name,
          driverName: boundedString(raw.driverName, path + '.driverName'),
          portName: boundedString(raw.portName, path + '.portName'),
          shared: typeof raw.shared === 'boolean' ? raw.shared : null,
          status: boundedString(raw.status, path + '.status')
        };
      }
      if (kind === 'drivers') {
        return {
          name: name,
          environment: boundedString(raw.environment, path + '.environment'),
          manufacturer: boundedString(raw.manufacturer, path + '.manufacturer'),
          majorVersion: boundedScalar(raw.majorVersion, path + '.majorVersion'),
          driverVersion: boundedString(raw.driverVersion, path + '.driverVersion')
        };
      }
      return {
        name: name,
        // Port description is free text from the print subsystem and is never
        // carried into state, the DOM, or reports (the field stays null).
        description: null,
        hostAddress: boundedString(raw.hostAddress, path + '.hostAddress'),
        portNumber: boundedScalar(raw.portNumber, path + '.portNumber')
      };
    }

    function normalizeSource(kind, source) {
      var path = '$.sources.' + kind;
      var fields = KIND_FIELDS[kind];
      var rawItems = Array.isArray(source.items) ? source.items : [];
      var sourceCount = nonNegativeInteger(source.count);
      var out = {
        status: source.status,
        api: SOURCE_API[kind],
        error: normalizeError(source.error),
        count: sourceCount === null ? rawItems.length : sourceCount,
        truncated: source.truncated === true,
        droppedItemCount: 0,
        items: []
      };
      for (var i = 0; i < rawItems.length; i++) {
        if (out.items.length >= LIMITS.MAX_ITEMS) {
          out.truncated = true;
          warn('items-truncated', path + '.items', 'Only the first ' + LIMITS.MAX_ITEMS + ' items are kept.');
          break;
        }
        var raw = rawItems[i];
        var itemPath = path + '.items[' + i + ']';
        if (!isPlainObject(raw)) {
          out.droppedItemCount += 1;
          warn('item-dropped', itemPath, 'Item dropped: not an object.');
          continue;
        }
        for (var field in raw) {
          if (has(raw, field) && fields.indexOf(field) === -1) drop(itemPath);
        }
        var item = normalizeItem(kind, raw, itemPath);
        if (!item) {
          out.droppedItemCount += 1;
          warn('item-dropped', itemPath, 'Item dropped: missing or invalid name.');
          continue;
        }
        out.items.push(item);
      }
      for (var sourceKey in source) {
        if (has(source, sourceKey) && SOURCE_KEYS.indexOf(sourceKey) === -1) drop(path);
      }
      return out;
    }

    var normSources = {};
    if (!isPlainObject(input.sources)) {
      for (var s = 0; s < SOURCE_IDS.length; s++) {
        fail('source-missing', '$.sources.' + SOURCE_IDS[s], 'Required source "' + SOURCE_IDS[s] + '" is missing.');
      }
    } else {
      for (var k = 0; k < SOURCE_IDS.length; k++) {
        var id = SOURCE_IDS[k];
        var source = input.sources[id];
        if (!isPlainObject(source)) {
          fail('source-missing', '$.sources.' + id, 'Required source "' + id + '" is missing.');
          continue;
        }
        if (source.status !== 'ok' && source.status !== 'failed' && source.status !== 'unavailable') {
          fail('source-status-invalid', '$.sources.' + id + '.status',
            'Source status must be "ok", "failed", or "unavailable".');
          continue;
        }
        if (source.status === 'ok' && !Array.isArray(source.items)) {
          fail('items-not-array', '$.sources.' + id + '.items', 'An "ok" source must carry an items array.');
          continue;
        }
        normSources[id] = normalizeSource(id, source);
      }
      for (var sourceId in input.sources) {
        if (has(input.sources, sourceId) && SOURCE_IDS.indexOf(sourceId) === -1) drop('$.sources');
      }
    }

    var normUnknowns = [];
    if (!Array.isArray(input.unknowns)) {
      warn('unknowns-missing', '$.unknowns', 'No unknowns block; the viewer shows its static limitation list instead.');
    } else {
      for (var u = 0; u < input.unknowns.length; u++) {
        var entry = input.unknowns[u];
        var entryPath = '$.unknowns[' + u + ']';
        if (!isPlainObject(entry)) {
          warn('unknown-entry-dropped', entryPath, 'Unknown entry dropped: not an object.');
          continue;
        }
        var topic = boundedString(entry.topic, entryPath + '.topic');
        var state = boundedString(entry.state, entryPath + '.state');
        if (!topic || !has(UNKNOWN_TOPICS, topic) || !state || UNKNOWN_STATES.indexOf(state) === -1) {
          warn('unknown-entry-dropped', entryPath, 'Unknown entry dropped: unrecognized topic or state.');
          continue;
        }
        // The imported explanation is discarded; the viewer carries its own
        // bounded canonical text per known topic.
        normUnknowns.push({ topic: topic, state: state, reason: UNKNOWN_TOPICS[topic] });
      }
    }

    var normLimits = { maxItemsPerSource: LIMITS.MAX_ITEMS, maxStringLength: LIMITS.MAX_STRING };
    if (isPlainObject(input.limits)) {
      var limitItems = nonNegativeInteger(input.limits.maxItemsPerSource);
      if (limitItems !== null) normLimits.maxItemsPerSource = limitItems;
      var limitString = nonNegativeInteger(input.limits.maxStringLength);
      if (limitString !== null) normLimits.maxStringLength = limitString;
      for (var limitKey in input.limits) {
        if (has(input.limits, limitKey) && ['maxItemsPerSource', 'maxStringLength'].indexOf(limitKey) === -1) {
          drop('$.limits');
        }
      }
    }

    var normProvenance = { script: PROVENANCE_SCRIPT, mode: null, queriesExecuted: [] };
    if (isPlainObject(input.provenance)) {
      var provenanceMode = boundedString(input.provenance.mode, '$.provenance.mode');
      if (provenanceMode && PROVENANCE_MODES.indexOf(provenanceMode) !== -1) normProvenance.mode = provenanceMode;
      if (Array.isArray(input.provenance.queriesExecuted)) {
        for (var q = 0; q < input.provenance.queriesExecuted.length && q < 20; q++) {
          var query = boundedString(input.provenance.queriesExecuted[q], '$.provenance.queriesExecuted[' + q + ']');
          // Only the documented query labels are ever carried.
          if (query && QUERY_LABELS.indexOf(query) !== -1) normProvenance.queriesExecuted.push(query);
        }
      }
      for (var provenanceKey in input.provenance) {
        if (has(input.provenance, provenanceKey) && ['script', 'mode', 'queriesExecuted'].indexOf(provenanceKey) === -1) {
          drop('$.provenance');
        }
      }
    }

    for (var topKey in input) {
      if (has(input, topKey) && TOP_KEYS.indexOf(topKey) === -1) drop('$');
    }

    if (errors.length > 0) return result(null);

    var doc = {
      schema: COLLECTOR_SCHEMA,
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      tool: { name: tool.name, version: tool.version, mode: tool.mode },
      generatedAt: input.generatedAt,
      host: normHost,
      sources: normSources,
      unknowns: normUnknowns,
      limits: normLimits,
      provenance: normProvenance
    };
    return result(doc);
  }

  // -------------------------------------------------------------------------
  // import pipeline
  // -------------------------------------------------------------------------

  function parseImportText(text, fileName) {
    var sourceFile = typeof fileName === 'string' && fileName.length > 0 ? fileName : null;

    function fail(code, message) {
      return {
        ok: false, doc: null,
        errors: [{ code: code, path: '$', message: message }],
        warnings: [], droppedFields: [], droppedFieldCount: 0, sourceFile: sourceFile
      };
    }

    if (typeof text !== 'string') return fail('import-not-text', 'The import must be text.');
    var bytes = utf8ByteLength(text);
    if (bytes > LIMITS.MAX_IMPORT_BYTES) {
      return fail('import-too-large', 'Import is ' + bytes + ' bytes; the limit is ' + LIMITS.MAX_IMPORT_BYTES + ' bytes.');
    }
    if (text.trim().length === 0) return fail('import-empty', 'The import is empty.');

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // JSON.parse messages can echo a fragment of the imported text; the
      // diagnostic is a fixed bounded message instead.
      return fail('import-json-invalid', 'File is not valid JSON; nothing was imported.');
    }

    var check = validateCollectorDoc(parsed);
    return {
      ok: check.ok,
      doc: check.doc,
      errors: check.errors,
      warnings: check.warnings,
      droppedFields: check.droppedFields,
      droppedFieldCount: check.droppedFieldCount,
      sourceFile: sourceFile
    };
  }

  // -------------------------------------------------------------------------
  // redaction
  // -------------------------------------------------------------------------

  function redactDoc(doc, options) {
    var opts = options || {};
    var includeIdentifiers = !!opts.includeIdentifiers;
    var maps = {
      queues: Object.create(null),
      drivers: Object.create(null),
      ports: Object.create(null),
      networks: Object.create(null),
      host: Object.create(null)
    };
    var counters = { queues: 0, drivers: 0, ports: 0, networks: 0, host: 0 };
    var LABELS = { queues: 'Queue', drivers: 'Driver', ports: 'Port', networks: 'Network', host: 'Host' };

    function assign(kind, value) {
      if (typeof value !== 'string' || value.length === 0) return;
      if (!maps[kind][value]) {
        counters[kind] += 1;
        maps[kind][value] = LABELS[kind] + ' ' + counters[kind];
      }
    }

    doc.sources.queues.items.forEach(function (item) { assign('queues', item.name); });
    doc.sources.drivers.items.forEach(function (item) { assign('drivers', item.name); });
    doc.sources.queues.items.forEach(function (item) { assign('drivers', item.driverName); });
    doc.sources.ports.items.forEach(function (item) { assign('ports', item.name); });
    doc.sources.queues.items.forEach(function (item) { assign('ports', item.portName); });
    doc.sources.ports.items.forEach(function (item) { assign('networks', item.hostAddress); });
    assign('host', doc.host.hostName);

    function label(kind, value) {
      if (typeof value !== 'string' || value.length === 0) return null;
      if (includeIdentifiers) return value;
      return maps[kind][value] || null;
    }

    function redactError(error) {
      if (!error) return null;
      // Errors are already canonical at normalization time; this only copies.
      return { kind: error.kind, message: error.message };
    }

    function redactItem(kind, item) {
      if (kind === 'queues') {
        return {
          name: label('queues', item.name),
          driverName: label('drivers', item.driverName),
          portName: label('ports', item.portName),
          shared: item.shared,
          status: item.status
        };
      }
      if (kind === 'drivers') {
        return {
          name: label('drivers', item.name),
          environment: item.environment,
          manufacturer: item.manufacturer,
          majorVersion: item.majorVersion,
          driverVersion: item.driverVersion
        };
      }
      return {
        name: label('ports', item.name),
        description: item.description,
        hostAddress: label('networks', item.hostAddress),
        portNumber: item.portNumber
      };
    }

    function redactSource(kind) {
      var source = doc.sources[kind];
      return {
        status: source.status,
        api: source.api,
        error: redactError(source.error),
        count: source.count,
        truncated: source.truncated,
        droppedItemCount: source.droppedItemCount,
        items: source.items.map(function (item) { return redactItem(kind, item); })
      };
    }

    var redacted = {
      schema: doc.schema,
      schemaVersion: doc.schemaVersion,
      tool: { name: doc.tool.name, version: doc.tool.version, mode: doc.tool.mode },
      generatedAt: doc.generatedAt,
      host: {
        status: doc.host.status,
        api: doc.host.api,
        error: redactError(doc.host.error),
        hostName: label('host', doc.host.hostName),
        powershellVersion: doc.host.powershellVersion,
        processorArchitecture: doc.host.processorArchitecture,
        os: doc.host.os ? {
          caption: doc.host.os.caption,
          version: doc.host.os.version,
          build: doc.host.os.build,
          architecture: doc.host.os.architecture
        } : null
      },
      sources: {
        queues: redactSource('queues'),
        drivers: redactSource('drivers'),
        ports: redactSource('ports')
      },
      unknowns: doc.unknowns.map(function (entry) {
        return { topic: entry.topic, state: entry.state, reason: entry.reason };
      }),
      limits: doc.limits,
      provenance: doc.provenance
    };

    return { doc: redacted, maps: maps, applied: !includeIdentifiers };
  }

  // -------------------------------------------------------------------------
  // reports
  // -------------------------------------------------------------------------

  function buildJsonReport(doc, options) {
    var opts = options || {};
    var check = validateCollectorDoc(doc);
    if (!check.ok) {
      var error = new Error('buildJsonReport requires a collector document that passed validateCollectorDoc (invalid-doc).');
      error.code = 'invalid-doc';
      throw error;
    }
    var normalized = check.doc;
    var includeIdentifiers = !!opts.includeIdentifiers;
    var redacted = redactDoc(normalized, { includeIdentifiers: includeIdentifiers });
    var generatedAt = typeof opts.generatedAt === 'string' && !isNaN(Date.parse(opts.generatedAt))
      ? opts.generatedAt
      : new Date().toISOString();
    var sourceLabel;
    if (includeIdentifiers) {
      sourceLabel = typeof opts.sourceLabel === 'string' && opts.sourceLabel.length > 0 ? opts.sourceLabel : 'Unknown source';
    } else {
      sourceLabel = 'Source file 1';
    }
    var warnings = Array.isArray(opts.warnings) ? opts.warnings.slice(0, LIMITS.MAX_WARNINGS) : [];
    var droppedFieldCount = typeof opts.droppedFieldCount === 'number' ? opts.droppedFieldCount : 0;

    return {
      schema: REPORT_SCHEMA,
      schemaVersion: REPORT_SCHEMA_VERSION,
      meta: {
        tool: 'PrintCheck',
        toolVersion: VERSION,
        generatedAt: generatedAt,
        fiction: normalized.tool.mode === 'sample',
        sourceFile: sourceLabel,
        identifiersIncluded: includeIdentifiers,
        redaction: {
          applied: !includeIdentifiers,
          scheme: 'Ordinal labels per distinct value, first-appearance order.',
          proseHandling: 'Error text, port descriptions, API labels, and unknown explanations are replaced with bounded canonical text before export; identical in both export modes.'
        },
        droppedFieldCount: droppedFieldCount,
        warnings: warnings
      },
      host: redacted.doc.host,
      sources: redacted.doc.sources,
      unknowns: redacted.doc.unknowns,
      limitations: LIMITATIONS.slice()
    };
  }

  var REPORT_CSS = [
    ':root{color-scheme:light}',
    'body{font:14px/1.55 "Segoe UI",system-ui,sans-serif;background:#f2f6fb;color:#10233c;margin:0;padding:24px}',
    'main{max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #c9d8ea;border-radius:10px;padding:26px}',
    'h1{color:#0d3b66;margin:0 0 6px;font-size:24px}',
    'h2{color:#0d3b66;margin:26px 0 8px;font-size:17px}',
    'p{margin:6px 0}',
    'table{border-collapse:collapse;width:100%;margin:6px 0 16px}',
    'th,td{border:1px solid #c9d8ea;padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}',
    'th{background:#e8f0fa;color:#0d3b66}',
    '.badge{display:inline-block;border:1px solid #0d3b66;border-radius:999px;padding:2px 10px;margin:0 6px 6px 0;font-size:12px}',
    '.badge.fiction{background:#fff3cd;border-color:#b8860b}',
    '.meta{color:#5b6b80;font-size:12.5px}',
    'footer{margin-top:24px;padding-top:12px;border-top:1px dashed #c9d8ea;color:#5b6b80;font-size:12px}',
    '@media print{body{background:#fff;padding:0}main{border:0}}'
  ].join('\n');

  function buildHtmlReport(report) {
    var meta = report.meta;
    var parts = [];

    function table(headers, rows) {
      var out = '<table><thead><tr>';
      headers.forEach(function (header) { out += '<th>' + htmlEscape(header) + '</th>'; });
      out += '</tr></thead><tbody>';
      if (rows.length === 0) {
        out += '<tr><td colspan="' + headers.length + '">No records.</td></tr>';
      }
      rows.forEach(function (row) {
        out += '<tr>';
        row.forEach(function (cell) {
          out += '<td>' + htmlEscape(cell === null || cell === undefined ? '\u2014' : String(cell)) + '</td>';
        });
        out += '</tr>';
      });
      return out + '</tbody></table>';
    }

    parts.push('<!DOCTYPE html>');
    parts.push('<html lang="en">');
    parts.push('<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
    parts.push('<title>PrintCheck evidence report</title>');
    parts.push('<style>' + REPORT_CSS + '</style></head>');
    parts.push('<body><main>');
    parts.push('<h1>PrintCheck evidence report</h1>');
    parts.push('<p class="badges">' +
      '<span class="badge">' + (meta.identifiersIncluded ? 'Identifiers included (opt-in)' : 'Identifiers redacted') + '</span>' +
      (meta.fiction ? '<span class="badge fiction">Sample data \u2014 fictional</span>' : '') +
      '</p>');
    parts.push('<p class="meta">Generated ' + htmlEscape(meta.generatedAt) + ' by PrintCheck ' + htmlEscape(meta.toolVersion) +
      ' \u00b7 Source: ' + htmlEscape(meta.sourceFile) +
      ' \u00b7 Dropped unknown fields: ' + htmlEscape(String(meta.droppedFieldCount)) + '</p>');

    parts.push('<h2>What this report is</h2><ul>');
    report.limitations.forEach(function (line) { parts.push('<li>' + htmlEscape(line) + '</li>'); });
    parts.push('</ul>');

    parts.push('<h2>Host</h2>');
    parts.push(table(['Field', 'Value'], [
      ['Status', report.host.status],
      ['Machine', report.host.hostName],
      ['API', report.host.api],
      ['PowerShell', report.host.powershellVersion],
      ['Processor architecture', report.host.processorArchitecture],
      ['OS caption', report.host.os ? report.host.os.caption : null],
      ['OS version', report.host.os ? report.host.os.version : null],
      ['OS build', report.host.os ? report.host.os.build : null],
      ['OS architecture', report.host.os ? report.host.os.architecture : null]
    ]));

    parts.push('<h2>Sources</h2>');
    parts.push(table(['Source', 'Status', 'API', 'Count', 'Truncated', 'Error'], SOURCE_IDS.map(function (id) {
      var source = report.sources[id];
      return [id, source.status, source.api, source.count, source.truncated ? 'yes' : 'no',
        source.error ? (source.error.kind + ': ' + source.error.message) : null];
    })));

    parts.push('<h2>Queues</h2>');
    parts.push(table(['Queue', 'Driver', 'Port', 'Shared', 'Reported status'], report.sources.queues.items.map(function (item) {
      return [item.name, item.driverName, item.portName,
        item.shared === null ? null : String(item.shared), item.status];
    })));

    parts.push('<h2>Drivers</h2>');
    parts.push(table(['Driver', 'Environment', 'Manufacturer', 'Major version', 'Driver version'], report.sources.drivers.items.map(function (item) {
      return [item.name, item.environment, item.manufacturer, item.majorVersion, item.driverVersion];
    })));

    parts.push('<h2>Ports</h2>');
    parts.push(table(['Port', 'Description', 'Host address', 'Port number'], report.sources.ports.items.map(function (item) {
      return [item.name, item.description, item.hostAddress, item.portNumber];
    })));

    parts.push('<h2>Unknowns \u2014 not tested by this tool</h2>');
    parts.push(table(['Topic', 'State', 'Reason'], report.unknowns.map(function (entry) {
      return [entry.topic, entry.state, entry.reason];
    })));

    parts.push('<footer>This report is an evidence summary, not a compatibility certificate. ' +
      'It was generated locally from an imported collector document; nothing was transmitted.</footer>');
    parts.push('</main></body></html>');
    return parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // filtering
  // -------------------------------------------------------------------------

  function filterDataset(doc, options) {
    var opts = options || {};
    var term = typeof opts.term === 'string' ? opts.term.trim() : '';
    var status = typeof opts.status === 'string' ? opts.status : 'all';
    var result = { visibleSources: [], queues: [], drivers: [], ports: [] };
    SOURCE_IDS.forEach(function (id) {
      var source = doc.sources[id];
      if (status !== 'all' && source.status !== status) return;
      result.visibleSources.push(id);
      result[id] = source.items.filter(function (item) {
        return term === '' ? true : matchItem(item, term, KIND_FIELDS[id]);
      });
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // built-in fictional samples
  // -------------------------------------------------------------------------

  function sampleUnknowns() {
    // Derived from the canonical topic map so the sample text cannot drift
    // from the explanations the viewer carries into reports.
    return Object.keys(UNKNOWN_TOPICS).map(function (topic) {
      return {
        topic: topic,
        state: topic === 'windows-protected-print-mode' ? 'unknown' : 'not-tested',
        reason: UNKNOWN_TOPICS[topic]
      };
    });
  }

  function sampleHost() {
    return {
      status: 'ok',
      api: 'Get-CimInstance Win32_OperatingSystem (fictional sample)',
      error: null,
      hostName: 'FICTION-SAMPLE-HOST',
      powershellVersion: '7.x (fictional sample)',
      processorArchitecture: 'ARM64 (fictional sample)',
      os: {
        caption: 'Fictional Sample Operating System',
        version: '10.0.99999',
        build: '99999',
        architecture: 'ARM64 (fictional sample)'
      }
    };
  }

  function sampleSource(kind, items, status, error) {
    return {
      status: status || 'ok',
      api: (kind === 'queues' ? 'Get-Printer' : kind === 'drivers' ? 'Get-PrinterDriver' : 'Get-PrinterPort') +
        ' (PrintManagement, fictional sample)',
      error: error || null,
      count: items.length,
      truncated: false,
      droppedItemCount: 0,
      items: items
    };
  }

  function sampleDocBody(queues, drivers, ports, driverError, portsStatus) {
    return {
      schema: COLLECTOR_SCHEMA,
      schemaVersion: COLLECTOR_SCHEMA_VERSION,
      tool: { name: 'PrintCheck Collector', version: VERSION, mode: 'sample' },
      generatedAt: '2026-10-11T09:30:00Z',
      host: sampleHost(),
      sources: {
        queues: sampleSource('queues', queues, 'ok', null),
        drivers: sampleSource('drivers', drivers, driverError ? 'failed' : 'ok', driverError),
        ports: sampleSource('ports', ports, portsStatus || 'ok', portsStatus === 'unavailable' ? { kind: 'provider-unavailable', message: 'Fictional sample: port data is unavailable.' } : null)
      },
      unknowns: sampleUnknowns(),
      limits: { maxItemsPerSource: LIMITS.MAX_ITEMS, maxStringLength: LIMITS.MAX_STRING },
      provenance: { script: 'collector/Collect-PrintCheck.ps1', mode: 'sample', queriesExecuted: [] }
    };
  }

  var SAMPLE_NAMES = ['fictional-basic', 'fictional-empty', 'fictional-partial'];

  var SAMPLE_DOCS = {
    'fictional-basic': sampleDocBody(
      [
        { name: 'FICTION-Queue-Alpha', driverName: 'Fictional Universal Print Driver v4', portName: 'FICTION-Port-01', shared: false, status: 'Idle' },
        { name: 'FICTION-Queue-Beta', driverName: 'Fictional Universal Print Driver v4', portName: 'FICTION-Port-01', shared: true, status: 'Idle' },
        { name: 'FICTION-Queue-Gamma (Fax)', driverName: 'Fictional Fax Driver', portName: 'FICTION-Port-Fax', shared: false, status: 'Idle' }
      ],
      [
        { name: 'Fictional Universal Print Driver v4', environment: 'Windows ARM64', manufacturer: 'Fiction Works', majorVersion: '4', driverVersion: '1.0.0' },
        { name: 'Fictional Fax Driver', environment: 'Windows ARM64', manufacturer: 'Fiction Works', majorVersion: '3', driverVersion: '3.1.2' }
      ],
      [
        { name: 'FICTION-Port-01', description: 'Fictional TCP/IP port', hostAddress: '192.0.2.10', portNumber: '9100' },
        { name: 'FICTION-Port-Fax', description: 'Fictional fax port', hostAddress: null, portNumber: null }
      ],
      null, 'ok'
    ),
    'fictional-empty': sampleDocBody(
      [],
      [
        { name: 'Fictional Universal Print Driver v4', environment: 'Windows ARM64', manufacturer: 'Fiction Works', majorVersion: '4', driverVersion: '1.0.0' }
      ],
      [
        { name: 'FICTION-Port-01', description: 'Fictional TCP/IP port', hostAddress: '192.0.2.10', portNumber: '9100' }
      ],
      null, 'ok'
    ),
    'fictional-partial': sampleDocBody(
      [
        { name: 'FICTION-Queue-Alpha', driverName: 'Fictional Universal Print Driver v4', portName: 'FICTION-Port-01', shared: false, status: 'Idle' },
        { name: 'FICTION-Queue-Beta', driverName: 'Fictional Universal Print Driver v4', portName: 'FICTION-Port-01', shared: true, status: 'Idle' },
        { name: 'FICTION-Queue-Gamma (Fax)', driverName: 'Fictional Fax Driver', portName: 'FICTION-Port-Fax', shared: false, status: 'Idle' },
        { name: 'FICTION-Queue-Delta', driverName: 'Fictional Label Driver', portName: 'FICTION-Port-02', shared: false, status: 'Paused' }
      ],
      [],
      [],
      { kind: 'provider-error', message: 'Fictional sample: the driver list could not be read for FICTION-Queue-Alpha (FICTION-Port-01).' },
      'unavailable'
    )
  };

  function getSampleDoc(name) {
    if (!has(SAMPLE_DOCS, name)) return null;
    return cloneJson(SAMPLE_DOCS[name]);
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  return {
    VERSION: VERSION,
    LIMITS: LIMITS,
    SCHEMA: COLLECTOR_SCHEMA,
    SCHEMA_VERSION: COLLECTOR_SCHEMA_VERSION,
    REPORT_SCHEMA: REPORT_SCHEMA,
    REPORT_SCHEMA_VERSION: REPORT_SCHEMA_VERSION,
    LIMITATIONS: LIMITATIONS.slice(),
    SAMPLE_NAMES: SAMPLE_NAMES.slice(),
    validateCollectorDoc: validateCollectorDoc,
    parseImportText: parseImportText,
    redactDoc: redactDoc,
    buildJsonReport: buildJsonReport,
    buildHtmlReport: buildHtmlReport,
    filterDataset: filterDataset,
    matchItem: matchItem,
    getSampleDoc: getSampleDoc,
    htmlEscape: htmlEscape,
    utf8ByteLength: utf8ByteLength
  };
});
