# Team Scenarios (Apps Script backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Google sign-in for saved scenarios and Open in Google Sheets with a passcode-protected Apps Script web app that runs as Quentin and stores a shared, versioned team list in his Drive.

**Architecture:** `apps-script/Code.gs` is the backend. Its pure logic and a `handle(req, env)` dispatcher are testable in Node with a fake `env`. A thin Apps Script layer (`doPost`, the real `env`, the Sheet export) is checked live. `team.js` (window.ShowTeam) replaces `google.js` in the page. `app.js` and `index.html` swap the Google UI for an unlock panel, the team list with History, and the script-built Google Sheet.

**Tech Stack:** Plain ES5-style JavaScript (UMD modules, no build), Google Apps Script V8 with the Drive v3 and Sheets v4 advanced services, Node `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-11-27-team-scenarios-apps-script-design.md`

## Global Constraints

- Code style matches the existing modules: `var`, `function`, a UMD wrapper, no new runtime dependencies, and no build step.
- `tests/` is git-ignored. Run tests from `tests/` with `node --test <file>`; the full suite takes more than 2 minutes, so run it in the background. Test files are never committed.
- `TEAM = ["Quentin", "Jasmine", "Chad", "CJ"]` (this order, in `team.js`).
- Scenarios tab is `Scenarios`. Headers, in this order: `ID, Version, Name, Saved by, Saved at, Show, Venue, Ticket price, Capacity, Tickets, Net at tickets, Data`.
- IDs are 10 characters from `[A-Za-z0-9]`. They must match `export.js`'s `#f=` pattern `[A-Za-z0-9_-]{10,}`.
- Limits: `data` ≤ 45,000 characters, `name` ≤ 120, `savedBy` ≤ 60 (trimmed and capped).
- Lockout: after 10 wrong passcodes within 600 s, every request gets `locked`.
- The script replies with JSON over HTTP 200: `{ok:true, ...}` or `{ok:false, error, message}`. `error` is one of `passcode | locked | notfound | bad | server`. The client adds `network`.
- The page sends `POST` with `Content-Type: text/plain;charset=utf-8` and a JSON body, so there is no CORS preflight.
- Exported Sheets are shared `DriveApp.Access.ANYONE_WITH_LINK`, `DriveApp.Permission.EDIT`.
- `#s=`, `#q=`, Copy summary and Download Excel file are unchanged and need no passcode.
- The passcode never appears in the repo or the page. It lives in Script Properties `PASSCODE` and in each browser's `localStorage`.
- Bump cache-busting query strings on changed `<script>` tags (`app.js?v=13`, new `team.js?v=1`).

## Review Focus

1. **`PASSCODE` not set in Script Properties.** Every call returns `server` with "PASSCODE isn't set in Script Properties." An empty or missing passcode never matches. The test goes in Task 2.
2. **Quentin changes the passcode later.** A teammate's stored passcode then gets `passcode`. The page must clear it and show the unlock panel with "That passcode didn't work.", not a generic error. Tests go in Task 3 (`call` clears it) and Task 4 (the UI check).
3. **The sheet is edited by hand.** Columns reordered, an extra column added, blank rows, `Version` stored as the text `"3"`: list, load and save all still work. The test goes in Task 1.
4. **Opening a `#f=` link or saving over a scenario whose rows were deleted from the sheet.** The reply is `notfound`, the page says so (for a save, it suggests Save as new) and the visitor's own scenario stays loaded. Tests go in Task 1 (`planSave`), Task 2 (`load`) and Task 3 (`errorText`).
5. **Wrong or unreachable script URL.** The reply is an HTML error page or the request is rejected. The page shows "Couldn't reach the team list…", never a JSON parse error. The test goes in Task 3.

---

### Task 1: Backend pure logic (`apps-script/Code.gs`)

**Files:**
- Create: `apps-script/Code.gs`
- Test: `tests/script.test.js` (load it with `require("../apps-script/Code.gs")`; Node treats unknown extensions as CommonJS JavaScript)

