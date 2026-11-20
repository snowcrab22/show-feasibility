# Fee cap and headliner pay cap (short design)

## Intent
- **Fee cap:** the venue's ticketing platform caps its fee on each online ticket at $5.50. The calculator should be able to model that cap.
- **Headliner cap:** deals are often written like "$300 vs 80%, capped at $1,500". The calculator should be able to limit what the headliner earns to a maximum amount.

## Approaches
- **Fee cap.** Two readings were considered:
  - The platform's own maximum fee.
  - A limit on what buyers pay, with us covering anything above it.

  The user confirmed the first: the cap is set by the venue's ticketing platform.
- **Headliner cap.** Two options were considered:
  - Cap everything the deal pays.
  - Cap only the % and $/ticket parts.

  The user approved capping everything the deal pays (guarantee, %, $/ticket, backend), with travel and hospitality left outside the cap.

## Design
### Fee cap
- **New inputs:** `ebCapOn` (default **on**) and `ebCap` (default **$5.50**). They appear in the ticketing platform section as "Fees capped at $__ per ticket", with an on/off switch.
- **What the cap covers:** the whole online fee per ticket, meaning the service fee plus processing.
  - Pass mode: the cap applies to what the buyer pays.
  - Absorb mode: the cap applies to what we pay.
- **The calculation:**
  - `fee = min(uncapped fee, cap)`
  - Service and processing are each scaled down by the same factor, so the breakdown still adds up.
- **Not affected:**
  - Door card fees.
  - The platform preset detection, which still looks only at the three rates.
- **Default scenario:** at $25 the fee is $3.62, so the cap doesn't kick in and the default numbers are unchanged. In pass mode the cap starts to bind at a ticket price of about $51.50.

### Headliner cap
- **New inputs:** `hlCapOn` (default **off**) and `hlCap` (default **$1,500**). They appear in the headliner section as "Cap total pay at $__".
- **The effective cap** is `max(hlCap, guarantee)`. The cap never cuts into the guarantee.
- **The calculation:**
  - `deal pay = min(deal pay, cap)`, where deal pay is the guarantee plus the % and $/ticket parts, or the versus amount.
  - `backend = min(backend, cap − deal pay)`.
  - Travel and hospitality sit outside the cap.
- **Not affected:**
  - The headliner break-even and the contingency base, which already leave out the variable parts.
  - Preset detection.

### Everywhere else
- **Live spreadsheet:**
  - Yellow input cells for all four new inputs.
  - Every formula that works out a fee or the deal pay applies the caps. That includes the tickets tab, the by-ticket-count table and the Price math tab.
  - The deal wording adds "capped at $X".
  - The formula-built calculator link carries the new inputs.
- **Share links:** `LINK_BASE` gets `ebCapOn: false` and `hlCapOn: false`, so links made before today still open exactly as they did. New links carry the cap when it is on.
- **Text summary and Copy summary:**
  - The fees line shows "capped at $5.50/ticket" when the cap is on.
  - The deal line shows "capped at $1,500" when that cap is on.

## Left to the builder
- Exact labels and placement within each section.
- Test names.
