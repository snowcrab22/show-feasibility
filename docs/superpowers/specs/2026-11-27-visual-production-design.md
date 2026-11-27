# Visual production block (VJ + lighting designer)

Date: 2026-11-27. Status: requested by Quentin in chat ("split VJ from Support & VJ into its own
block, add LD alongside it, title it visual production"); details below proposed in chat, no objection.

## Intent
VJ isn't support talent; it belongs with a show's visual production, next to a new lighting designer
(LD) cost. Small change.

## Approaches
1. **Own ledger block in Costs, counted as production (chosen).** Matches "visual production"; the
   Costs section already renders on/off + amount blocks (Labor, Production), so no new UI pattern.
2. Own card in the Talent section, counted as talent. Keeps VJ where people look today, but LD isn't
   talent and the talent totals would keep mixing crew in.
3. A new "Visual" slice in the money breakdown. Needs a 9th chart colour in light and dark; folding
   into "Production & labor" reads fine.

## Design
- Inputs: `vjOn`/`vj` unchanged (saved scenarios and links keep their VJ); new `ldOn: false`, `ld: 300`.
- Talent section: "Support & VJ" card becomes "Support" (slots, price per slot).
- Costs section: new block "Visual production" after Production: VJ and "Lighting designer (LD)",
  each on/off + amount, with a block subtotal. VJ leaves the Talent rows of the cost ledger.
- Money: talent total = headliner all-in + support. Category `supportVj` becomes `support`
  ("Supporting artists"); VJ and LD join "Production & labor" (detail adds "visuals").
- Offer: `ld` is paddable like `vj` (OFFER_KEYS: ... "vj", "ld", ...; toggle `ldOn`).
- Links: `LINK_BASE` gains `ldOn: false, ld: 300`, so old `#s=` links open with LD off; `#q=` links
  carry LD automatically.
- Spreadsheet: Inputs "Support & VJ" heading becomes "Support"; new "Visual production" heading with
  VJ (VJFee/VJOn) and LD (LDFee/LDOn); budgets list VJ and LD under production; talent subtotal drops
  VJ; total costs, money categories, Offer tab, True and Padded budgets include LD. Every number
  stays a live formula that matches the model.

## Non-goals
Renaming saved keys (`vj` stays `vj`), a new chart colour.