**Interfaces:**
- Produces (the `module.exports` at the bottom of `Code.gs`, guarded by `if (typeof module !== "undefined" && module.exports)`):
  - `HEADERS`: an array of `[header, key]` pairs: `["ID","id"], ["Version","version"], ["Name","name"], ["Saved by","savedBy"], ["Saved at","savedAt"], ["Show","show"], ["Venue","venue"], ["Ticket price","price"], ["Capacity","capacity"], ["Tickets","tickets"], ["Net at tickets","net"], ["Data","data"]`
  - `recordsFromValues(values: any[][]) -> Record[]`. Row 0 is the header row. Columns are mapped by header text. Rows with a blank ID are skipped. `version` becomes a Number. `savedAt` becomes an ISO string (Date objects are converted).
  - `rowFromRecord(rec: Record, headerRow: string[]) -> any[]`: values in the sheet's own column order, with `""` for unknown columns.
  - `missingHeaders(headerRow: string[]) -> string[]`: the `HEADERS` header names that aren't in `headerRow`.
  - `listItems(records) -> [{id, name, savedBy, savedAt, version, versions, show, venue}]`: the latest version per ID, sorted by `savedAt` (newest first).
  - `historyOf(records, id) -> [{version, savedBy, savedAt}]`, newest version first.
  - `findVersion(records, id, version?) -> Record | null`: the latest version when `version` is omitted.
  - `validateSave(req) -> {ok:true, clean:{id, baseVersion, name, savedBy, data, summary}} | {ok:false, error:"bad", message}`
  - `planSave(records, clean, newId: string, nowIso: string) -> {record: Record, overtook: {savedBy, savedAt} | null} | {error: "notfound"}`
  - `checkPasscode(given, expected, cache: {get(k), put(k, v, ttlSeconds)}) -> null | "passcode" | "locked" | "unset"`
  - `newId(rand: () => number) -> string` (10 characters)
  - `sheetsRequests(deco, sheetIds)`: moved from `google.js` unchanged.
- `Record` = `{id, version, name, savedBy, savedAt, show, venue, price, capacity, tickets, net, data}`

- [ ] **Step 1: Write the failing tests** in `tests/script.test.js`:
  - `recordsFromValues maps by header, skips blank rows, survives reordered and extra columns`: header row `["Notes","Data","ID","Version","Name","Saved by","Saved at"]` with rows (`version` given as text `"2"`, plus one all-blank row). Assert two records with `id`, `version === 2` (a number), `name` and `data` correct, and `savedAt` an ISO string when given a `Date`.
  - `rowFromRecord follows the sheet's column order`: for that header row, assert `rowFromRecord(rec, header)` is `["", rec.data, rec.id, rec.version, rec.name, rec.savedBy, rec.savedAt]`.
  - `missingHeaders lists what a hand-edited sheet lost`: `missingHeaders(["ID","Data"])` includes `"Version"` and `"Net at tickets"`, and doesn't include `"ID"`.
  - `listItems returns the latest per id, newest first, with version counts`: three rows for id `aaaaaaaaaa` (v1–v3) and one for `bbbbbbbbbb`. Assert the order follows `savedAt`, and `aaaaaaaaaa` has `version: 3, versions: 3` and the v3 name.
  - `historyOf is newest first` and `findVersion picks the latest or the asked version` (an unknown id or version gives `null`).
  - `validateSave`: it accepts a good request and trims `name`/`savedBy` to 120/60 characters. `{ok:false, error:"bad"}` comes back for:
    - `data` that isn't JSON
    - `data` whose `app` isn't `"show-feasibility"`
    - `data` of 45,001 characters
    - a missing `savedBy`
  - `planSave`:
    - with no `id`: a version 1 record that uses `newId`.
    - with an `id`: `latest + 1`, carrying the summary fields into `show/venue/price/capacity/tickets/net`.
    - `baseVersion` below the latest: `overtook` is the latest's `{savedBy, savedAt}`; `baseVersion` equal to the latest: `overtook: null`.
    - an unknown `id`: `{error: "notfound"}`.
  - `checkPasscode`:
    - `"unset"` when `expected` is `""` or `undefined`, whatever is given (an empty given never matches).
    - `"passcode"` on a mismatch.
    - `"locked"` after 10 mismatches, even when the 11th is correct. Use a fake cache (an object with `get`/`put`).
    - `null` on a match.
  - `newId` gives 10 characters matching `/^[A-Za-z0-9]{10}$/`, and its output passes `X.decodeShared(X.PAGE_URL + "#f=" + id, M)` as `{fileId: id}`.
  - Move the `Sheets API requests lock every tab…` test from `tests/google.test.js` here unchanged, calling `S.sheetsRequests`.

