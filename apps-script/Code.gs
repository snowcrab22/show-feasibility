/* Show Feasibility team list: a Google Apps Script web app bound to the "Show Feasibility – Saved
 * Scenarios" spreadsheet. It runs as the owner, so nobody else signs in to Google; every request
 * carries the team passcode (Script Property PASSCODE).
 *
 * Paste this whole file into Extensions → Apps Script (Code.gs) and appsscript.json next to it.
 * Deploy → Web app: Execute as Me, Who has access: Anyone.
 *
 * The logic is plain functions so the page's Node tests can load this file; nothing runs at the top
 * level except constants and function declarations.
 */

// ------------------------------------------------------------------ the Scenarios tab
var SHEET_NAME = "Scenarios";
var HEADERS = [
  ["ID", "id"], ["Version", "version"], ["Name", "name"], ["Saved by", "savedBy"], ["Saved at", "savedAt"],
  ["Show", "show"], ["Venue", "venue"], ["Ticket price", "price"], ["Capacity", "capacity"], ["Tickets", "tickets"],
  ["Net at tickets", "net"], ["Data", "data"]
];
var APP = "show-feasibility";
var MAX_DATA = 45000, MAX_NAME = 120, MAX_WHO = 60;
var LOCK_TRIES = 10, LOCK_SECONDS = 600;
var ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function keyForHeader(h) {
  h = String(h == null ? "" : h).trim();
  for (var i = 0; i < HEADERS.length; i++) if (HEADERS[i][0] === h) return HEADERS[i][1];
  return null;
}
function isDate(v) { return Object.prototype.toString.call(v) === "[object Date]"; }

// values: the tab's getValues() (row 0 = headers). Columns are found by header text, so hand edits
// (moved or extra columns, blank rows, versions typed as text) don't break anything.
function recordsFromValues(values) {
  if (!values || !values.length) return [];
  var keys = values[0].map(keyForHeader);
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], rec = {};
    HEADERS.forEach(function (h) { rec[h[1]] = ""; });
    keys.forEach(function (k, c) { if (k) rec[k] = row[c]; });
    rec.id = String(rec.id == null ? "" : rec.id).trim();
    if (!rec.id) continue;
    rec.version = Number(rec.version) || 0;
    rec.savedAt = isDate(rec.savedAt) ? rec.savedAt.toISOString() : String(rec.savedAt == null ? "" : rec.savedAt);
    rec.name = String(rec.name == null ? "" : rec.name);
    rec.savedBy = String(rec.savedBy == null ? "" : rec.savedBy);
    rec.data = String(rec.data == null ? "" : rec.data);
    out.push(rec);
  }
  return out;
}
function rowFromRecord(rec, headerRow) {
  return headerRow.map(function (h) {
    var k = keyForHeader(h);
    return k && rec[k] != null ? rec[k] : "";
  });
}
function missingHeaders(headerRow) {
  var have = {};
  (headerRow || []).forEach(function (h) { have[String(h == null ? "" : h).trim()] = true; });
  return HEADERS.map(function (h) { return h[0]; }).filter(function (h) { return !have[h]; });
}

// ------------------------------------------------------------------ list, history, versions
function versionsOf(records, id) { return records.filter(function (r) { return r.id === id; }); }
function latestOf(list) {
  var best = null;
  list.forEach(function (r) { if (!best || r.version > best.version) best = r; });
  return best;
}
function listItems(records) {
  var byId = {}, order = [];
  records.forEach(function (r) {
    if (!byId[r.id]) { byId[r.id] = []; order.push(r.id); }
    byId[r.id].push(r);
  });
  return order.map(function (id) {
    var l = latestOf(byId[id]);
    return { id: id, name: l.name, savedBy: l.savedBy, savedAt: l.savedAt, version: l.version, versions: byId[id].length,
      show: l.show, venue: l.venue };
  }).sort(function (a, b) { return a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0; });
}
function historyOf(records, id) {
  return versionsOf(records, id).sort(function (a, b) { return b.version - a.version; })
    .map(function (r) { return { version: r.version, savedBy: r.savedBy, savedAt: r.savedAt }; });
}
function findVersion(records, id, version) {
  var list = versionsOf(records, id);
  if (version == null || version === "") return latestOf(list);
  var v = Number(version);
  for (var i = 0; i < list.length; i++) if (list[i].version === v) return list[i];
  return null;
}

