# Offer Amounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Padded offer amounts beside each cost, carried in one link, shown on a new Offer tab of the page, and exported as live Offer / True budget / Padded budget tabs.

**Architecture:** The model gains two inputs and `offerInputs()`. Everything that already works on a scenario (compute, links, workbook formulas) is reused on the offer scenario. The workbook computes the offer live from the true sheet's named cells plus an offer delta.

**Tech Stack:** Plain JS (UMD), node:test, ExcelJS 4.4.0, HyperFormula (tests).

**Spec:** `docs/superpowers/specs/2026-11-19-offer-amounts-design.md`

## Global Constraints
- `OFFER_KEYS` (in this order):
  - `hlTravel`, `hlHospitality`, `supportPrice`, `vj`;
  - `soundTechPay`, `stagehandPay`;
  - `security`, `sound`, `gear`, `photo`;
  - `ads`, `poster`;
  - `insurance`, `venueRental`.
- Defaults are `offerAmounts: {}` and `offerExtra: []`. The default scenario's numbers don't change.
- A cost that is off stays off in the offer.
- No personal names or emails go in the code.
- Run tests with `node --test tests/*.test.js` from the repo root.

## Review Focus
1. **Garbage in a link:** an override for an unknown key, a negative amount, or text. It should be dropped or clamped, never crash.
2. **An override on a cost that's off:** it's ignored.
3. **An old link:** it opens with no offer.
4. **A sheet edit:** clearing an offer cell should fall back to the true amount live.
5. **The budget tab net:** it must equal NetAtCount and OfferNetAtCount, with venue cut, fees we absorb and other income on.

---

### Task 1: Model
**Files:** `model.js`, `tests/offer.test.js`

**Produces:**
- `M.OFFER_KEYS`
- `M.offerInputs(inp) -> inputs`
- `M.offerDelta(inp) -> number` (added fixed costs before contingency)

**Tests:**
- Defaults are `{}` and `[]`. `offerInputs(defaults)` matches the defaults apart from the offer fields.
- An override changes only that cost; `compute(offerInputs)` raises total costs by delta × (1 + contingency).
- An override on an off cost (`vjOn: false`, `offerAmounts.vj` = 500) changes nothing.
- `offerExtra` lines are appended after the custom lines.
- Sanitize:
  - drops unknown keys and non-numbers;
  - clamps negatives to 0;
  - caps `offerExtra` at 50.
- A real padded case (several overrides plus three offer-only lines) matches a hand-built budget: the offer net and headliner break-even agree to the cent.

### Task 2: Links and wording
**Files:** `export.js`, `tests/link.test.js`

**Changes:**
- `#q=` encodes `o_<key>` and `x<i>`; `Q_SKIP` covers the offer fields; `decodeQuery` parses them back.
- `X.OFFER_ROWS`: `[{ key, label, unit, on(inp), people(inp) }]` for the page and the workbook.

**Tests:**
- `#s=` and `#q=` round-trip with offers.
- An old `#q=` link has no offer.
- An `o_` param for an unknown key is ignored.

### Task 3: Page Offer tab
**Files:** `index.html`, `app.js`. Checked in the browser.
- Add a section `offer` (nav tab "Offer").
- **Offer costs table:**
  - one row per `OFFER_ROWS` entry whose cost is on;
  - the input is `data-ok=<key>`;
  - blank deletes the override.
- **Offer-only lines:** an editor with `data-oi` / `data-of` attributes.
- **At a glance:** offer net, true net, break-even pair, artist and promoter at sell-out, costs added.
- **Copy offer link** = `encodeLink(offerInputs(state.inputs), n)`.
- `syncControls` re-renders the offer rows. `SECTION_NAMES` gains "offer".

### Task 4: Workbook offer inputs and math
**Files:** `workbook.js`, `tests/sheet.test.js`

**Inputs tab:**
- The "Offer (padded costs)" rows are named `Offer_<key>`, with blank allowed.
- 10 offer-only line rows: `OfferLine_<i>_Name` and `OfferLine_<i>_Amount`.

**Costs tab, working offer block (named cells):**
- Per-line `OfferAmt_*` cells: `IF(on, IF(Offer_k="", true, Offer_k)) × people or slots`.
- `OfferFixedBase`, `OfferContingency`, `OfferFixedTotal`, `OfferDelta = OfferFixedTotal − FixedTotal`.

**By ticket count:**
- Add the column `offerBaseFlag = IF(base − OfferDelta ≥ −EPS, 1, 0)`, named `ByT_OfferBaseFlag`.
- `OfferHLBreakEven` comes from a MATCH on that column.

**Offer deal block, at ChosenN and at Sellable:**
- Thresholds use `OfferHLBreakEven`; basis comes from INDEX into `ByT_HLBasis`.
- Named results: `OfferPayAtCount`, `OfferNetAtCount`, `OfferPayAtSellout`, `OfferNetAtSellout`.

**CalcLink:** gains `o_` and `x` pieces.

**Tests:**
- For several scenarios, compare against `M.compute(offerInputs)`: offer net and pay at count and at sell-out, and the offer headliner break-even.
- Live edit: setting and clearing `Offer_ads` recalculates.
- CalcLink round-trips the offer.

### Task 5: Workbook Offer and budget tabs
**Files:** `workbook.js`, `tests/sheet.test.js`

**Offer tab (template layout):**
- `OfferGrossSellout`, `OfferNSR` = artist + promoter.
- Summary cells `OfferArtistSellout` and `OfferPromoterSellout`.

**True budget / Padded budget tabs:**
- Expenses rows as in the spec.
- `BudgetNet_True` and `BudgetNet_Offer` are formulas over their own rows.

**Tests:**
- `BudgetNet_True` = NetAtCount and `BudgetNet_Offer` = OfferNetAtCount, with venue cut, absorb mode and other income on.
- Offer tab artist + promoter = OfferNSR; the promoter equals `M.compute(offer, sellable).net`.
- No error cells.

### Task 6: Ship
- Bump the `?v=` versions.
- Browser check of the Offer tab at desktop and phone widths, with no console errors.
- Run the full suite.
- Push (fast-forward only), then confirm Pages built and the live page shows the Offer tab.