- [ ] **Step 2: Run the tests to make sure they fail**
  Run: `cd tests && node --test script.test.js`
  Expected: FAIL with "Cannot find module '../apps-script/Code.gs'".

- [ ] **Step 3: Implement the functions above in `apps-script/Code.gs`**
  - Nothing runs at the top level except constants and function declarations.
  - `checkPasscode` keeps the counter under cache key `"badTries"`. It `put`s the incremented count with TTL 600 on every mismatch, and returns `"locked"` once the count is ≥ 10 before comparing.
  - `newId` draws from the 62-character alphabet using `rand()`. The real `env` passes `Math.random`.
  - Copy `sheetsRequests` from `google.js:61-93` verbatim.

- [ ] **Step 4: Run the tests to make sure they pass**
  Run: `cd tests && node --test script.test.js`
  Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git add apps-script/Code.gs
  git commit -m "Apps Script backend: scenario records, versions, validation, passcode lockout"
  ```

### Task 2: Backend dispatcher and Apps Script layer

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `apps-script/appsscript.json`
- Test: `tests/script.test.js`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `handle(req: object, env: Env) -> reply` (exported). It never throws: exceptions become `{ok:false, error:"server", message: e.message}`.
  - `Env` = `{ passcode: string, cache, readRecords(): Record[], appendRecord(rec: Record): void, withLock(fn): any, newId(): string, now(): string, makeSheet(fileName: string, xlsxBase64: string, deco): {id, url, decorated} }`
  - Replies by action:
    - `check` → `{ok:true}`
    - `list` → `{ok, items}`
    - `load {id, version?}` → `{ok, id, version, latestVersion, name, savedBy, savedAt, data}`
    - `history {id}` → `{ok, versions}`
    - `save {id?, baseVersion?, name, savedBy, data, summary}` → `{ok, id, version, overtook}`
    - `sheet {fileName, xlsx, deco}` → `{ok, id, url, decorated}`
    - An unknown action → `bad`.
  - Apps Script only (not exported, checked live in Task 6): `doPost(e)`, `doGet()`, `realEnv()`, `scenariosSheet()`, `exportFolder()`, `makeSheetReal(fileName, b64, deco)`.

- [ ] **Step 1: Write the failing tests** (`handle …` group in `tests/script.test.js`). Use a fake env: records in an array, `withLock: fn => fn()`, a fixed `now`, a `newId` that returns `"k3J9xQ2mPa"`, a cache object, and `makeSheet` returning `{id:"S1", url:"u", decorated:true}`.
  - The wrong passcode gets `{ok:false, error:"passcode"}`, and nothing is appended.
  - `env.passcode = ""`: `check` with `passcode: ""` gets `{ok:false, error:"server", message:"PASSCODE isn't set in Script Properties."}`.
  - `save` (new), then `save` with that id and `baseVersion: 1` gives version 2 and `overtook: null`. A third `save` with `baseVersion: 1` gives version 3 with `overtook.savedBy` from v2.
  - `save` for an unknown id gets `notfound`. `load` for an unknown id gets `notfound`. `load` with `version: 1` returns v1's `data` and `latestVersion: 3`.
  - `list` and `history` return the Task 1 shapes.
  - `sheet` passes `fileName`, `xlsx` and `deco` through to `env.makeSheet` and returns its result with `ok:true`. A missing `xlsx` gets `bad`.
  - When `env.readRecords` throws `new Error("boom")`, the reply is `{ok:false, error:"server", message:"boom"}`.
  - `{action:"nope"}` with a good passcode gets `bad`.

- [ ] **Step 2: Run the tests to make sure they fail**
  Run: `cd tests && node --test script.test.js`
  Expected: FAIL, "S.handle is not a function".

- [ ] **Step 3: Implement `handle`.** Then add the Apps Script layer below it:
  - `doPost(e)`: `JSON.parse(e.postData.contents)`. A parse failure gets `bad`. It replies with `ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON)`.
  - `doGet()`: returns the text "Show Feasibility team list is running." (a sanity check in a browser).
  - `realEnv()`:
    - `passcode`: `PropertiesService.getScriptProperties().getProperty("PASSCODE") || ""`
    - `cache`: `CacheService.getScriptCache()` with values stored as strings
    - `withLock`: `LockService.getScriptLock()`, waiting 20 s
    - `now`: `new Date().toISOString()`
    - `newId`: `newId(Math.random)`
  - `scenariosSheet()`: gets or creates the tab `Scenarios` in `SpreadsheetApp.getActive()`. On an empty tab it writes the header row and freezes row 1. It appends any `missingHeaders` as new columns at the end.
  - `exportFolder()`: uses the `EXPORT_FOLDER_ID` script property when that folder still exists. Otherwise it creates `Google Sheets` inside the spreadsheet's first parent folder and stores the new ID.
  - `makeSheetReal()`:
    1. `Drive.Files.create({name, mimeType:"application/vnd.google-apps.spreadsheet", parents:[folderId]}, Utilities.newBlob(Utilities.base64Decode(b64), XLSX_MIME, name + ".xlsx"), {fields:"id"})`
    2. `Sheets.Spreadsheets.get(id, {fields:"sheets.properties(sheetId,title)"})`
    3. `Sheets.Spreadsheets.batchUpdate({requests: sheetsRequests(deco, ids)}, id)` inside try/catch, setting `decorated`
    4. `DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT)`
    5. return `{id, url: "https://docs.google.com/spreadsheets/d/" + id + "/edit", decorated}`

  `apps-script/appsscript.json`:
  ```json
  { "timeZone": "America/Chicago", "runtimeVersion": "V8", "exceptionLogging": "STACKDRIVER",
    "dependencies": { "enabledAdvancedServices": [
      { "userSymbol": "Drive", "serviceId": "drive", "version": "v3" },
      { "userSymbol": "Sheets", "serviceId": "sheets", "version": "v4" } ] },
    "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" } }
  ```

- [ ] **Step 4: Run the tests to make sure they pass**
  Run: `cd tests && node --test script.test.js`
  Expected: all pass. Also run `node -e "new Function(require('fs').readFileSync('../apps-script/Code.gs','utf8'))"` from `tests/`; it should produce no output (the syntax is valid).

- [ ] **Step 5: Commit**
  ```bash
  git add apps-script/Code.gs apps-script/appsscript.json
  git commit -m "Apps Script backend: request handler, Sheet export, manifest"
  ```

### Task 3: Client module `team.js`

**Files:**
- Create: `team.js`
- Test: `tests/team.test.js`. The `#q=` link test in `tests/google.test.js` moves to `tests/link.test.js` unchanged.

