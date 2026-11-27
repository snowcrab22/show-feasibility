# Ticket Bonuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Ticket bonuses" (up to 5 lump sums, each paid once tickets sold reach its trigger) to the headliner deal, everywhere the deal appears.

**Architecture:**
- `model.js` is the source of truth: inputs, sanitize, presets, the bonus math in `computeCore`.
- `export.js` holds the field schema the page renders, the shared wording and the link codecs.
- `workbook.js` mirrors the model in live formulas; `app.js`/`index.html` render the deal card rows, the cost line, the offer lines and the chart note.

**Tech Stack:** Plain ES5 UMD modules, no build step; node:test, ExcelJS 4.4.0, HyperFormula (tests only).

**Spec:** `docs/superpowers/specs/2026-11-27-ticket-bonuses-design.md`

## Global Constraints
- New inputs: `hlBonusOn: false`, `hlBonuses: []`; rows `{ trigger: "tickets"|"pct"|"sellout", n, amount }`; at most 5 rows.
- Trigger count `at`: tickets → `n` (rounded, ≥ 0); pct → `ceil(round9(S × n / 100))` with n clamped to 0..100; sellout → `S`. `S = sellable(inp)`.
- A row pays its whole amount when `tickets sold ≥ at`. Rows add up.
- `preBonus = versus ? max(guarantee, pct + perTicket) : guarantee + pct + perTicket`; `dealPay = min(preBonus + bonusPart, capEff)`; backend is capped by what is left. `bonusPaid = dealPay − min(preBonus, capEff)`.
- `versusOverage` stays bonus-free: `min(preBonus, capEff) − guarantee`.
- `fixedCosts`, `baseNet`, `headlinerBreakEven` do not change (bonuses stay out of contingency and the headliner break-even).
- New preset `ticketBonus` = guarantee on, bonuses on, %/per-ticket/backend/versus off. Every existing preset gets `hlBonusOn: false`.
- `LINK_BASE` gains `hlBonusOn: false, hlBonuses: Object.freeze([])`. No existing LINK_BASE value changes.
- Default scenario at n = 105: net 1134.962, break-even 42 (unchanged). `hlDescription(DEFAULTS)` unchanged.
- Sheet trigger labels: `N tickets`, `% sold`, `Sell out`. The sheet's number cell is a plain number (80 means 80%).
- Every touched script gets its `?v=` bumped in `index.html`. Don't touch `apps-script/Code.gs` or `app.js` `onHistory`.
- Run tests one file at a time: `node --test tests/<file>.test.js`. `tests/` is git-ignored (never committed).

## Review Focus
1. Tickets sold exactly at a trigger (n = at): the bonus pays; one ticket below, it doesn't.
2. A bonus that pushes net back below $0 after break-even: break-even stays the first n with net ≥ 0, and the note names the dip.
3. % sold trigger after capacity or comps change (in the page and in the sheet): the ticket count moves; 80% of 245 is 196, 29% of 245 is 72.
4. Pay cap binding with bonuses, versus, and backend: total pay = cap, backend 0, bonus line shows only what fits.
5. Links: an old `#s=`/`#q=` link opens with bonuses off and empty; a sheet-built `#q=` link decodes to exactly `M.sanitize(inputs)`.

---

### Task 1: Model

**Files:**
- Modify: `model.js` (header notes, DEFAULTS, ENUMS, PRESETS, sanitize, computeCore, exports)
- Test: `tests/bonus.test.js` (new)

**Interfaces:**
- Produces:
  - `M.DEFAULTS.hlBonusOn === false`, `M.DEFAULTS.hlBonuses` = `[]`; `M.MAX_BONUSES === 5`; `M.ENUMS.bonusTrigger` = `["tickets", "pct", "sellout"]`.
  - `M.ENUMS.hlPreset` = `["flat", "pct", "perTicket", "flatBackend", "flatBonus", "ticketBonus", "versus", "custom"]`; `M.PRESETS.ticketBonus`.
  - `M.bonusAt(row, S) -> integer` (trigger ticket count).
  - `r.headliner.bonusPart` (pre-cap sum of reached rows), `r.headliner.bonusPaid` (post-cap), `r.headliner.bonuses` = `[{ trigger, n, amount, at, reached }]` (empty when off).

