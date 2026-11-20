/* Show Feasibility: Google sign-in, "Open in Google Sheets" and saved scenarios in Google Drive.
 * Works in the browser (window.ShowGoogle) and in Node (pure helpers only, for tests).
 *
 * - Sign-in: Google Identity Services token client, scope drive.file (the page can only see files
 *   it created). The token lives in memory only.
 * - Sheets: the same .xlsx as the download, uploaded to Drive with conversion to a Google Sheet.
 * - Saved scenarios: a small JSON file in the saver's Drive, shared "anyone with the link can view",
 *   opened by anyone with PAGE_URL#f=<fileId> through the public API key (no sign-in). Drive sharing
 *   is the access control: only people who can edit the file in Drive can save over it.
 *
 * The client ID, API key and project number are public identifiers (they ship in every Google web
 * app). Never put a client secret here. While clientId or apiKey is empty the page hides the Google
 * buttons.
 */
(function (root, factory) {
  var X = root && root.ShowExport;
  if (!X && typeof require === "function") X = require("./export.js");
  var api = factory(X);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowGoogle = api;
})(this, function (X) {
  "use strict";

  var GOOGLE = {
    clientId: "",      // ends in .apps.googleusercontent.com
    apiKey: "",        // starts with AIza; restricted to this site and the Drive API
    projectNumber: ""  // for a future Google file picker
  };
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var GIS_URL = "https://accounts.google.com/gsi/client";
  var DRIVE = "https://www.googleapis.com/drive/v3/files";
  var UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  var XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  var APP = "show-feasibility";

  // ---------------------------------------------------------------- pure helpers
  function configured(cfg) {
    cfg = cfg || GOOGLE;
    return /\.apps\.googleusercontent\.com$/.test(String(cfg.clientId || "")) && /^AIza/.test(String(cfg.apiKey || ""));
  }
  function buildPayload(inputs, n, name, M, savedAt) {
    return { v: 2, app: APP, name: String(name || "").trim() || "Untitled scenario", inputs: M.sanitize(inputs), n: Math.max(0, Math.round(+n) || 0),
      savedAt: savedAt || new Date().toISOString() };
  }
  function parsePayload(obj, M) {
    if (!obj || typeof obj !== "object" || obj.app !== APP || !obj.inputs || typeof obj.inputs !== "object") return null;
    return { name: String(obj.name || "Untitled scenario"), inputs: M.sanitize(obj.inputs), n: Math.max(0, Math.round(+obj.n) || 0) };
  }
  function multipartParts(meta, contentType, boundary) {
    return {
      head: "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n" +
        "--" + boundary + "\r\nContent-Type: " + contentType + "\r\n\r\n",
      tail: "\r\n--" + boundary + "--"
    };
  }
  function fileLink(id) { return X.PAGE_URL + "#f=" + id; }
  function driveName(name) { return (String(name || "").trim() || "Untitled scenario") + " (Show Feasibility).json"; }

  // ---------------------------------------------------------------- browser side
  var token = null, tokenExp = 0, gisPromise = null;
  function hasToken() { return !!token && Date.now() < tokenExp - 60000; }
  function loadGis() {
    if (typeof window === "undefined") return Promise.reject(new Error("no browser"));
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = GIS_URL; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { gisPromise = null; s.remove(); reject(new Error("Google sign-in didn't load")); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  function preload() { if (configured()) loadGis().catch(function () { /* reported on use */ }); }

  // Call straight from a click handler: when the sign-in library is already loaded, the popup opens
  // inside the click, which browsers allow.
  function ensureToken() {
    if (hasToken()) return Promise.resolve(token);
    function ask() {
      return new Promise(function (resolve, reject) {
        var client = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE.clientId,
          scope: SCOPE,
          callback: function (resp) {
            if (!resp || resp.error) { reject(err("signin", resp && resp.error_description || "Google sign-in didn't finish.")); return; }
            token = resp.access_token;
            tokenExp = Date.now() + (+resp.expires_in || 3600) * 1000;
            resolve(token);
          },
          error_callback: function (e) {
            reject(err(e && e.type === "popup_failed_to_open" ? "popup" : "signin",
              e && e.type === "popup_failed_to_open" ? "The Google sign-in window was blocked. Allow pop-ups for this page and try again." : "Google sign-in was closed before it finished."));
          }
        });
        client.requestAccessToken({ prompt: "" });
      });
    }
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return ask();
    return loadGis().then(ask);
  }
  function err(code, message, status) { var e = new Error(message); e.code = code; e.status = status; return e; }

  function api(method, url, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.auth !== false && token) headers.Authorization = "Bearer " + token;
    return fetch(url, { method: method, headers: headers, body: opts.body }).then(function (res) {
      if (res.ok) return opts.raw ? res : res.status === 204 ? null : res.json();
      return res.text().then(function (t) {
        var msg = "";
        try { msg = JSON.parse(t).error.message; } catch (e) { msg = t.slice(0, 200); }
        throw err("http", msg || ("Google answered " + res.status), res.status);
      });
    });
  }
  function multipart(method, url, meta, content, contentType) {
    var boundary = "sf" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var p = multipartParts(meta, contentType, boundary);
    return api(method, url, { headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: new Blob([p.head, content, p.tail]) });
  }

  // Upload the workbook and let Drive turn it into a Google Sheet. Returns { id, url }.
  function uploadAsSheet(blob, fileName) {
    var name = String(fileName || "Show feasibility").replace(/\.xlsx$/i, "");
    return multipart("POST", UPLOAD + "?uploadType=multipart&fields=id,webViewLink",
      { name: name, mimeType: "application/vnd.google-apps.spreadsheet" }, blob, XLSX_MIME).then(function (f) {
      return { id: f.id, url: f.webViewLink || "https://docs.google.com/spreadsheets/d/" + f.id + "/edit" };
    });
  }

  // Save a scenario. With fileId, update that file (same link); if Google refuses, save a copy.
  // Returns { id, link, copied }.
  function saveScenario(payload, fileId) {
    var body = JSON.stringify(payload);
    function create() {
      var meta = { name: driveName(payload.name), mimeType: "application/json", appProperties: { showFeasibility: "1" },
        description: "Show Feasibility scenario. Open it at " + X.PAGE_URL };
      return multipart("POST", UPLOAD + "?uploadType=multipart&fields=id", meta, body, "application/json").then(function (f) {
        return api("POST", DRIVE + "/" + f.id + "/permissions", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "reader", type: "anyone" }) })
          .then(function () { return f.id; });
      });
    }
    if (!fileId) return create().then(function (id) { return { id: id, link: fileLink(id), copied: false }; });
    return multipart("PATCH", UPLOAD + "/" + encodeURIComponent(fileId) + "?uploadType=multipart&fields=id", { name: driveName(payload.name) }, body, "application/json")
      .then(function () { return { id: fileId, link: fileLink(fileId), copied: false }; })
      .catch(function (e) {
        if (e.status === 403 || e.status === 404) return create().then(function (id) { return { id: id, link: fileLink(id), copied: true }; });
        throw e;
      });
  }

  // Open a saved scenario: public read with the API key; falls back to the signed-in token for files
  // that aren't shared publicly. Resolves to the raw payload object.
  function loadScenario(fileId) {
    var url = DRIVE + "/" + encodeURIComponent(fileId) + "?alt=media&supportsAllDrives=true";
    return api("GET", url + "&key=" + encodeURIComponent(GOOGLE.apiKey), { auth: false }).catch(function (e) {
      if (hasToken() && (e.status === 403 || e.status === 404)) return api("GET", url);
      throw e;
    });
  }

  // Files this page created in the signed-in person's Drive, newest first.
  function listSaved() {
    var q = "appProperties has { key='showFeasibility' and value='1' } and trashed=false";
    return api("GET", DRIVE + "?pageSize=50&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime)&q=" + encodeURIComponent(q))
      .then(function (r) {
        return (r.files || []).map(function (f) {
          return { id: f.id, name: f.name.replace(/ \(Show Feasibility\)\.json$/, ""), modifiedTime: f.modifiedTime };
        });
      });
  }

  return {
    GOOGLE: GOOGLE,
    configured: configured, buildPayload: buildPayload, parsePayload: parsePayload, multipartParts: multipartParts,
    fileLink: fileLink, driveName: driveName,
    preload: preload, hasToken: hasToken, ensureToken: ensureToken,
    uploadAsSheet: uploadAsSheet, saveScenario: saveScenario, loadScenario: loadScenario, listSaved: listSaved
  };
});