**Interfaces:**
- Consumes: `X.PAGE_URL` (export.js) and the script reply shapes from Task 2.
- Produces (`window.ShowTeam` / `module.exports`):
  - `SCRIPT_URL` (`""` until Task 6) and `TEAM`
  - `configured(url?) -> boolean`: true when the URL matches `/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/`
  - `getAuth() -> {passcode, who} | null`, `setAuth(passcode, who)`, `clearPasscode()` (keeps `who`). These use `localStorage` key `"kcplur-show-feasibility-team"`.
  - `call(action, body?, opts?: {passcode, url, fetch}) -> Promise<reply>`
    - It rejects with an `Error` that has `.code` set to the reply's `error`, or to `"network"` when fetch fails, the HTTP status isn't OK, or the body isn't JSON.
    - On `"passcode"` it calls `clearPasscode()` first.
  - Wrappers: `check(passcode)`, `list()`, `load(id, version?)`, `history(id)`, `save({id, baseVersion, name, payload, summary})` (sends `data: JSON.stringify(payload)` and `savedBy: getAuth().who`), `makeSheet(fileName, xlsxBase64, deco)`
  - `buildPayload`, `parsePayload`: moved from `google.js` unchanged
  - `summary(inputs, r) -> {show, venue, price, capacity, tickets, net}`, taken from `inputs.showName`, `inputs.venueName`, `inputs.price`, `inputs.capacity`, `r.n` and `r.net` (rounded to cents)
  - `fileLink(id) -> X.PAGE_URL + "#f=" + id`
  - `toBase64(arrayBuffer) -> string`: chunked `btoa` in the browser, `Buffer` in Node
  - `errorText(e) -> string`. The exact copy:
    - `passcode`: "That passcode didn't work."
    - `locked`: "Too many wrong passcodes. Try again in 10 minutes."
    - `notfound`: "That saved scenario wasn't found. It may have been deleted from the Saved Scenarios sheet."
    - `bad`: "The team list didn't accept that: " + message
    - `server`: "The team list had a problem: " + message
    - `network` and anything else: "Couldn't reach the team list. Check your connection and try again."