// ------------------------------------------------------------------ saving
function cap(s, n) { return String(s == null ? "" : s).trim().slice(0, n); }
function numOrBlank(v) { var x = Number(v); return v === "" || v == null || !isFinite(x) ? "" : x; }
function validateSave(req) {
  function bad(msg) { return { ok: false, error: "bad", message: msg }; }
  var data = req && req.data;
  if (typeof data !== "string" || !data) return bad("No scenario data was sent.");
  if (data.length > MAX_DATA) return bad("The scenario is too big to save (" + data.length + " characters).");
  var parsed;
  try { parsed = JSON.parse(data); } catch (e) { return bad("The scenario data isn't valid JSON."); }
  if (!parsed || parsed.app !== APP || !parsed.inputs || typeof parsed.inputs !== "object") return bad("That isn't a Show Feasibility scenario.");
  var savedBy = cap(req.savedBy, MAX_WHO);
  if (!savedBy) return bad("Pick who is saving.");
  var s = req.summary || {};
  return { ok: true, clean: {
    id: req.id ? cap(req.id, 40) : null,
    baseVersion: req.baseVersion == null || req.baseVersion === "" ? null : Number(req.baseVersion) || 0,
    name: cap(req.name, MAX_NAME) || "Untitled scenario",
    savedBy: savedBy,
    data: data,
    summary: { show: cap(s.show, MAX_NAME), venue: cap(s.venue, MAX_NAME), price: numOrBlank(s.price), capacity: numOrBlank(s.capacity),
      tickets: numOrBlank(s.tickets), net: numOrBlank(s.net) }
  } };
}
// The record to append. overtook = who saved the latest version when it is newer than baseVersion
// (someone saved in between); nothing is lost either way, every save is its own row.
function planSave(records, clean, newIdValue, nowIso) {
  var id = clean.id, version = 1, overtook = null;
  if (id) {
    var latest = latestOf(versionsOf(records, id));
    if (!latest) return { error: "notfound" };
    version = latest.version + 1;
    if (clean.baseVersion != null && clean.baseVersion < latest.version) overtook = { savedBy: latest.savedBy, savedAt: latest.savedAt };
  } else id = newIdValue;
  var s = clean.summary || {};
  return { record: { id: id, version: version, name: clean.name, savedBy: clean.savedBy, savedAt: nowIso,
    show: s.show == null ? "" : s.show, venue: s.venue == null ? "" : s.venue, price: s.price == null ? "" : s.price,
    capacity: s.capacity == null ? "" : s.capacity, tickets: s.tickets == null ? "" : s.tickets, net: s.net == null ? "" : s.net,
    data: clean.data }, overtook: overtook };
}
function newId(rand) {
  var s = "";
  for (var i = 0; i < 10; i++) s += ID_CHARS.charAt(Math.min(ID_CHARS.length - 1, Math.floor(rand() * ID_CHARS.length)));
  return s;
}

// ------------------------------------------------------------------ passcode
// cache: { get(key) -> string|null, put(key, value, seconds) }. After LOCK_TRIES wrong passcodes in
// LOCK_SECONDS, everything is refused until the window passes.
function checkPasscode(given, expected, cache) {
  if (expected == null || String(expected) === "") return "unset";
  var tries = Number(cache.get("badTries")) || 0;
  if (tries >= LOCK_TRIES) return "locked";
  if (given != null && String(given) !== "" && String(given) === String(expected)) return null;
  cache.put("badTries", String(tries + 1), LOCK_SECONDS);
  return "passcode";
}