- [ ] **Step 1: Write the failing tests** in `tests/bonus.test.js`:
  - `sanitize`: defaults off/empty; 7 rows → 5; bad trigger → `"tickets"`; tickets n 299.6 → 300; pct n 120 → 100; negative amount → 0.
  - `bonusAt`: `{pct, 80}` at S 245 → 196; `{pct, 29}` at 245 → 72; `{pct, 7}` at 100 → 7; sellout → S; tickets 300 → 300.
  - Pays: D + guarantee preset + `[{tickets,100,500},{sellout,0,500}]`, capacity 150 comps 5: at 99 bonusPart 0; at 100 bonusPart 500 and pay 800; at 145 bonusPart 1000; off → 0.
  - Versus: guarantee 600 vs 40% from ticket 1 plus `{tickets,50,250}`: dealPay = max(600, pct) + 250 at n ≥ 50; versusOverage excludes the 250.
  - Cap: cap 1000 with flatBonus + bonuses `[{tickets,100,500}]` at 145: pay 1000, bonusPaid = 1000 − min(preBonus, 1000); backend on → 0.
  - Contingency and `headlinerBreakEven` unchanged by turning bonuses on; `breakEven` is the first n with net ≥ 0 even when a bonus later dips net below 0 (guarantee 300, bonus `{tickets,50,2000}`).
  - Presets: `detectPreset` of DEFAULTS still `flatBonus`; `PRESETS.ticketBonus` applied → `ticketBonus`; every other preset has `hlBonusOn: false`.
  - `fixedCosts` contingency base is the same with bonuses on (compare `r.contingencyBase`).

- [ ] **Step 2: Run** `node --test tests/bonus.test.js`. Expected: FAIL (`bonusAt` not a function / fields undefined).

- [ ] **Step 3: Implement.** sanitize clamps per trigger as in Global Constraints (`round9(x) = Math.round(x * 1e9) / 1e9`). `computeCore` computes the rows' `at` from `sellable(inp)` and sums reached amounts when `hlBonusOn`; pay order and `versusOverage` per Global Constraints. Add pinned-reading lines to the header comment.

- [ ] **Step 4: Run** `node --test tests/bonus.test.js`, then `tests/model.test.js`, `tests/caps.test.js`, `tests/visual.test.js`. Expected: all PASS.

- [ ] **Step 5: Commit** `model.js` ("Ticket bonuses: model").

### Task 2: Wording, schema and links (`export.js`)

**Files:**
- Modify: `export.js` (LINK_BASE, SECTIONS g-hl, CONTINGENCY_HINT, hlDescription, headlineRows, headlinerRows, Q_SKIP, encodeQueryLink, decodeQuery, new helpers, exports)
- Test: `tests/bonus.test.js`

**Interfaces:**
- Consumes: Task 1 names.
- Produces:
  - `X.TRIGGERS` = `[["tickets", "N tickets"], ["pct", "% sold"], ["sellout", "Sell out"]]`.
  - `X.bonusLabel(row, S) -> string`: `"Bonus: $500 at 300 tickets"`, `"Bonus: $500 at sellout (245 tickets)"`, `"Bonus: $500 at 80% sold (196 tickets)"` (cents only when the amount has them).
  - `X.bonusDipNote(bundle) -> string`: `""` unless bonuses are on and net < 0 at some n past show break-even; otherwise `"Net drops back below $0 at 300–311 tickets, where a ticket bonus kicks in."` (ranges joined with ", ", single ticket as "300").
  - SECTIONS g-hl: preset option `["ticketBonus", "Guarantee + ticket bonuses"]` after flatBonus; field `{ k: "hlBonuses", toggle: "hlBonusOn", type: "bonuses", label: "Ticket bonuses", hint }` after the $ per ticket group.
  - `#q=` param `b<i>=<trigger>~<n>~<amount>`.

