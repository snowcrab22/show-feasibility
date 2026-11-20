# Fee cap and headliner pay cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-ticket cap on online ticketing fees and a cap on total headliner pay, everywhere the numbers appear.

**Architecture:**
- `model.js` is the source of truth.
- `export.js` holds the field definitions (the UI renders them generically), the wording and the link codecs.
- `workbook.js` mirrors the model in live formulas.
- The tests compare the sheet with the model in HyperFormula.

**Tech Stack:** Plain JS (UMD), node:test, ExcelJS 4.4.0, HyperFormula (tests only).

**Spec:** `docs/superpowers/specs/2026-11-19-fee-and-headliner-caps-design.md`

## Global Constraints
- New inputs and defaults:
  - `ebCapOn: true`, `ebCap: 5.5`
  - `hlCapOn: false`, `hlCap: 1500`
- Fee cap:
  - `fee = min(uncapped fee, ebCap)` when on.
  - Service and processing are each scaled by the same factor `k = ebCap / uncapped fee`.
  - In pass mode, buyer online = gross + fee.
  - Door card fees are not capped.
- Headliner cap:
  - `capEff = max(hlCap, guarantee)`
  - `dealPay = min(dealPay, capEff)`
  - `backend = min(backend, capEff − dealPay)`
  - Travel and hospitality sit outside the cap.
- `LINK_BASE` gains `ebCapOn: false, ebCap: 5.5, hlCapOn: false, hlCap: 1500`. Existing keys are never changed.
- The default scenario at n=105 still gives net 1134.962 and break-even 42.
- Run tests with `node --test tests/*.test.js` from the repo root.

## Review Focus
1. The fee cap is exactly zero (`ebCap: 0`). Fees should be $0 and nothing should divide by zero.
2. The headliner cap is below the guarantee. Pay should equal the guarantee.
3. A versus deal plus backend, capped. Deal pay hits the cap first, and the backend should then be $0.
4. A link made before today (no cap keys). It should open with the fee cap off.
5. Absorb mode with the cap binding. Net ticket revenue should rise by online × (uncapped − cap).

---

### Task 1: Model caps
**Files:** Modify `model.js` (DEFAULTS, ticketSide, computeCore, header notes). Test: `tests/model.test.js`.

**Produces:**
- `r.perTicketPrices.ebFee`, `ebService`, `ebProc` and `onlineBuyer` reflect the fee cap.
- `r.headliner.dealPay`, `backend` and `pay` reflect the headliner cap.
- New field `r.headliner.capped` (boolean): true when either part was cut by the cap.

- [ ] **Step 1: Write the failing tests.** All values below are at price $80 with otherwise default inputs.
  - Pass mode, capped: fee 5.5, buyer online 93.5, service + processing 5.5, service/processing ratio 4.75/2.7701.
  - Pass mode, cap off: fee ≈ 7.5201.
  - Absorb mode: net ticket revenue capped − uncapped = online × (7.302 − 5.5).
  - `ebCap: 0` gives a fee of 0.
  - At $25 the fee is 3.617 whether the cap is on or off.
  - Flat + bonus at n=145: uncapped pay is 815. With `hlCapOn`, `hlCap: 500`, pay is 500 and net is 315 higher. With `hlCap: 200`, pay is 300.
  - Flat + backend with `hlCap: 400`: pay is 400 and backend is 100 when the raw backend is above 100.
  - Versus with a cap below the versus amount: backend is 0.
- [ ] **Step 2:** Run the tests. They should fail.
- [ ] **Step 3:** Implement in the model.
- [ ] **Step 4:** Run the whole suite. It should pass.
- [ ] **Step 5:** Commit.

### Task 2: Inputs, wording, links
**Files:** Modify `export.js` (LINK_BASE, field definitions, `hlDescription`, `perTicketRows`, `headlinerRows`) and `app.js` (`summaryText`). Test: `tests/link.test.js`.

- [ ] **Step 1: Write the failing tests.**
  - An old `#s=` link with empty `d` decodes with `ebCapOn === false`.
  - A `#q=n=105` link also decodes with `ebCapOn === false`.
  - The defaults' link round-trips with `ebCapOn === true`.
  - `hlDescription` ends with `", capped at $1,500"` when `hlCapOn` is on.
  - The `LINK_BASE` test now reads: equals today's defaults except `ebCapOn: false`.
- [ ] **Step 2:** Add the fields.
  - `g-platform`: `{k:"ebCap", toggle:"ebCapOn", label:"Fees capped at, per ticket", type:"money", step:0.25}`
  - `g-hl`: `{k:"hlCap", toggle:"hlCapOn", label:"Cap total pay at", type:"money"}`
  - Wording: per-ticket rows note the cap, and the summary's "Assumes" line adds "capped at $5.50/ticket".
- [ ] **Step 3:** Run the suite, then commit.

### Task 3: Live sheet
**Files:** Modify `workbook.js`. Test: `tests/sheet.test.js`.

- [ ] **Step 1: Write the failing tests.**
  - Add sheet scenarios that check the sheet against the model:
    - fee cap binding at $80 in pass mode;
    - the same in absorb mode;
    - headliner cap on flat + bonus at n=145, with cap 500;
    - versus + backend capped.
  - Add `FeeCapOn`, `FeeCap`, `HLCapOn` and `HLCap` edits to the live-edit test.
  - Add `HLCapOn` and `HLCap` to the CalcLink test.
- [ ] **Step 2:** Build the sheet changes.
  - Inputs rows: `FeeCap` + `FeeCapOn`, and `HLCap` + `HLCapOn`.
  - `ptFormulas` gets keys `svcU` (uncapped service), `feeU` and `k`. `svc`, `proc`, `fee` and `buyer` use them. Add labels to `PT_LBL` and Tickets & fees rows.
  - Apply the cap in `dealFormulas` and in the ByT `deal` and `backend` columns.
  - Deal wording gets ", capped at $X".
  - Add `Q` entries for the four keys.
- [ ] **Step 3:** Run the suite, then commit.

### Task 4: Ship
- [ ] Bump `?v=` on the script tags.
- [ ] Check the page in a browser.
  - Both rows render.
  - The cap binds at $80.
  - There are no console errors.
- [ ] Push to main: fetch first, fast-forward only.