- [ ] **Step 1: Write the failing tests** in `tests/team.test.js`. Use a fake `fetch` passed in `opts.fetch`, and a `global.localStorage` stub backed by a Map.
  - `configured` is false for `""` and for a random https URL, and true for `https://script.google.com/macros/s/AKfy_cb-12/exec`.
  - `call` posts `text/plain;charset=utf-8` with the body `{"action":"list","passcode":"pw"}` (the passcode comes from `setAuth("pw","Chad")`), and resolves with the reply on `ok:true`.
  - A `{ok:false, error:"passcode"}` reply rejects with `.code === "passcode"`, and `getAuth()` then gives `{passcode:"", who:"Chad"}`.
  - A fetch that rejects, an HTTP 500, and a 200 whose body is `"<html>"` all reject with `.code === "network"`. `errorText` for each is the network copy.
  - `errorText({code:"notfound"})` and `errorText({code:"locked"})` match the copy above exactly.
  - The payload round-trip tests from `tests/google.test.js` (`saved file payload round-trips and is validated`), using `T.buildPayload`/`T.parsePayload`.
  - `fileLink("k3J9xQ2mPa")` decodes with `X.decodeShared` to `{fileId:"k3J9xQ2mPa"}`.
  - `summary(M.DEFAULTS-based inputs, X.bundle(...).r)` gives the expected six fields.
  - `toBase64(new Uint8Array([0,1,2,250]).buffer) === "AAEC+g=="`.

- [ ] **Step 2: Run the tests to make sure they fail**
  Run: `cd tests && node --test team.test.js`
  Expected: FAIL, "Cannot find module '../team.js'".

- [ ] **Step 3: Implement `team.js`.** Use the same UMD wrapper as `google.js:15-21` (it needs `ShowExport`). `call` uses `opts.fetch` or else the global `fetch`, looked up at call time, and `opts.url || SCRIPT_URL`.

- [ ] **Step 4: Run the tests to make sure they pass**
  Run: `cd tests && node --test team.test.js link.test.js`
  Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git add team.js
  git commit -m "team.js: client for the team list (passcode, save, load, history, Sheets)"
  ```

### Task 4: Page: unlock panel and team list (replace Google sign-in)

**Files:**
- Modify: `index.html`:
  - the saved card (lines 723-745)
  - `#btn-gsheet`'s class (line 701)
  - the CSS near lines 390-397
  - the script tags (lines 754-755)
