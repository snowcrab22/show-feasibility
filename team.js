/* Show Feasibility: the KC PLUR team list (saved scenarios and "Open in Google Sheets").
 * Works in the browser (window.ShowTeam) and in Node (for tests).
 *
 * The list lives in a Google Apps Script web app that runs as Quentin and keeps every save in the
 * "Show Feasibility – Saved Scenarios" spreadsheet (see apps-script/Code.gs). Nobody signs in to
 * Google: every request carries the team passcode, which each browser keeps in localStorage after
 * the first successful unlock. The passcode is never written in this file.
 *
 * Requests are POSTs with a text/plain JSON body (no CORS preflight); every reply is JSON
 * { ok: true, ... } or { ok: false, error, message }.
 */
(function (root, factory) {
  var X = root && root.ShowExport;
  if (!X && typeof require === "function") X = require("./export.js");
  var api = factory(X);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowTeam = api;
})(this, function (X) {
  "use strict";

  var SCRIPT_URL = ""; // the web app's /exec URL; the team features stay hidden until it is set
  var TEAM = ["Quentin", "Jasmine", "Chad", "CJ"];
  var AUTH_KEY = "kcplur-show-feasibility-team";
  var APP = "show-feasibility";

  function configured(url) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(url === undefined ? api.SCRIPT_URL : url || ""));
  }

  // ---------------------------------------------------------------- passcode and name
  var memory = null; // used when localStorage is unavailable
  function storage() { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; } }
  function getAuth() {
    var s = storage(), raw = null;
    if (s) { try { raw = s.getItem(AUTH_KEY); } catch (e) { raw = null; } }
    var a = null;
    if (raw) { try { a = JSON.parse(raw); } catch (e) { a = null; } }
    if (!a && memory) a = memory;
    if (!a || typeof a !== "object") return null;
    return { passcode: String(a.passcode || ""), who: String(a.who || "") };
  }
  function setAuth(passcode, who) {
    var a = { passcode: String(passcode || ""), who: String(who || "") };
    memory = a;
    var s = storage();
    if (s) { try { s.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) { /* memory only */ } }
  }
  function clearPasscode() {
    var a = getAuth();
    setAuth("", a ? a.who : "");
  }

  // ---------------------------------------------------------------- requests
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  // body: extra fields (null and undefined are left out). opts: { url, passcode, fetch }.
  function call(action, body, opts) {
    opts = opts || {};
    var a = getAuth();
    var msg = { action: action, passcode: opts.passcode != null ? String(opts.passcode) : a ? a.passcode : "" };
    Object.keys(body || {}).forEach(function (k) { if (body[k] != null) msg[k] = body[k]; });
    var url = opts.url || api.SCRIPT_URL;
    var f = opts.fetch || (typeof fetch === "function" ? fetch : null);
    return Promise.resolve().then(function () {
      if (!f || !url) throw err("network", "The team list isn't set up.");
      return f(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(msg), redirect: "follow" });
    }).then(function (res) {
      if (!res || !res.ok) throw err("network", "The team list answered " + (res && res.status));
      return res.text();
    }).then(function (text) {
      var reply = null;
      try { reply = JSON.parse(text); } catch (e) { reply = null; }
      if (!reply || typeof reply !== "object") throw err("network", "The team list didn't answer with JSON.");
      if (reply.ok) return reply;
      if (reply.error === "passcode") clearPasscode();
      throw err(reply.error || "server", reply.message || "");
    }).catch(function (e) {
      if (e && e.code) throw e;
      throw err("network", e && e.message);
    });
  }
  function check(passcode, opts) { return call("check", {}, Object.assign({}, opts, { passcode: passcode })); }
  function list(opts) { return call("list", {}, opts); }
  function load(id, version, opts) { return call("load", { id: id, version: version }, opts); }
  function history(id, opts) { return call("history", { id: id }, opts); }
  // args: { id, baseVersion, name, payload, summary }. id empty = a new scenario.
  function save(args, opts) {
    var a = getAuth();
    return call("save", { id: args.id || null, baseVersion: args.baseVersion, name: args.name, savedBy: a ? a.who : "",
      data: JSON.stringify(args.payload), summary: args.summary }, opts);
  }
  function makeSheet(fileName, xlsxBase64, deco, opts) {
    return call("sheet", { fileName: fileName, xlsx: xlsxBase64, deco: deco }, opts);
  }
  function errorText(e) {
    var code = e && e.code, m = e && e.message ? e.message : "";
    if (code === "passcode") return "That passcode didn't work.";
    if (code === "locked") return "Too many wrong passcodes. Try again in 10 minutes.";
    if (code === "notfound") return "That saved scenario wasn't found. It may have been deleted from the Saved Scenarios sheet.";
    if (code === "bad") return "The team list didn't accept that: " + m;
    if (code === "server") return "The team list had a problem: " + m;
    return "Couldn't reach the team list. Check your connection and try again.";
  }

  // ---------------------------------------------------------------- scenario data
  function buildPayload(inputs, n, name, M, savedAt) {
    return { v: 2, app: APP, name: String(name || "").trim() || "Untitled scenario", inputs: M.sanitize(inputs), n: Math.max(0, Math.round(+n) || 0),
      savedAt: savedAt || new Date().toISOString() };
  }
  function parsePayload(obj, M) {
    if (!obj || typeof obj !== "object" || obj.app !== APP || !obj.inputs || typeof obj.inputs !== "object") return null;
    return { name: String(obj.name || "Untitled scenario"), inputs: M.sanitize(obj.inputs), n: Math.max(0, Math.round(+obj.n) || 0) };
  }
  // Headline values for the Saved Scenarios sheet's readable columns.
  function summary(inputs, r) {
    return { show: String(inputs.showName || ""), venue: String(inputs.venueName || ""), price: inputs.price, capacity: inputs.capacity,
      tickets: r.n, net: Math.round(r.net * 100) / 100 };
  }
  function fileLink(id) { return X.PAGE_URL + "#f=" + id; }
  function toBase64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (typeof btoa !== "function") return Buffer.from(bytes).toString("base64");
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  var api = {
    SCRIPT_URL: SCRIPT_URL, TEAM: TEAM, configured: configured,
    getAuth: getAuth, setAuth: setAuth, clearPasscode: clearPasscode,
    call: call, check: check, list: list, load: load, history: history, save: save, makeSheet: makeSheet, errorText: errorText,
    buildPayload: buildPayload, parsePayload: parsePayload, summary: summary, fileLink: fileLink, toBase64: toBase64
  };
  return api;
});