// ------------------------------------------------------------------ Google Sheets lock and chart
// Sheets API requests that finish an uploaded workbook: a warning-only lock on every tab except
// the yellow input cells, and a profit and headliner pay vs tickets chart on its own tab.
// deco comes from ShowWorkbook.decorations(sheets); sheetIds maps tab title -> sheetId.
function sheetsRequests(deco, sheetIds) {
  var reqs = [];
  deco.sheets.forEach(function (title) {
    if (sheetIds[title] == null) return;
    var id = sheetIds[title];
    var open = deco.inputs.filter(function (r) { return r.sheet === title; }).map(function (r) {
      return { sheetId: id, startRowIndex: r.r1, endRowIndex: r.r2, startColumnIndex: r.c1, endColumnIndex: r.c2 };
    });
    var pr = { range: { sheetId: id }, warningOnly: true, description: "Formulas. Change the yellow cells on Inputs; everything else recalculates." };
    if (open.length) pr.unprotectedRanges = open;
    reqs.push({ addProtectedRange: { protectedRange: pr } });
  });
  var c = deco.chart;
  if (c && sheetIds[c.sheet] != null) {
    var src = function (col) {
      return { sourceRange: { sources: [{ sheetId: sheetIds[c.sheet], startRowIndex: c.headerRow, endRowIndex: c.lastRow, startColumnIndex: col, endColumnIndex: col + 1 }] } };
    };
    var series = [{ series: src(c.netCol), targetAxis: "LEFT_AXIS", color: { red: 0.165, green: 0.471, blue: 0.839 } }];
    if (c.payCol != null) series.push({ series: src(c.payCol), targetAxis: "LEFT_AXIS", color: { red: 0.922, green: 0.408, blue: 0.204 } });
    reqs.push({ addChart: { chart: {
      spec: {
        title: c.payCol != null ? "Profit and headliner pay by tickets sold" : "Profit by tickets sold",
        basicChart: {
          chartType: "LINE", legendPosition: c.payCol != null ? "BOTTOM_LEGEND" : "NO_LEGEND", headerCount: 1,
          axis: [{ position: "BOTTOM_AXIS", title: "Tickets sold" }, { position: "LEFT_AXIS", title: "Dollars" }],
          domains: [{ domain: src(c.nCol) }],
          series: series
        }
      },
      position: { newSheet: true }
    } } });
  }
  return reqs;
}

// ------------------------------------------------------------------ requests
// req: { action, passcode, ... }. env: what the real script (realEnv) or a test supplies:
// { passcode, cache, readRecords(), appendRecord(rec), withLock(fn), newId(), now(), makeSheet(fileName, b64, deco) }.
// Never throws: every reply is { ok: true, ... } or { ok: false, error, message }.
function fail(error, message) { return { ok: false, error: error, message: message }; }
var NOT_FOUND = "That saved scenario isn't in the team list.";
function handle(req, env) {
  try {
    if (!req || typeof req !== "object") return fail("bad", "The request wasn't understood.");
    var pc = checkPasscode(req.passcode, env.passcode, env.cache);
    if (pc === "unset") return fail("server", "PASSCODE isn't set in Script Properties.");
    if (pc === "locked") return fail("locked", "Too many wrong passcodes. Try again in 10 minutes.");
    if (pc === "passcode") return fail("passcode", "That passcode didn't work.");
    var records, rec;
    switch (req.action) {
      case "check":
        return { ok: true };
      case "list":
        return { ok: true, items: listItems(env.readRecords()) };
      case "history":
        var versions = historyOf(env.readRecords(), String(req.id || ""));
        return versions.length ? { ok: true, versions: versions } : fail("notfound", NOT_FOUND);
      case "load":
        records = env.readRecords();
        rec = findVersion(records, String(req.id || ""), req.version);
        if (!rec) return fail("notfound", NOT_FOUND);
        return { ok: true, id: rec.id, version: rec.version, latestVersion: findVersion(records, rec.id).version,
          name: rec.name, savedBy: rec.savedBy, savedAt: rec.savedAt, data: rec.data };
      case "save":
        var v = validateSave(req);
        if (!v.ok) return v;
        return env.withLock(function () {
          var all = env.readRecords(), id = env.newId();
          for (var i = 0; i < 5 && findVersion(all, id); i++) id = env.newId();
          var plan = planSave(all, v.clean, id, env.now());
          if (plan.error) return fail("notfound", NOT_FOUND);
          env.appendRecord(plan.record);
          return { ok: true, id: plan.record.id, version: plan.record.version, overtook: plan.overtook };
        });
      case "sheet":
        if (typeof req.xlsx !== "string" || !req.xlsx) return fail("bad", "No spreadsheet was sent.");
        var made = env.makeSheet(String(req.fileName || "Show feasibility"), req.xlsx, req.deco || null);
        return { ok: true, id: made.id, url: made.url, decorated: !!made.decorated };
      default:
        return fail("bad", "Unknown action.");
    }
  } catch (e) {
    return fail("server", e && e.message ? e.message : String(e));
  }
}