- Modify: `app.js`:
  - the Google section (lines 694-787)
  - `wire()` handlers (lines 539-549)
  - `openLinkText` (lines 679-686)
  - start (lines 1560-1571)
- Delete: `google.js` and `tests/google.test.js` (all of its tests have moved by now)

**Interfaces:**
- Consumes: `ShowTeam` (Task 3). Its `load` reply supplies `version` and `latestVersion`.
- Produces: `savedFile = {id, name, version, latestVersion}`, kept in `localStorage` under the existing `SAVED_KEY`. On restore, drop a stored pointer whose `id` isn't exactly 10 characters (old Drive IDs). Task 5 uses `ensureUnlocked(reasonText, then)`.

- [ ] **Step 1: Markup and CSS.** In the saved card:
  - Rename `.google-only` to `.team-only`.
  - Add `#team-unlock`:
    - label "Team passcode" with `input#team-pass` (`type="password"`, `autocomplete="current-password"`)
    - label "Who are you?" with `select#team-who` (app.js fills it from `TEAM`)
    - `button#btn-unlock.primary` "Unlock"
    - `p#unlock-msg.msg` (`role="status"`)
  - Wrap the existing controls in `#team-main`, starting with `p#team-whoami` ("Saving as Jasmine · " + `button#btn-change-who.small` "Change").
  - Hint copy: "Saved to the KC PLUR team list. Anyone with the team passcode can open and save these."
  - `#btn-list-saved` text: "Team scenarios".
  - Each list row gets a meta span (`Chad · Nov 26 · v3`) and a third button, "History". History expands a nested `ul.saved-history` of `v2 · Jasmine · Nov 25 [Open]` rows.
  - CSS: the row grid becomes `minmax(0,1fr) auto auto auto auto` for the extra button. `.saved-history` is indented with smaller text.
  - Script tags: drop `google.js`; add `team.js?v=1` before `app.js?v=13`.

- [ ] **Step 2: Rewrite the app.js section** (replace `googleReady`, `googleErrorText`, `openSavedFile`, `onSave`, `onListSaved`, `initGoogleUI`):
  - `teamReady()` = `T.configured()`. `initTeamUI()` shows `.team-only` when ready, fills `#team-who`, and calls `renderTeamUI()`.
  - `renderTeamUI()`: when `getAuth().passcode` is empty, it shows `#team-unlock` and hides `#team-main`; otherwise the reverse. It sets `#team-whoami` and runs the existing saved-current/link logic. The current line reads "Showing saved scenario: NAME (vN, WHO, DATE)".
  - `ensureUnlocked(reasonText, then)`:
    - Unlocked: call `then()` right away.
    - Locked: switch to the `share` section, show `reasonText` in `#unlock-msg`, focus `#team-pass`, and keep `then` as the pending action. A successful unlock runs it once.
  - `onUnlock()`: `T.check(pass)`. On success it calls `setAuth(pass, who)`, `renderTeamUI()` and the pending action. On failure it puts `T.errorText(e)` in `#unlock-msg`.
  - `#btn-change-who`: `clearPasscode()`, then `renderTeamUI()`.
  - `openSavedFile(id, version?)`: `ensureUnlocked("Enter the team passcode to open this saved scenario.", …)`, then `T.load`, `T.parsePayload(JSON.parse(reply.data), M)`, `openShared(...)` and `setSavedFile({id, name, version, latestVersion})`.
  - `onSave(asNew)`: `ensureUnlocked("Enter the team passcode to save.", …)`. Then `T.save({id: asNew ? null : savedFile && savedFile.id, baseVersion: savedFile && savedFile.version, name, payload: T.buildPayload(...), summary: T.summary(state.inputs, last.r)})`. Messages:
    - new: "Saved. Copy the link below to share it."
    - over: "Saved changes as v{N}. The link stays the same."
    - with `overtook`: "Saved as v{N}. {who} had saved v{N-1} at {time} after you opened it; theirs is in History." ({time} is `toLocaleTimeString` without seconds.)
    - on a `notfound` save-over: errorText + " Use Save as new."
  - `onListSaved()` and History: these use `T.list()`/`T.history(id)` and render rows with `el(...)` as today.
  - Every error goes through `T.errorText`. A `passcode` error also calls `renderTeamUI()`, so the unlock panel shows "That passcode didn't work."
  - Start: replace `initGoogleUI()` with `initTeamUI()`. `openLinkText`'s `#f=` branch calls `openSavedFile(got.fileId)`, which defers through `ensureUnlocked`.

