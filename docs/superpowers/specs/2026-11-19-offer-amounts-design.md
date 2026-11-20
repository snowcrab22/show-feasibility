# Offer amounts: padded costs, offer tab and budgets (short design)

## Intent
- The user plays with the real ("true") numbers in the calculator.
- They then pad some costs for the version shown to the artist's agent (the "offer").
- From one place, they want:
  - a link that carries both versions;
  - an Offer tab laid out like the KC PLUR offer template;
  - a true budget and a padded budget, laid out like the Atlas9 / Enter the Abyss sheets.
- This was first done by hand for one show. This design makes it repeatable.

## Approaches (the user picked A)
- **A. Offer amount beside each cost (picked).** One scenario, with optional offer overrides per cost plus offer-only lines. One link, one export.
- **B. Two whole scenarios.** Toggle between True and Offer versions of everything. More flexible, but a bigger change to the page and the links.
- **C. Minimal.** Add an Offer tab and a Budget tab for whatever is on screen, and export twice. Gives two files, not one.

## Design
### Inputs (model)
- `offerAmounts`: `{ key: amount }` for these keys:
  - `hlTravel`, `hlHospitality`, `supportPrice`, `vj`;
  - `soundTechPay`, `stagehandPay`;
  - `security`, `sound`, `gear`, `photo`;
  - `ads`, `poster`;
  - `insurance`, `venueRental`.

  A missing key means the offer uses the true amount. A cost that is off stays off in the offer.
- `offerExtra`: `[{ name, amount }]`, cost lines that only the offer has (e.g. production manager, backline, runners). Up to 50.
- `M.offerInputs(inp)` returns the offer scenario:
  - overrides applied;
  - `offerExtra` appended to `custom`;
  - both offer fields cleared.

  Everything else (tickets, deal, venue) is the same as the true scenario.

### Links
- `#s=` links carry the new fields automatically.
- `#q=` (readable) links add:
  - `o_<key>=<amount>` per override;
  - `x<i>=<name>~<amount>` per offer-only line.
- Links made before this change open with no offer amounts.

### Page
- New **Offer** tab between Costs and Share. It has:
  - **Offer costs:** one row per cost that's switched on, showing your real number and an offer input. The placeholder is the real number; blank means the same.
  - **Offer-only lines:** name + amount, add/remove.
  - **At a glance:**
    - offer net at the chosen count, next to the true net;
    - break-even, offer vs true;
    - promoter and artist at sell-out for the offer;
    - how much the offer adds to costs.
  - **Copy offer link:** a link that opens the padded numbers as a scenario of their own.
- The nav tab shows how much the offer adds to costs, e.g. "+$1,520".

### Export (live workbook)
- **Inputs:** a yellow "Offer (padded costs)" section (blank = same as the true amount) and 10 offer-only line rows. The calculator link built by formula carries them.
- **Offer math, live:**
  - offer fixed costs (contingency included);
  - a "past break-even" flag column for the offer on By ticket count;
  - offer headliner break-even;
  - offer deal and net at the chosen count and at sell-out.
- **Offer tab:**
  - laid out like the KC PLUR offer template, with sections 01–07;
  - the box office shows online and door at sell-out;
  - expenses use offer amounts;
  - artist and promoter earnings at sell-out come from the calculator's own deal math, so they match the page;
  - contact, show date, agency, city, deposit, radius and merch are fill-in cells; deposit, radius and merch start from the template wording;
  - no personal contact details are built into the code.
- **True budget** and **Padded budget** tabs:
  - Atlas9 style: everything on one tab, dark section bars, lavender header rows, Arial;
  - key numbers, then ticket sales at the chosen count;
  - expenses with payee / role / amount / paid / notes (headliner guarantee and bonus, every cost line, venue cut, fees we absorb, door card fees, contingency);
  - a summary whose net equals the calculator's.

## Calls made by the builder (not discussed with the user)
- **The offer lives on its own tab,** not as an extra column inside every cost row on the Costs tab. One renderer is less invasive, and phone layout is easier.
- **Custom lines are not padded individually;** offer-only lines cover additions.
- **The budget tabs show the break-even before the bonus** (the headliner break-even). That equals the show break-even unless a bonus starts from ticket 1.
- **The Google Drive "send to my Drive" flow is unchanged.** The new tabs ride along in the same workbook.

## Left out
- Offer amounts for individual custom lines.
- Offer changes to tickets or the deal.
