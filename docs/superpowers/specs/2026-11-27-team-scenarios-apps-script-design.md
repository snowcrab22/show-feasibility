# Team scenarios without Google sign-in (Apps Script backend)

Date: 2026-11-27. Status: approved in conversation (link-shared Sheets are editable; the KC PLUR email is
a regular Google account, not Workspace).

## Intent and why

Saved scenarios and "Open in Google Sheets" currently need each person to sign in to Google through
our own Google Cloud OAuth app (`google.js`, scope `drive.file`). Google keeps that app in "Testing"
mode, where each teammate's email has to be added as a test user. Moving it to production asks for
an app domain, a privacy policy and terms of service. Quentin doesn't want to manage either.

The replacement is a small Google Apps Script web app that runs as Quentin
(Quentin's KC PLUR Google account, where the KC PLUR Drive files live). The page talks to it with a team
passcode. Nobody signs in to Google, and nothing has to be registered with Google Cloud.

Who uses it: the KC PLUR team: Quentin, Jasmine, Chad and CJ.

## Goals

- A shared **team list** of saved scenarios. Anyone with the passcode can save, save over, save as
  new, list and open them.
- **Every action needs the passcode**: list, open (including opening a `#f=` link), save, and
  Open in Google Sheets.
- **Who saved it** comes from a dropdown (Quentin, Jasmine, Chad, CJ), not a typed name.
- **Every save is kept.** Saving over a scenario adds a new version. Opening a scenario shows the
  latest version, and older versions can be opened from History.
- **Open in Google Sheets**: the script turns the same .xlsx the page downloads into a Google Sheet
  in a KC PLUR Drive folder. It adds the formula lock and the profit chart, sets sharing to "anyone
  with the link", and returns the link. The page opens it.
- Remove the Google sign-in code completely: Google Identity Services, the Drive file picker, the
  client ID and the API key.

## Non-goals

- Real per-person accounts or permissions. The passcode is the only lock.
- Deleting or renaming scenarios from the page. Do that in the Saved Scenarios sheet by hand.
- Migrating old Drive-saved scenarios. None exist: a Drive search on 2026-11-27 found no
  `(Show Feasibility).json` files, and teammates could never sign in.
- Offline saving. The browser already keeps the last scenario.

## Anti-goals (it fails even if it "works")

- Any Google sign-in popup or consent screen for teammates.
- The passcode written in the repository or the page source.
- Losing a save: two people saving over the same scenario must both end up in History.
- Breaking what works without the backend: `Copy link` (`#s=`), `#q=` links, `Copy summary` and
  `Download Excel file` stay exactly as they are and need no passcode.

## Constraints

- The page is static on GitHub Pages (`https://snowcrab22.github.io/show-feasibility/`), plain
  ES5-style JavaScript in UMD modules, no build step. Pure helpers are tested in Node with
  `node --test` in `tests/` (git-ignored harness).
- Apps Script web app, deployed with "Execute as: Me" and "Who has access: Anyone". Its `/exec` URL
  is public in the page source. The passcode is what protects it.
- Cross-origin calls: the page sends `POST` with `Content-Type: text/plain` (no CORS preflight) and a
  JSON body, then reads the JSON reply after Google's redirect. Apps Script can't set HTTP status
  codes, so every reply is HTTP 200 with `{ ok: true, ... }` or `{ ok: false, error, message }`.
- Apps Script replies take about 1–3 s. Building a Google Sheet takes longer (upload, convert,
  decorate, share), likely 5–15 s. The exported .xlsx has been about 1 MB, which is about 1.4 MB as
  base64. That is well under Apps Script's request limits.
- One Google Sheets cell holds at most 50,000 characters. The scenario JSON is a few KB.

## Approaches considered

1. **Publish the existing OAuth app.** No code changes, but Google asks for an app domain, a privacy
   policy and terms. Quentin tried it and rejected it.
2. **No backend.** Keep the share links and add a per-browser "My scenarios" list. Nothing to set
   up, but there's no shared list, no saving over each other's scenarios, and no Google Sheets
   export.
3. **Apps Script web app with a team passcode (chosen).** A shared list in KC PLUR's own Drive, no
   sign-in, and the Sheets export keeps working. It costs a one-time setup by Quentin, and the
   passcode is the only protection.

(Cloudflare Worker + KV or Supabase would do what 3 does, but the data would live outside Google
and the Sheets export would be lost.)

## Design

### Storage (Quentin's Drive, Quentin's KC PLUR Google account)

- Folder **Show Feasibility**, containing:
  - Spreadsheet **Show Feasibility – Saved Scenarios**, tab **Scenarios**, one row per save:
    `ID | Version | Name | Saved by | Saved at | Show | Venue | Ticket price | Capacity | Tickets | Net at tickets | Data`.
    `Data` is the scenario JSON (`buildPayload` shape: `{v, app, name, inputs, n, savedAt}`).
    `Show` through `Net at tickets` are headline values the page already computes. They make
    the sheet readable on its own. "Net at tickets" is the page's net at the selected ticket count,
    and it can be negative.
  - Subfolder **Google Sheets**: where Open in Google Sheets puts each new sheet.
- The script is **bound to the Saved Scenarios spreadsheet** (Extensions → Apps Script), so it uses
  `SpreadsheetApp.getActive()`. It finds the Google Sheets subfolder by an ID in Script Properties,
  creating it next to the spreadsheet if the ID is missing.
- Script Properties: `PASSCODE` (set by Quentin by hand) and `EXPORT_FOLDER_ID` (set by the
  script).

### Script API (`apps-script/Code.gs`, one `doPost`)

The request body is JSON `{ action, passcode, ... }`. Every action checks the passcode first.

| action | input | reply |
|---|---|---|
| `check` | — | `{ok:true}` |
| `list` | — | `{ok, items:[{id, name, savedBy, savedAt, version, versions, show, venue}]}`: latest version per ID, newest first |
| `load` | `id`, optional `version` | `{ok, id, version, latestVersion, name, savedBy, savedAt, data}` |
| `history` | `id` | `{ok, versions:[{version, savedBy, savedAt}]}`, newest first |
| `save` | optional `id`, optional `baseVersion`, `name`, `savedBy`, `data`, `summary` | `{ok, id, version, overtook}` |
| `sheet` | `fileName`, `xlsx` (base64), `deco` | `{ok, id, url, decorated}` |

- **save**: without `id`, the script makes a new 10-character random ID at version 1. With `id`, it
  appends `latest + 1` (`notfound` if the ID doesn't exist). The script returns
  `overtook: {savedBy, savedAt}` when `baseVersion` is below the version that was latest before
  this save. In other words, someone else saved in between. Nothing is lost; the page just says so.
  Writes run under `LockService.getScriptLock()`.
- **Validation**: `data` must parse, have `app === "show-feasibility"` and be under 45,000
  characters. `savedBy` and `name` are trimmed and capped at 60 and 120 characters. Anything else
  gets `error: "bad"`.
- **sheet**: the script decodes the base64 and creates the Google Sheet with the **Drive** advanced
  service (v3, `mimeType: application/vnd.google-apps.spreadsheet`, parent = export folder). It
  reads the tab IDs with the **Sheets** advanced service, builds the lock and chart requests with
  `sheetsRequests(deco, sheetIds)`, and applies them with `batchUpdate`. Then it sets sharing to
  anyone with the link (permission level: see open question 1). If the lock or chart fails, the
  sheet is kept and `decorated: false` is returned. That matches today's "the sheet still works"
  message.
- **`sheetsRequests` moves from `google.js` into `Code.gs`** unchanged, so there's one copy. Its
  existing tests move with it.
- **Wrong passcode**: reply `error: "passcode"`. Bad tries are counted in `CacheService`. After 10
  bad tries within 10 minutes, every request gets `error: "locked"` until the 10 minutes are up.
- Errors: `passcode`, `locked`, `notfound`, `bad`, `server` (an exception was caught; `message` says
  what happened). There are no stack traces.
- `Code.gs` has to load in Node for tests. It makes no Apps Script calls at the top level, and it
  keeps the pure logic separate from the Apps Script calls: picking the latest version per ID,
  numbering versions, validation, `sheetsRequests` and the lockout counter (given a cache).
- `apps-script/appsscript.json` turns on the Drive (v3) and Sheets (v4) advanced services and
  `webapp: { executeAs: USER_DEPLOYING, access: ANYONE_ANONYMOUS }`.

### Page

- **`team.js`** (`window.ShowTeam`) replaces `google.js`. It holds `SCRIPT_URL` and
  `TEAM = ["Quentin", "Jasmine", "Chad", "CJ"]`. It provides `call(action, body)` (adds the stored
  passcode, posts, unwraps `{ok}`, and throws an error that carries `.code`), `buildPayload`,
  `parsePayload` (kept from `google.js`), `fileLink(id)` (`PAGE_URL#f=<id>`, the same link shape)
  and the passcode/name storage. Until `SCRIPT_URL` is filled in, the team features stay hidden, as
  they do today without a client ID.
- **Unlock panel** (in the Saved scenarios card, shown when there's no stored passcode):
  ```
  Team passcode  [••••••••]
  Who are you?   [Quentin ▾]
  [Unlock]
  ```
  `Unlock` calls `check`. On success, the passcode and name go in `localStorage` and the card shows
  "Saving as Jasmine · Change" (Change goes back to the unlock panel). On a `passcode` error, the
  stored passcode is cleared, the panel comes back, and it says "That passcode didn't work."
- **Saved scenarios card** (shown when unlocked):
  ```
  Showing saved scenario: Incline – Jan 10 (v3, Chad, Nov 26)
  Name [Incline – Jan 10      ]
  [Save changes] [Save as new]
  Saved scenario link [https://…#f=k3J9xQ2mPa] [Copy]
  [Team scenarios]
  · Incline – Jan 10   Chad · Nov 26 · v3   [Open] [Copy link] [History]
  ```
  `History` expands that row into its versions (`v2 · Jasmine · Nov 25 [Open]`). Opening an old
  version loads it, and the next Save makes a new latest version from it. That is how to undo a bad
  save.
- **Opening a `#f=` link while locked**: the page switches to the Share section, shows the unlock
  panel with "Enter the team passcode to open this saved scenario", and opens the scenario as soon
  as the unlock succeeds. The shared-banner and undo behaviour is unchanged.
- **Open in Google Sheets**: it needs to be unlocked; if locked, it shows the unlock panel. The page
  always opens a blank tab inside the click (there's no sign-in popup to work around any more),
  builds the .xlsx as today, sends it with `deco = WB.decorations(sheets)`, then points the tab at
  the returned URL. It keeps the "Open your Google Sheet" link as a fallback.
- **Save messages**: "Saved. Copy the link below to share it." / "Saved changes as v4. The link
  stays the same." / with `overtook`: "Saved as v5. Chad had saved v4 at 3:10 PM after you opened
  it; theirs is in History."
- Copy changes: the card's hint becomes "Saved to the KC PLUR team list. Anyone with the team
  passcode can open and save these." The `.google-only` class becomes `.team-only`.
- Remove `google.js`, its `<script>` tag, `tests/google.test.js` (its `buildPayload`,
  `parsePayload` and `sheetsRequests` tests move to `team.js` and `Code.gs` tests), and every
  Google sign-in or Picker message in `app.js`.

### Setup (Quentin, once, signed in to Quentin's KC PLUR Google account)

Claude creates the **Show Feasibility** folder and the **Saved Scenarios** spreadsheet (with
headers) through the Drive connector, and writes the setup steps into the existing notes file
`KC PLUR/show feasibility tracker/google-setup.md`. Quentin then:

1. Opens the spreadsheet → Extensions → Apps Script, and pastes `Code.gs` (and `appsscript.json`
   after turning on "Show appsscript.json" in Project Settings).
2. Project Settings → Script Properties: adds `PASSCODE`.
3. Deploy → New deployment → Web app (Execute as: Me; Who has access: Anyone) → authorizes it
   (Google warns that the app is unverified because it's his own script: Advanced → Go to …).
4. Sends Claude the `/exec` URL. Claude puts it in `team.js`.

Later script changes: Manage deployments → Edit → Version: New version. The URL stays the same.

The old Google Cloud project (77601018463) can be deleted afterwards. The repo's old API key is
restricted, and deleting the project retires it.

## Testing

- Node: the `team.js` pure helpers (payload build and parse, request body, error mapping, link)
  and the `Code.gs` pure logic, loaded with `vm` and stub globals: latest per ID, version numbering,
  `overtook`, validation, lockout counting, and `sheetsRequests` (the existing cases).
- Live, once the URL exists: in the browser pane against the real deployment, check unlock (right
  and wrong passcode), save new, save over, save over from a second browser profile (`overtook`),
  list, History and opening an old version, opening a `#f=` link while locked, and Open in Google
  Sheets (opens, is locked, has the chart, and the link opens in a signed-out window). Quentin
  types the passcode, or sets a temporary one for testing and changes it afterwards.

## Left to the builder

- The exact module layout and CSS for the unlock panel and history rows, within the page's
  existing card and button styles.
- How `Code.gs` exposes its pure functions to Node: a guarded `module.exports` at the bottom works
  in Apps Script.
- ID alphabet and generator, and the exact headline fields' formatting in the sheet.
- Message wording beyond what's specified above.

## Calls made while writing this (Claude's, open to correction)

- The Drive connector Claude uses is signed in to Quentin's KC PLUR Google account: the KC PLUR files it lists
  are owned by that account, so the folder and spreadsheet Claude creates land there.
  "Anyone with the link" sharing already works on that account. The published offer sheet is
  shared that way.
- The script reads the Scenarios tab **by header name, not column position**, and skips blank rows.
  Hand edits in the sheet (deleting a row, moving or adding columns, re-sorting) don't break it.
- Sharing the Saved Scenarios spreadsheet with teammates is optional. Editors can see `PASSCODE` in
  Script Properties, but they already know the passcode.
- The Open in Google Sheets success message changes to match the sharing level, e.g. "Your Google
  Sheet is open in a new tab. Anyone with the link can edit it."

## Open questions for Quentin

1. ~~Google Sheets made by Open in Google Sheets: can edit or can view?~~ **Answered: anyone with
   the link can edit** (`DriveApp.Access.ANYONE_WITH_LINK`, `DriveApp.Permission.EDIT`). Each click
   makes a fresh sheet, so edits only ever touch that one copy. The success message says "Anyone
   with the link can edit it."
2. ~~Is the KC PLUR email a Google Workspace account?~~ **Answered: no.** It's a regular Google account
   using the KC PLUR email, so there are no admin policies to check, and the `/exec` URL is the
   plain `script.google.com/macros/s/.../exec` form.