- [ ] **Step 3: Verify in the browser pane against a fake backend.**
  1. `preview_start` `{name: "show-feasibility"}`.
  2. Temporarily set `SCRIPT_URL` in `team.js` to `https://script.google.com/macros/s/TEST/exec` (revert before committing) and load the page. With `javascript_tool`, wrap `window.fetch`: calls to that URL go to an in-memory implementation of `check/list/load/history/save` (passcode `"pw"`), and everything else goes to the real fetch. `call` looks up the global `fetch` at call time, so the wrapper takes effect without a reload. Test the `#f=` case by setting `location.hash`, not by reloading.
  3. Check:
     - a wrong passcode shows "That passcode didn't work."
     - unlock as Chad
     - Save, then Save changes (v2)
     - Team scenarios lists it with History (v2, v1); opening v1 shows "(v1, …)"
     - a `#f=k3J9xQ2mPa` hash while locked lands on the unlock panel with the open message, then opens after unlock
     - a stub that returns `passcode` on `list` re-shows the unlock panel
     - `read_console_messages` has no errors
  4. Confirm Copy link (`#s=`) and Download Excel file still work with no passcode.

- [ ] **Step 4: Run the full test suite in the background**
  Run: `cd tests && node --test` (background).
  Expected: all pass, with no reference left to `google.js`. `grep -rn "ShowGoogle\|google.js\|google-only" ../*.js ../index.html` gives no matches.

- [ ] **Step 5: Commit**
  ```bash
  git add index.html app.js
  git rm google.js
  git commit -m "Saved scenarios: team list with passcode, who-saved dropdown and history; remove Google sign-in"
  ```

### Task 5: Page: Open in Google Sheets through the script

**Files:**
- Modify: `app.js` (`onOpenInSheets`, lines 789-833)

**Interfaces:**
- Consumes: `ensureUnlocked` (Task 4); `T.makeSheet`, `T.toBase64`, `T.errorText` (Task 3); `WB.buildSheets`, `WB.writeWorkbook`, `WB.decorations`, `X.fileName` (existing).

- [ ] **Step 1: Rewrite `onOpenInSheets`.**
  - If locked, call `ensureUnlocked("Enter the team passcode to make a Google Sheet.", …)` and don't open a tab. The person clicks the button again after unlocking, which keeps the new tab inside a real click.
  - If unlocked, open the blank tab inside the click (as today, without the token condition). Build the workbook as today. Call `T.makeSheet(name, T.toBase64(buf), WB.decorations(sheets))`, then point the tab at `res.url` and fill `#export-ready`.
  - Messages:
    - "Your Google Sheet is open in a new tab. Anyone with the link can edit it."
    - without a tab: "Your Google Sheet is ready. Anyone with the link can edit it."
    - with `decorated: false`: add " (The formula lock and the profit chart couldn't be added; the sheet still works.)"
    - progress: "Creating your Google Sheet… this takes about 10 seconds."
  - Errors go through `T.errorText`; the ExcelJS load error message is kept.

