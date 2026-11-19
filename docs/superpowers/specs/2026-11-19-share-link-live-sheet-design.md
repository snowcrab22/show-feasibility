# Share links, live spreadsheet (light build), Google Sheets export, cost changes

Date: 2026-11-19. Status: awaiting approval.

## Intent

The calculator stays a local, no-server page. Three things change for the person running it:

1. Sharing a scenario should be as easy as pasting a link, without anything stored online.
2. The spreadsheet should be a real, formatted workbook whose numbers are formulas, not pasted values,
   and it should land in Google Sheets in one click instead of download-then-upload.
3. The page and export get trimmed (two notes cards) and the cost inputs change (no PRO licensing,
   no printing, a new Labor group).

The sheet should eventually stand alone as a full calculator. This work is the **light build**:
mostly a finished report, but with the cost and talent side live so small changes recalculate
correctly. A follow-up session does the **full build** (see the end).

## Goals

- "Copy link" shares the exact scenario; opening the link loads it. Nothing leaves the browser except
  what the person pastes somewhere.
- Spreadsheet: polished formatting, live formulas, every input listed, shaded cells are safe to edit.
- "Open in Google Sheets" creates the sheet in the signed-in person's Drive and opens it.
- "Download Excel file" keeps working with no Google setup.

## Non-goals (this build)

- Editing ticket price, capacity, comps, tax, fees, online/door split or the venue cut in the sheet.
- A live price grid or live break-even price in the sheet.
- Charts in the sheet. Saved scenario lists in the browser.

## Anti-goals

- A sheet that shows a wrong number after an edit it invites. A cell is shaded as editable only if
  everything that depends on it is a formula.
- Any server or storage of scenarios. Silently replacing someone's own saved scenario when they open
  a link.

## Approaches considered

**Getting the sheet into Google Sheets**
- A. (chosen) Build one .xlsx in the browser (ExcelJS, as today). Download it, or upload it to Drive
  with conversion to a Google Sheet using Google sign-in in the page (Google Identity Services, scope
  `drive.file`: the page can only see files it creates). One builder, two destinations. Needs a
  one-time Google Cloud OAuth client; the client ID is public and lives in the code.
- B. Build the Google Sheet natively with the Sheets API. Best Sheets fidelity and charts, but a second
  builder to keep in step with the Excel file.
- C. Google Apps Script web app. No Cloud Console, but the script lives in one person's account,
  shows an "unverified app" warning, and is awkward for teammates.
- The person chose to set up Google Cloud, so A. B's chart can be layered on in the full build.

**Share link format**
- A. (chosen) `…/show-feasibility/#s=<code>`, where code is base64url JSON of only the inputs that
  differ from a frozen v2 baseline, plus the ticket count. Short for typical scenarios, synchronous,
  and the part after `#` is never sent to GitHub's server. The baseline is frozen so links keep their
  meaning when the page's defaults change later.
- B. Compressed full JSON. Async (clipboard timing problems on Safari), still long.
- C. Positional values list. Shortest, but brittle when inputs are added.

## Design

### Trims and cost changes
- Remove "Things to confirm before booking" (Overview) and "How the numbers work" (Share) from the
  page, and their counterparts in the export.
- Remove ASCAP, BMI and Printing inputs. Event insurance stays, in a group renamed "Insurance".
- New "Labor" cost group: Sound techs (on/off, people, pay each for the night) and Stagehands
  (on/off, people, pay each). Defaults off, 1 tech at $150, 2 stagehands at $100, so the default
  scenario's numbers do not change. Labor counts toward contingency. In "Where the money goes" it
  joins Production as "Production & labor" (no new color).
- Old codes and links that carry the removed keys still load; the keys are ignored.

### Share link
- "Copy link" replaces "Copy scenario code" (top bar and Share tab). On phones it opens the share sheet.
- The Share tab's paste box accepts a link or an old scenario code.
- Opening a link: load the scenario, keep the visitor's previous scenario as an undo
  ("Opened a shared scenario. Go back to mine"), then remove `#s=` from the address so a refresh keeps
  their edits. Section hashes (`#costs` etc.) keep working.

### Spreadsheet (light build)
Tabs: Summary, Inputs, Tickets & fees, Venue, Talent, Costs, By ticket count.

- **Inputs** lists every input. Editable (yellow, with dropdowns for choices and on/off): tickets sold,
  headliner deal (all parts, starts, basis, versus, backend), travel, hospitality, support slots and
  price, VJ, venue flat rental, labor, production, marketing, insurance, custom lines, contingency,
  other income. Set in the calculator (gray, labeled): capacity, comps, prices, door price, online %,
  cash %, card rates, tax, platform fees, venue % of door and per-head fee.
- **By ticket count** has one row per ticket count 0 to sellable. Ticket-side columns (online/door
  counts, face, tax, fees, door processing, venue cut, per-head, net ticket revenue) are values from the
  calculator. Cost-side columns are formulas: base net, headliner % and per-ticket parts with their
  start points, versus, backend, total costs, net. Headliner break-even and show break-even are
  formulas over this table.
- Summary, Tickets & fees, Venue, Talent and Costs read the chosen ticket count's row with formulas, so
  changing tickets sold or any yellow cell updates everything shown. The five scenario rows are live.
- Snapshot blocks, clearly labeled as such: price-by-attendance grid, break-even price, per-ticket
  prices.
- Formatting: title band, section headings, consistent number formats, yellow input cells, gray
  snapshot text, green/red net via conditional formatting, frozen headers, sized columns, no gridlines,
  print setup. Named ranges so formulas read like `=Guarantee+Travel`. Each formula also stores its
  computed result so viewers that do not recalculate still show numbers.
- A link back to the calculator for this scenario (as exported).

### Google Sheets export
- Buttons: "Open in Google Sheets" and "Download Excel file".
- Google sign-in popup on first use; the token stays in memory only. Upload the same .xlsx to Drive
  with conversion, then open the new sheet (a tab opened on the click when already signed in, or an
  "Open your sheet" link after first sign-in, to avoid popup blocking).
- Google Cloud setup (done with the person in the browser): project, Drive API, consent screen
  (External), Web client with origins `https://snowcrab22.github.io` and `http://localhost:8765`.
  No billing. Teammates can use the button once added as test users or once the app is published.

## Verification
- Model checks in Node for the default and changed scenarios (cost changes, labor on).
- Formula check: build the workbook in Node and evaluate it with a formula engine across varied
  scenarios and edited inputs; every live number must match the model to the cent.
- One real upload to Google Sheets; read values back and compare.
- Browser check of the page: link round trip, undo banner, section navigation, exports.

## Left to the builder
Cell layout, colors within the existing palette, exact wording of labels and messages.

## Full build (next session)
Make the ticket side live (price, door price, capacity/comps with a table sized for any capacity, tax,
fees, splits, venue cut), live price grid and break-even price, dropdown validation everywhere, a
formula-built link back to the calculator, a profit chart (Sheets API after upload), and sheet
protection for non-input cells.
