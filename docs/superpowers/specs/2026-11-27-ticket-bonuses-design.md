# Ticket bonuses (short design)

Date: 2026-11-27. Status: approved by Quentin in chat; brainstorming done.

## Intent
An agent's deal can read "guarantee + $500 at 300 tickets + $500 at sellout". The current headliner
parts (guarantee, %, $ per ticket, backend, versus, cap) can't express a lump sum that pays once a
ticket count is reached. Add "Ticket bonuses" as one more headliner deal part.

## Design
### Inputs
- `hlBonusOn` (default **off**) and `hlBonuses` (default **[]**), a list of up to **5** rows
  `{ trigger, n, amount }`:
  - `trigger`: `"tickets"` (N tickets), `"pct"` (% sold) or `"sellout"` (Sell out).
  - `n`: the ticket count (rounded) or the percent (0 to 100). Sell out needs none.
  - `amount`: dollars, 0 or more.
- Deal card: a "Ticket bonuses" switch next to guarantee / % / $ per ticket / backend, so it combines
  with any of them. Each row has a trigger dropdown, a number box (only when the trigger needs one),
  a bonus $ box and a Remove button. "Add bonus" hides at 5 rows. Same add/remove pattern as the
  custom cost lines.
- Preset "Guarantee + ticket bonuses": guarantee on, bonuses on, everything else off. Presets only
  flip switches; every existing preset switches bonuses off.

### Paying
- A row's trigger count: N tickets = n; % sold = n% of sellable tickets (capacity − comps), rounded
  up (80% of 245 is 196); Sell out = sellable. % and Sell out move with capacity and comps.
- Each row pays its whole amount once tickets sold ≥ its trigger count. Rows add up: $500 at 300
  plus $500 at sellout pays $500 from 300 tickets and $1,000 at sellout.
- Deal pay = (versus ? max(guarantee, % + $/ticket) : guarantee + % + $/ticket) + bonuses. In a
  versus deal, bonuses sit on top of the versus amount.
- The pay cap (`hlCapOn`) limits everything the artist gets, bonuses included; backend comes last.
- Bonuses are left out of the contingency base and of `headlinerBreakEven`, like the other variable
  headliner parts.
- Break-even stays "first ticket count with net ≥ 0". The profit chart shows the drop at each bonus;
  if a bonus pushes net back below $0 after break-even, a short note under the chart says where.

### Everywhere else
- **Talent:** one row per bonus in the headliner payout ("Bonus: $500 at 300 tickets",
  "Bonus: $500 at sellout (245 tickets)", "Bonus: $500 at 80% sold (196 tickets)"). The deal
  wording lists them.
- **Costs:** one "Ticket bonuses" line under headliner pay (it is part of headliner pay, not added
  again).
- **Offer:** one line per bonus with the wording above.
- **Spreadsheet (`workbook.js`):** five fixed bonus slots on the Inputs tab (trigger, number, amount),
  as yellow cells feeding live formulas, so editing tickets, capacity or comps in the sheet moves
  the bonuses. Wired into the By-ticket-count table, Price math, Costs, Talent and Offer tabs and
  the True and Padded budgets, the way VJ/LD were in 84e537b. The artist-facing Offer tab shows each
  bonus as number cells (amount, pays at N tickets), not a sentence.
- **Links and saves:** `#s=` and `#q=` links and team-list saves round-trip the bonuses. `LINK_BASE`
  gains `hlBonusOn: false, hlBonuses: []`, so old links open with bonuses off and empty.

## Non-goals
Bonuses on anything but tickets sold (gross, net), more than 5 rows, partial or per-ticket bonuses.