- [ ] **Step 2: Verify in the browser pane** with the Task 4 fetch stub extended with `sheet` (it returns `{ok:true, id:"S1", url:"about:blank#sheet", decorated:false}`):
  - Locked: the click shows the unlock panel with the Sheets message, and no tab opens.
  - Unlocked: the message shows, including the lock/chart note, and the request body has a non-empty `xlsx` and a `deco` with `sheets`.

- [ ] **Step 3: Commit**
  ```bash
  git add app.js
  git commit -m "Open in Google Sheets: built by the team script, shared anyone-with-link can edit"
  ```

### Task 6: Go live (Drive setup, Quentin's deployment, live test)

**Files:**
- Modify: `team.js` (`SCRIPT_URL`)
- Modify (outside the repo, not committed): `C:\Users\quent\Documents\KC PLUR\show feasibility tracker\google-setup.md`

- [ ] **Step 1: Create the Drive pieces** with the Drive connector (Quentin's KC PLUR Google account):
  - a folder `Show Feasibility` in My Drive
  - inside it, a Google Sheet `Show Feasibility – Saved Scenarios`

  The script creates the `Scenarios` tab, its headers and the `Google Sheets` subfolder on first use. Record both links.

- [ ] **Step 2: Rewrite `google-setup.md`**:
  - Replace the Google Cloud section with "Team list (Apps Script)": the sheet and folder links, the deployment steps from the spec's Setup section, "Later script changes: Manage deployments → Edit → New version", and "The old Google Cloud project 77601018463 can be deleted."
  - Keep the Calculator and Google Sheets sections.

- [ ] **Step 3: Hand Quentin the setup.** Send `apps-script/Code.gs` and `apps-script/appsscript.json` (SendUserFile), the sheet link, and the four steps. Wait for the `/exec` URL. In a browser, the URL should show "Show Feasibility team list is running."

- [ ] **Step 4: Set `SCRIPT_URL`** in `team.js` to the URL Quentin sends. Bump `team.js?v=2`.

- [ ] **Step 5: Live test** in the browser pane at `http://localhost:8765/` (the origin doesn't matter to the script). Quentin types the passcode in the pane, or sets a temporary one and changes it afterwards. Check:
  - wrong, then right passcode
  - save new, save over, the `overtook` message (save from a second tab using an older `baseVersion`)
  - the list, History, opening v1
  - a `#f=` link while locked
  - Open in Google Sheets: the tab opens, the Inputs tab is locked except the yellow cells, the chart tab exists, and the link opens in a signed-out browser with edit rights
  - rows appear in the Saved Scenarios sheet with the headline columns filled

  Then delete the test rows from the sheet and the test Google Sheets from the folder.

- [ ] **Step 6: Commit; ask before pushing**
  ```bash
  git add team.js
  git commit -m "Point the page at the team list script"
  ```
  Ask Quentin before `git push`, because pushing publishes to GitHub Pages.

### Task 7: Import the existing scenarios

The Links tab of "Rane b2b CRYSOMEMORE - Feasibility & Budgets" (`1CL4cnApLVcZHUl_YtqADblZWwy4T2UpJwUL0dwM7kEQ`) holds the only two scenarios the team has worked on. Both `#q=` links decode with today's code to the sheet's numbers: True gives $1,072.38 net at 250 tickets (break-even 137); Offer (padded) gives $326.38 (break-even 192).

- [ ] **Step 1:** On the live page (after the push, or on localhost with the real `SCRIPT_URL`), unlocked as Quentin, open each link from `Links!F5` and `Links!F6`. Check the net at 250 matches the sheet, then Save with these names:
  - `Rane b2b CRYSOMEMORE – Incline on 9th (True)`
  - `Rane b2b CRYSOMEMORE – Incline on 9th (Offer, padded)`
- [ ] **Step 2:** Confirm both rows are in the Saved Scenarios sheet with `Net at tickets` 1072.38 and 326.38. Confirm both open from Team scenarios.
- [ ] **Step 3:** Ask Quentin whether to add the two new `#f=` links to the Links tab next to the existing `#q=` links. The `#q=` links keep working either way.