- [ ] **Step 1: Write the failing tests:**
  - `LINK_BASE` has `hlBonusOn: false`, `hlBonuses` `[]`; the existing "LINK_BASE matches defaults" test in `link.test.js` still passes.
  - `bonusLabel` gives the three spec strings (S 245).
  - `hlDescription` with ticketBonus preset and two rows: `"$300 guarantee + $500 bonus at 300 tickets + $500 bonus at sellout"`; DEFAULTS unchanged.
  - `headlinerRows` has one row per bonus, labelled by `bonusLabel`, value = amount when reached else 0; `headlineRows` hl sub mentions `"ticket bonuses $500"` when one is reached.
  - `#s=` and `#q=` round-trip `{hlBonusOn: true, hlBonuses: [tickets 300 500, pct 62.5 250, sellout 0 750.5]}` exactly; `#q=n=105` and an empty `#s=` decode to bonuses off and `[]`; `b1=junk~x~y` decodes to a sanitized row, not a crash.
  - Team: `T.parsePayload(JSON.parse(JSON.stringify(T.buildPayload(inp, 105, "x", M))), M).inputs` deep-equals `M.sanitize(inp)` with bonuses.
  - `bonusDipNote`: the dip scenario from Task 1 names the range; bonuses off → `""`; no dip → `""`.

- [ ] **Step 2: Run** `node --test tests/bonus.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add "ticket bonus" to CONTINGENCY_HINT and to the versus and cap hints. `hlDescription` appends `" + $500 bonus at 300 tickets"` / `"at sellout"` / `"at 80% sold"` per row when on (after the versus/plus join, before backend). `headlinerRows` puts bonus rows after the versus row, before backend.

- [ ] **Step 4: Run** `tests/bonus.test.js`, `tests/link.test.js`, `tests/offer.test.js`, `tests/visual.test.js`, `tests/team.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `export.js` ("Ticket bonuses: wording, deal card schema, links").

### Task 3: Live spreadsheet (`workbook.js`)

**Files:**
- Modify: `workbook.js` (Inputs, By ticket count, dealFormulas/DEAL_KEYS, Costs, Talent, offerDeal, Offer tab, budgets, link parts, validation)
- Test: `tests/sheet.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (defined names):
  - Inputs: `HLBonusOn`; per slot i = 1..5: `Bonus_i_Trigger` (list N tickets / % sold / Sell out, blank allowed), `Bonus_i_Amount`, `Bonus_i_Number`, `Bonus_i_PaysFrom` (display: "" when the trigger is blank).
  - Talent working values: `BonusAt_i` (1,000,000,000 when bonuses are off or the trigger is blank).
  - `ByT_Bonus` column (pre-cap); `BonusAmt` on Costs (post-cap at the chosen count); `Offer<Count|Sellout>_Bonus`, `Offer<Count|Sellout>_BonusPaid`; Offer tab `OfferDealBonus_i_Amount`, `OfferDealBonus_i_At`.

- [ ] **Step 1: Write the failing tests** in `tests/sheet.test.js`:
  - `checkAgainstModel` also checks `BonusAmt` ≈ `r.headliner.bonusPaid` and the `ByT_Bonus` column ≈ `bonusPart` per n; `checkOffer` checks `OfferCount_BonusPaid`.
  - SCENARIOS: "ticket bonuses at 100 tickets and sellout" (n 145); "ticket bonuses: % sold, versus and cap" (n 140); "a ticket bonus dips net below 0 after break-even" (n 60).
  - OFFER_SCENARIOS: "ticket bonuses with padded costs".
  - Live edits: set `HLBonusOn` On, `Bonus_1_Trigger` "% sold", `Bonus_1_Number` 80, `Bonus_1_Amount` 400, `Bonus_2_Trigger` "Sell out", `Bonus_2_Amount` 300, then `Capacity` 300, `Comps` 12, `TicketsSold` 230 → `checkAgainstModel` after each.
  - Sheet link: bonuses round-trip through `CalcLink`; after the edits above, `CalcLink` decodes to the edited inputs.
  - Offer tab: `OfferDealBonus_1_Amount` 500 and `OfferDealBonus_1_At` 100; empty slot → "".
  - Existing "no formula longer than 8,192" and "every formula cell stores its result" still pass.

- [ ] **Step 2: Run** `node --test --test-name-pattern="bonus" tests/sheet.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Pays-from formula: `IF(T="N tickets",ROUND(MAX(0,N(num)),0),IF(T="% sold",ROUNDUP(ROUND(Sellable*MIN(100,MAX(0,N(num)))/100,9),0),Sellable))`. HyperFormula's `INT` truncates negatives, so use `ROUNDUP`.
  - Bonus at N: `IF(N>=BonusAt_1,N(Bonus_1_Amount),0)+…+(slot 5)`. Deal = `capDeal(preBonus + bonus)` in all three deal formulas (By ticket count, `dealFormulas`, `offerDeal`); the "Headliner and profit" band span grows by one.
  - Post-cap bonus at a count = deal − `capDeal(preBonus)`.
  - Costs: "Ticket bonuses (part of headliner pay)" muted line under Headliner pay; the Talent subtotal formula is unchanged.
  - Talent: "Ticket bonuses" row after the $ per ticket part.
  - Offer tab, section 02: five rows (label formula "TICKET BONUS" / "BONUS AT 80% SOLD" / "SELLOUT BONUS", amount, "PAYS AT", tickets), blank when bonuses are off or the slot is empty.
  - Budgets: "Headliner bonus at this count" becomes pay − guarantee − post-cap bonus; new "Ticket bonuses" line.
  - Link: `HLBonusOn` joins the Q list; one `&b<i>=` piece per slot, emitted only when the trigger cell is non-blank.

