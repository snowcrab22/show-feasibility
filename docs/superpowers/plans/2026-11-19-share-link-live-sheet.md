# Share links, live sheet (light), Google Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim notes, swap PRO/printing for Labor, add share links, make the exported workbook formula-driven (light build), and add Google Drive save/open plus "Open in Google Sheets".

**Architecture:** Plain static site, no build step. `model.js` (pure model), `export.js` (shared wording, row builders, workbook description + ExcelJS writer), `app.js` (DOM), new `google.js` (Google sign-in, Drive upload and saved files). Tests are Node scripts in `tests/` (git-ignored, local only).

**Tech Stack:** ES5-style browser JS, ExcelJS 4.4.0 (cdnjs, lazy), Google Identity Services token client, Drive API v3 REST. Tests: `node --test`, devDeps `exceljs@4.4.0`, `hyperformula` in `tests/package.json`.

**Spec:** `docs/superpowers/specs/2026-11-19-share-link-live-sheet-design.md`

## Global Constraints

- No server, no database. Scenario data leaves the browser only in a pasted link or the saver's own Drive.
- Labor: Sound techs and Stagehands, each on/off + people + pay each for the night. Defaults off, 1 x $150, 2 x $100.
- Default scenario numbers must not change (labor off; printing was $0; ASCAP/BMI were off).
- Old v1 scenario codes and saved localStorage state keep loading; removed keys are ignored.
- Link format: `PAGE_URL + "#s=" + base64url(JSON {v:2, d:<inputs differing from LINK_BASE>, n})`. `LINK_BASE` is a frozen copy of the post-change DEFAULTS and never edited.
- Saved file link: `PAGE_URL + "#f=" + fileId`. Section hashes (`#costs` etc.) keep working.
- Google buttons hidden while `GOOGLE.clientId` or `GOOGLE.apiKey` is empty. Scope `https://www.googleapis.com/auth/drive.file` only. Never a client secret.
- Sheet: a cell is yellow (editable) only if everything downstream of it is a formula. Snapshot blocks say so.
- Bump `?v=` on every changed script tag. Fetch and fast-forward before each push; never force-push.

## Review Focus

- Opening a share link when the visitor has their own saved scenario: theirs is restorable via "Go back to mine".
- Pasting a full link, a bare `#s=` fragment, or an old v1 code into the load box: all load.
- Editing a yellow cost cell in the sheet so the headliner break-even moves: headliner pay, contingency and net all follow (no stale value).
- Editing tickets sold in the sheet to 0 or to sellable: every summary block follows; no #REF.
- A scenario where break-even is never reached: sheet shows "Not possible"/"never" text, not an error.

---

### Task 1: Trims and cost changes

**Files:** Modify `model.js`, `export.js` (LEDGER, CATS, costCategoryRows, notes, buildSheets), `app.js` (notes renderer, ledger subtotals), `index.html` (two cards + CSS). Test: `tests/model.test.js`.

**Interfaces — Produces:** DEFAULTS keys `soundTechsOn, soundTechs, soundTechPay, stagehandsOn, stagehands, stagehandPay`; `fixedCosts().lines.soundTechs`, `.stagehands`; `money.production` = sound + security + gear + soundTechs + stagehands (category label "Production & labor"); `money.marketing` = ads + poster; `money.other` = insurance + photo + custom + contingency. LEDGER group ids `labor`, `production`, `marketing`, `insurance`. Remove `confirmNotes`, `assumptionNotes`.

- [ ] Test: default scenario net at n=105 equals the pre-change value (record it from HEAD before editing); labor on (2 x 150, 3 x 100) adds 750 plus 5% contingency to total costs; `sanitize({printing:50, ascapOn:true})` has no `printing`/`ascap` keys; old v1 code from the conversation decodes.
- [ ] Implement, run `node --test tests/`, browser check Costs tab and Overview, commit.

### Task 2: Share links

**Files:** `export.js` (link codec), `app.js` (buttons, hash load, undo banner, load box), `index.html` (buttons, banner). Test: `tests/link.test.js`.

**Interfaces — Produces:** `X.LINK_BASE`; `X.encodeLink(inputs, n, M) -> string` (full URL); `X.decodeShared(text, M) -> {inputs, n, kind:'link'|'code'} | {fileId} | null` (accepts URL, `#s=…`, `s=…`, `#f=…`, raw v1 base64).