// ------------------------------------------------------------------ Apps Script only
// (Not run by the Node tests: these use SpreadsheetApp, DriveApp, Drive, Sheets and friends.)
var XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Columns written as plain text, so Sheets never turns an ID, a name or the timestamp into a number or date.
var TEXT_KEYS = { id: true, name: true, savedBy: true, savedAt: true, show: true, venue: true, data: true };

function doGet() {
  return ContentService.createTextOutput("Show Feasibility team list is running.");
}
function doPost(e) {
  var reply;
  try {
    var req = null;
    try { req = JSON.parse(e && e.postData ? e.postData.contents : ""); } catch (err) { req = null; }
    reply = req ? handle(req, realEnv()) : fail("bad", "The request wasn't JSON.");
  } catch (err2) {
    reply = fail("server", err2 && err2.message ? err2.message : String(err2));
  }
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}
function realEnv() {
  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  return {
    passcode: props.getProperty("PASSCODE") || "",
    cache: { get: function (k) { return cache.get(k); }, put: function (k, v, s) { cache.put(k, String(v), s); } },
    readRecords: function () { return recordsFromValues(scenariosSheet().getDataRange().getValues()); },
    appendRecord: function (rec) {
      var sh = scenariosSheet();
      var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var row = sh.getLastRow() + 1;
      header.forEach(function (h, c) { if (TEXT_KEYS[keyForHeader(h)]) sh.getRange(row, c + 1).setNumberFormat("@"); });
      sh.getRange(row, 1, 1, header.length).setValues([rowFromRecord(rec, header)]);
    },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      // Flush before letting go, so the next save waiting on the lock reads this one's row.
      try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
    },
    newId: function () { return newId(Math.random); },
    now: function () { return new Date().toISOString(); },
    makeSheet: makeSheetReal
  };
}
function activeSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("This script has to be opened from the Saved Scenarios spreadsheet (Extensions → Apps Script).");
  return ss;
}
// The Scenarios tab, created (or given its missing headers) when needed.
function scenariosSheet() {
  var ss = activeSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    var tabs = ss.getSheets();
    sh = tabs.length === 1 && tabs[0].getLastRow() === 0 ? tabs[0].setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS.map(function (h) { return h[0]; })]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  var header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var miss = missingHeaders(header);
  if (miss.length) sh.getRange(1, header.length + 1, 1, miss.length).setValues([miss]).setFontWeight("bold");
  return sh;
}
// "Google Sheets" folder next to the spreadsheet; its ID is kept in Script Property EXPORT_FOLDER_ID.
function exportFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("EXPORT_FOLDER_ID");
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* deleted: make a new one */ }
  }
  var parents = DriveApp.getFileById(activeSpreadsheet().getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var folder = parent.createFolder("Google Sheets");
  props.setProperty("EXPORT_FOLDER_ID", folder.getId());
  return folder;
}
// Upload the page's .xlsx as a Google Sheet, add the lock and chart, share it anyone-with-link can edit.
function makeSheetReal(fileName, b64, deco) {
  var name = String(fileName || "Show feasibility").replace(/\.xlsx$/i, "");
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), XLSX_MIME, name + ".xlsx");
  var file = Drive.Files.create({ name: name, mimeType: "application/vnd.google-apps.spreadsheet", parents: [exportFolder().getId()] },
    blob, { fields: "id" });
  var id = file.id, decorated = true;
  try {
    var got = Sheets.Spreadsheets.get(id, { fields: "sheets.properties(sheetId,title)" });
    var ids = {};
    (got.sheets || []).forEach(function (s) { ids[s.properties.title] = s.properties.sheetId; });
    var reqs = deco ? sheetsRequests(deco, ids) : [];
    if (reqs.length) Sheets.Spreadsheets.batchUpdate({ requests: reqs }, id);
  } catch (e) {
    decorated = false;
    console.warn("Lock and chart couldn't be added: " + e);
  }
  DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  return { id: id, url: "https://docs.google.com/spreadsheets/d/" + id + "/edit", decorated: decorated };
}

// Node (the page's tests) only; Apps Script has no `module`.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    HEADERS: HEADERS, recordsFromValues: recordsFromValues, rowFromRecord: rowFromRecord, missingHeaders: missingHeaders,
    listItems: listItems, historyOf: historyOf, findVersion: findVersion, validateSave: validateSave, planSave: planSave,
    checkPasscode: checkPasscode, newId: newId, sheetsRequests: sheetsRequests, handle: handle
  };
}