- [ ] **Step 4: Run** the bonus-pattern tests, then the full `tests/sheet.test.js` in the background (about 5 minutes). Expected: PASS.

- [ ] **Step 5: Commit** `workbook.js` ("Ticket bonuses: live spreadsheet").

### Task 4: Page (`app.js`, `index.html`)

**Files:**
- Modify: `app.js` (buildField, new renderBonusRows, onControl, wire, syncControls, HL_TOGGLES, buildLedger/renderCosts, renderOffer, renderChart)
- Modify: `index.html` (CSS for bonus rows and lines, chart note element, offer bonus list, `?v=` bumps for model, export, workbook, app)

**Interfaces:**
- Consumes: Task 1–2 names (`X.TRIGGERS`, `X.bonusLabel`, `X.bonusDipNote`, `M.MAX_BONUSES`, `r.headliner.bonusPaid`).
- Produces: DOM ids `bonus-list`, `btn-add-bonus`, `bonus-trigger-i`, `bonus-n-i`, `bonus-amount-i`, `bonus-remove-i`, `led-hl-bonus`, `offer-bonus-list`, `chart-dip`.

- [ ] **Step 1: Implement.** Rows use `data-bi`/`data-bf` (trigger, n, amount) and `data-bremove`; the trigger change toggles the number box's `hidden` and its unit (tickets / %) without re-rendering; "Add bonus" is hidden at 5 rows; the add/remove click listener sits on `#in-talent`. The ledger row "Ticket bonuses (part of headliner pay)" shows `bonusPaid` (off when bonuses are off). The Offer section lists `bonusLabel` per row when on. The chart note shows `bonusDipNote(b)` under the profit chart.

- [ ] **Step 2: Verify.** `node --check app.js` and a quick load of `model.js`, `export.js`, `workbook.js` in node. Expected: no errors. (No browser here; the main session eye-checks the page.)

- [ ] **Step 3: Commit** `app.js`, `index.html` ("Ticket bonuses: deal card, costs line, offer lines, chart note").

### Task 5: Full suite
- [ ] Run `node --test tests/*.test.js` once (background, output to a file). Expected: all pass (117 + new).