- [ ] Test: round trip of default and of a changed scenario (custom lines, unicode venue name) is exact after sanitize; default scenario link is under 60 chars after the `#s=`; decode of v1 code equals sanitize(inputs); garbage returns null.
- [ ] App: "Copy link" (top bar + Share; `navigator.share` on touch-first devices); on load, `#s=` applies the scenario, stores the previous state for "Go back to mine", then `history.replaceState` drops the fragment; section router ignores `s=`/`f=` hashes.
- [ ] Browser check round trip and undo; commit; push stage 1 (Tasks 1–2).

### Task 3: Live workbook (light)

**Files:** `export.js` (`buildSheets` rewrite, writer support), Test: `tests/sheet.test.js`.

**Interfaces — Produces:** `buildSheets(inputs, n, M, opts) -> sheets`; cells may carry `f` (formula string without `=`) plus `v` (cached result), `name` (defined name), `validation` (list of allowed values), `cf` (conditional format kind). `writeWorkbook(ExcelJS, sheets) -> Workbook` adds defined names, data validations, conditional formatting, hidden columns.

Sheets: Summary, Inputs, Tickets & fees, Venue, Talent, Costs, By ticket count.
Formula chain (By ticket count, one row per n = 0..S): snapshot ticket-side columns from `M.compute` (online, door, door card, gross face, face net, tax, buyers paid, platform fees passed/absorbed, door processing, venue % of door, per-head, net ticket revenue); live columns: base net = NTR + OtherIncome − FixedTotal; flag base ≥ −1e−9; HL basis by choice; % part; per-ticket part; deal pay (versus = MAX); extra = deal − guarantee; net before backend; backend; net; total costs; headliner pay; flag net ≥ −1e−9. `HLBreakEven = IFERROR(MATCH(1, baseFlag, 0) − 1, "never")`; `BreakEven = IFERROR(MATCH(1, netFlag, 0) − 1, "Not possible")`. Thresholds: first → 0; afterN → N; breakEven → HLBreakEven or "never" (part = 0). Chosen-count blocks use `INDEX(col, TicketsSold + 1)`.

- [ ] Test: build workbook in Node, load into HyperFormula, and for the default scenario plus 6 varied scenarios (each headliner preset, venue rental on, labor on, never-breaks-even) assert every live cell equals the model within $0.01. Then edit input cells (guarantee, ads, contingency %, tickets sold, a start mode) inside HyperFormula and assert against `M.compute` of the edited inputs.
- [ ] Implement; run tests; check the file opens in Node ExcelJS read-back; commit; push stage 2.

### Task 4: Google sign-in, Sheets export, saved scenarios

**Files:** Create `google.js`; modify `app.js`, `index.html`. Test: `tests/google.test.js` (pure helpers only).

**Interfaces — Produces:** `window.ShowGoogle = { configured(): bool, ensureToken(): Promise<string>, uploadAsSheet(blob, name): Promise<{id, url}>, saveScenario(payload, fileId|null): Promise<{id, link, copied:bool}>, loadScenario(fileId): Promise<payload>, listSaved(): Promise<[{id, name, modifiedTime}]> }`; `GOOGLE = { clientId, apiKey, projectNumber }` at the top of `google.js`. Pure helper `multipartBody(meta, blob|string, boundary)`.

- [ ] Saved file JSON: `{v:2, app:"show-feasibility", name, inputs, n, savedAt}`; Drive `appProperties: {showFeasibility: "1"}`; new files get permission `{type:"anyone", role:"reader"}`. Update refused (403/404) → create a copy and report it.
- [ ] Open `#f=` without sign-in: `GET drive/v3/files/{id}?alt=media&key=API_KEY`.
- [ ] Sheets: multipart upload with `mimeType: application/vnd.google-apps.spreadsheet`, open `https://docs.google.com/spreadsheets/d/{id}/edit`.
- [ ] Buttons hidden until configured. Commit; push stage 3 once IDs are in; user tests sign-in on the live site.

### Task 5: Verify in Google and hand off

- [ ] With the user's OK, upload one export via the Drive connector with conversion, read values back with the Sheets connector, compare to the model, then trash the file.
- [ ] Start the full-build session with a brief listing every snapshot block, the teammate-overwrite test, and the chart.
