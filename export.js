/* Show Feasibility: shared wording and table rows, plus the spreadsheet export.
 * Works in the browser (window.ShowExport) and in Node (module.exports). No DOM, no ExcelJS dependency at load.
 *
 * Three layers:
 *   1. Row builders (perTicketRows, ticketMoneyRows, ...) used by both the page (app.js) and the export,
 *      so the wording lives in one place.
 *   2. buildSheets(inputs, n, Model, opts) -> plain description of every sheet (pure, computed from the model).
 *   3. writeWorkbook(ExcelJS, sheets) -> ExcelJS workbook (thin).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowExport = api;
})(this, function () {
  "use strict";

  var PAGE_URL = "https://snowcrab22.github.io/show-feasibility/";
  var SNAPSHOT_NOTE = "Numbers are a snapshot. Change inputs in the calculator and export again.";
  var MINUS = "−";

  // Frozen copy of the defaults when share links were introduced (v2). Never edit: links store only
  // the inputs that differ from this, so changing it would change what old links mean.
  var LINK_BASE = Object.freeze({
    venueName: "New venue",
    showName: "",
    capacity: 150,
    comps: 5,
    price: 25,
    expectedPct: 75,
    onlinePct: 50,
    doorPriceOn: true,
    doorPrice: 30,
    doorCashPct: 30,
    doorCardPct: 2.6,
    doorCardFixed: 0.15,
    taxOn: true,
    taxRate: 10,
    taxMode: "ontop",
    ticketPlatform: "Eventbrite",
    ebPreset: "eventbrite",
    ebServicePct: 3.7,
    ebServiceFixed: 1.79,
    ebProcPct: 2.9,
    ebMode: "pass",
    doorCutOn: true,
    doorCutPct: 15,
    doorCutBasis: "afterTax",
    venueRentalOn: false,
    venueRental: 0,
    venuePerHeadOn: false,
    venuePerHead: 0,
    hlPreset: "flatBonus",
    hlGuaranteeOn: true,
    hlGuarantee: 300,
    hlPctOn: false,
    hlPct: 20,
    hlPctBasis: "faceNet",
    hlPctStart: "first",
    hlPctStartN: 75,
    hlPerTicketOn: true,
    hlPerTicket: 5,
    hlPerTicketStart: "breakEven",
    hlPerTicketStartN: 75,
    hlBackendOn: false,
    hlBackendPct: 20,
    hlVersus: false,
    hlTravel: 90,
    hlHospitality: 50,
    supportSlots: 3,
    supportPrice: 75,
    vjOn: false,
    vj: 300,
    soundTechsOn: false,
    soundTechs: 1,
    soundTechPay: 150,
    stagehandsOn: false,
    stagehands: 2,
    stagehandPay: 100,
    securityOn: true,
    security: 100,
    soundOn: false,
    sound: 600,
    gearOn: false,
    gear: 50,
    photo: 0,
    ads: 80,
    poster: 75,
    insuranceOn: false,
    insurance: 357,
    contingencyPct: 5,
    custom: [],
    otherIncome: 0
  });

  // ---------------------------------------------------------------- formatting (shared with app.js)
  function fmt$(v, opts) {
    opts = opts || {};
    var cents = !!opts.cents;
    var neg = v < 0 && Math.abs(v) >= (cents ? 0.005 : 0.5);
    var s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    var sign = neg ? (opts.ascii ? "-" : MINUS) : (opts.plus && v >= 0.5 ? "+" : "");
    return sign + "$" + s;
  }
  function fmtCompact(v) {
    var a = Math.abs(v), neg = v <= -0.5;
    var s;
    if (a >= 9950) s = "$" + Math.round(a / 1000) + "K";
    else if (a >= 1000) s = "$" + (a / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    else s = "$" + Math.round(a);
    return (neg ? MINUS : "") + s;
  }
  function fmtPct(v, d) { return (v * 100).toFixed(d == null ? 0 : d) + "%"; }
  function fmtInt(v) { return Math.round(v).toLocaleString("en-US"); }
  function statusOf(net) { return Math.abs(net) < 0.5 ? "even" : net > 0 ? "profit" : "loss"; }
  var STATUS_LABEL = { profit: "Profit", loss: "Loss", even: "Break-even" };
  function priceText(v) { return fmt$(v, { cents: v % 1 !== 0 }); }
  function platName(inp) { var s = String(inp.ticketPlatform || "").trim(); return s || "the ticketing platform"; }
  function platLabel(inp) { var s = String(inp.ticketPlatform || "").trim(); return s || "Ticketing platform"; }

  // ---------------------------------------------------------------- light palette (index.html :root tokens)
  var LIGHT = {
    paper: "#f1f1ed", panel: "#fcfcfb", ink: "#18191b", ink2: "#55565a", line: "#dcdbd4", accent: "#2350b5",
    muted: "#898781", fieldLine: "#c9c8c0", accentWash: "#e6ecf8", axis: "#c3c2b7",
    good: "#0ca30c", warn: "#fab219", crit: "#d03b3b", goodText: "#006300", critText: "#b42828",
    s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100", s5: "#e87ba4", s6: "#008300", s7: "#6250d6", s8: "#e34948",
    segTax: "#a8a69f", segProfit: "#2b2b29",
    divNeg: "#e34948", divMid: "#f0efec", divPos: "#2a78d6",
    hmWeakText: "#0b0b0b", hmStrongText: "#ffffff",
    input: "#fdf6dc"
  };

  // ---------------------------------------------------------------- input schema (rendered by app.js, listed by the export)
  var BASIS_HL = [["grossFace", "Gross face (tickets x price)"], ["faceNet", "Face net of sales tax"], ["net", "Our net ticket revenue"]];
  var START = [["first", "From ticket 1"], ["breakEven", "After break-even"], ["afterN", "After N tickets"]];

  // Input groups by section. host = id of the section's input column.
  var SECTIONS = [
    { id: "g-tickets", host: "in-tickets", title: "Capacity & price", fields: [
      { k: "capacity", label: "Venue capacity", type: "int" },
      { k: "comps", label: "Comps / guest list", type: "int", hint: "Count toward attendance, not revenue." },
      { type: "readout", id: "sellable-readout", label: "Sellable tickets" },
      { k: "price", id: "f-price-tickets", mirror: true, label: "Ticket price", type: "money", hint: "Same as the price in the bar at the top." },
      { k: "doorPrice", toggle: "doorPriceOn", label: "Different price at the door", type: "money",
        hint: "Door tickets sell at this price; online tickets use the ticket price." }
    ] },
    { id: "g-channels", host: "in-tickets", title: "Online and door sales", fields: [
      { k: "onlinePct", label: "Sold online via {P}", type: "pct", hint: "The rest sell at the door." },
      { k: "doorCashPct", label: "Door sales paid in cash", type: "pct", hint: "Cash has no processing fee." },
      { pair: [
        { k: "doorCardPct", label: "Door card processing", type: "pct", step: 0.1 },
        { k: "doorCardFixed", label: "Plus per card ticket", type: "money", step: 0.01 }
      ], hint: "Card-reader rate on what the door buyer is charged." }
    ] },
    { id: "g-tax", host: "in-tickets", title: "Sales tax", fields: [
      { k: "taxOn", label: "Collect sales tax", type: "check" },
      { k: "taxRate", label: "Sales tax rate", type: "pct", step: 0.001, dependsOn: "taxOn",
        note: "Combined rate for the venue's address. In Missouri, look it up on the Department of Revenue rate lookup." },
      { k: "taxMode", label: "Sales tax is", type: "select", dependsOn: "taxOn", options: [["included", "Included in price"], ["ontop", "Added on top (buyer pays extra)"]] }
    ] },
    { id: "g-platform", host: "in-tickets", title: "Ticketing platform", fields: [
      { k: "ebPreset", label: "Rates preset", type: "select", options: [["eventbrite", "Eventbrite (US rates)"], ["custom", "Custom"]],
        hint: "Picking a preset fills in the rates below. Editing a rate switches to Custom." },
      { k: "ticketPlatform", label: "Platform name", type: "text" },
      { k: "ebMode", label: "{P} fees", type: "select", options: [["pass", "Pass fees to buyer"], ["absorb", "Absorb fees (included in price)"]] },
      { pair: [
        { k: "ebServicePct", label: "Service fee", type: "pct", step: 0.1 },
        { k: "ebServiceFixed", label: "Plus per ticket", type: "money", step: 0.01 }
      ] },
      { k: "ebProcPct", label: "Payment processing", type: "pct", step: 0.1,
        note: "The Eventbrite preset uses its US rates as of Nov 2026 (service 3.7% + $1.79, processing 2.9%). Rates change; check the platform's pricing page." }
    ] },
    { id: "g-venue", host: "in-venue", title: "Venue deal", hint: "Turn on each part the venue charges. The parts add up.", fields: [
      { k: "doorCutPct", toggle: "doorCutOn", label: "% of door (ticket sales)", type: "pct", step: 0.5 },
      { k: "doorCutBasis", label: "% of door is taken from", type: "select", dependsOn: "doorCutOn", options: [
        ["afterTax", "After sales tax, before fees"],
        ["afterTaxFees", "After tax and ticketing fees"],
        ["gross", "Gross, including tax"]
      ], note: "After sales tax, before fees: ticket sales after sales tax, before ticketing fees. After tax and ticketing fees: also minus the ticketing fees and door card processing we pay. Gross: gross face value, sales tax included. Confirm with the venue what the percentage is taken from. Applies to online and door tickets." },
      { k: "venueRental", toggle: "venueRentalOn", label: "Flat rental / fee", type: "money" },
      { k: "venuePerHead", toggle: "venuePerHeadOn", label: "Per-head fee", type: "money", step: 0.25,
        hint: "Charged for each person in the room, comps included." }
    ] },
    { id: "g-hl", host: "in-talent", title: "Headliner deal", fields: [
      { k: "hlPreset", label: "Deal preset", type: "select", options: [
        ["flat", "Flat guarantee"], ["pct", "% of ticket sales"], ["perTicket", "$ per ticket"],
        ["flatBackend", "Flat + backend (% of profit)"],
        ["flatBonus", "Flat + per-ticket bonus"],
        ["versus", "Versus (guarantee or %)"], ["custom", "Custom"]
      ], hint: "A preset only sets the toggles below; amounts stay as typed." },
      { k: "hlGuarantee", toggle: "hlGuaranteeOn", label: "Guarantee (flat)", type: "money" },
      { group: "hlPctOn", fields: [
        { k: "hlPct", toggle: "hlPctOn", label: "% of ticket sales", type: "pct", step: 1 },
        { k: "hlPctBasis", label: "% of", type: "select", options: BASIS_HL, dependsOn: "hlPctOn" },
        { k: "hlPctStart", label: "Starts", type: "select", options: START, dependsOn: "hlPctOn" },
        { k: "hlPctStartN", label: "After how many tickets", type: "int", dependsOn: "hlPctOn", showIf: function (s) { return s.hlPctStart === "afterN"; } }
      ] },
      { group: "hlPerTicketOn", fields: [
        { k: "hlPerTicket", toggle: "hlPerTicketOn", label: "$ per ticket sold", type: "money", step: 0.5 },
        { k: "hlPerTicketStart", label: "Starts", type: "select", options: START, dependsOn: "hlPerTicketOn" },
        { k: "hlPerTicketStartN", label: "After how many tickets", type: "int", dependsOn: "hlPerTicketOn", showIf: function (s) { return s.hlPerTicketStart === "afterN"; } }
      ] },
      { k: "hlBackendPct", toggle: "hlBackendOn", label: "Backend: % of profit after break-even", type: "pct", step: 1 },
      { k: "hlVersus", label: "Versus: pay the greater of the guarantee or the % and per-ticket parts", type: "check",
        hint: "Backend is still added on top. Starting points apply only to tickets beyond them." }
    ] },
    { id: "g-hl-travel", host: "in-talent", title: "Headliner travel & hospitality", fields: [
      { pair: [
        { k: "hlTravel", label: "Travel / hotel", type: "money" },
        { k: "hlHospitality", label: "Hospitality / rider", type: "money" }
      ] }
    ] },
    { id: "g-lineup", host: "in-talent", title: "Support & VJ", fields: [
      { pair: [
        { k: "supportSlots", label: "Supporting slots", type: "int" },
        { k: "supportPrice", label: "Price per slot", type: "money" }
      ] },
      { k: "vj", toggle: "vjOn", label: "VJ", type: "money" }
    ] }
  ];

  // Cost ledger groups (Costs section).
  // Crew rows (people x pay each): k = people key, pay = pay key, line = fixedCosts line.
  var LEDGER = [
    { id: "labor", title: "Labor", rows: [
      { k: "soundTechs", pay: "soundTechPay", line: "soundTechs", toggle: "soundTechsOn", label: "Sound techs" },
      { k: "stagehands", pay: "stagehandPay", line: "stagehands", toggle: "stagehandsOn", label: "Stagehands" }
    ] },
    { id: "production", title: "Production", rows: [
      { k: "security", toggle: "securityOn", label: "Contracted security (flat)" },
      { k: "sound", toggle: "soundOn", label: "Sound rental" },
      { k: "gear", toggle: "gearOn", label: "Additional deck / gear" },
      { k: "photo", label: "Photo / video" }
    ] },
    { id: "marketing", title: "Marketing", rows: [
      { k: "ads", label: "Advertising budget" },
      { k: "poster", label: "Poster design" }
    ] },
    { id: "insurance", title: "Insurance", rows: [
      { k: "insurance", toggle: "insuranceOn", label: "Event insurance" }
    ] }
  ];
  function ledgerLineValue(f, L) { return L[f.line || f.k]; }
  function crewLabel(f, inp) { return f.label + " (" + inp[f.k] + " x " + fmt$(inp[f.pay]) + ")"; }
  var CONTINGENCY_HINT = "% of all other costs, not counting headliner %, per-ticket, versus or backend pay, the venue's % of door or the per-head fee.";

  // ---------------------------------------------------------------- shared wording
  var CUT_SHORT = { afterTax: "ticket sales after tax", afterTaxFees: "ticket sales after tax and fees", gross: "gross face incl. tax" };
  var HL_BASIS_SHORT = { grossFace: "gross face", faceNet: "face net of tax", net: "our net ticket revenue" };
  function startText(start, N) { return start === "first" ? "from ticket 1" : start === "breakEven" ? "after break-even" : "after " + N + " tickets"; }
  function hlDescription(inp) {
    var parts = [];
    if (inp.hlGuaranteeOn) parts.push(fmt$(inp.hlGuarantee, { ascii: true }) + " guarantee");
    var v = [];
    if (inp.hlPctOn) v.push(inp.hlPct + "% of " + HL_BASIS_SHORT[inp.hlPctBasis] + " " + startText(inp.hlPctStart, inp.hlPctStartN));
    if (inp.hlPerTicketOn) v.push(fmt$(inp.hlPerTicket, { cents: inp.hlPerTicket % 1 !== 0 }) + "/ticket " + startText(inp.hlPerTicketStart, inp.hlPerTicketStartN));
    var s = inp.hlVersus ? parts.concat(v).join(" vs ") : parts.concat(v).join(" + ");
    if (inp.hlBackendOn) s += (s ? " + " : "") + inp.hlBackendPct + "% backend";
    return s || "no pay set";
  }
  function venueDescription(inp, ascii) {
    var parts = [];
    if (inp.doorCutOn) parts.push(inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis]);
    if (inp.venueRentalOn) parts.push(fmt$(inp.venueRental, { ascii: ascii }) + " rental");
    if (inp.venuePerHeadOn) parts.push(fmt$(inp.venuePerHead, { cents: inp.venuePerHead % 1 !== 0 }) + " per head");
    return parts.join(" + ") || "nothing";
  }
  function talentTotal(r) { return r.headliner.total + r.costs.support + r.costs.vj; }

  // Everything the page shows for one scenario.
  function bundle(inputs, n, M) {
    var inp = M.sanitize(inputs);
    var S = M.sellable(inp);
    n = Math.max(0, Math.min(S, Math.round(+n) || 0));
    var hlBE = M.headlinerBreakEven(inp);
    var r = M.compute(inp, n, { hlBE: hlBE });
    var scen = [25, 50, 75, 90, 100].map(function (p) {
      return { pct: p, r: M.compute(inp, Math.round(S * p / 100), { hlBE: hlBE }) };
    });
    return {
      inp: inp, r: r, S: S, hlBE: hlBE,
      be: M.breakEven(inp), bePrice: M.breakEvenPrice(inp, n), sw: M.sweep(inp),
      scen: scen, soldOut: M.compute(inp, S, { hlBE: hlBE })
    };
  }

  // Rows are { label, v, t: 'money'|'int'|'pct'|'text', cls: ''|'sub'|'total', off }.
  function R(label, v, t, cls, extra) {
    var o = { label: label, v: v, t: t || "money", cls: cls || "" };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  function OFF(label, cls) { return { label: label, v: "off", t: "text", cls: cls || "", off: true }; }

  // Overview tiles / headline numbers.
  function headlineRows(b) {
    var r = b.r, S = b.S, inp = b.inp, st = statusOf(r.net), out = [];
    out.push(R("Net at " + r.n + " tickets", r.net, "money", "total", { key: "net", status: st, signed: true, display: fmt$(r.net, { plus: true }),
      sub: "Net ticket revenue " + fmt$(r.netTicketRevenue) + " minus costs " + fmt$(r.totalCosts) + (r.otherIncome ? " plus other income " + fmt$(r.otherIncome) : "") }));
    if (b.be === null) out.push(R("Show break-even", "Not possible", "text", "", { key: "be", sub: "Can't break even at this price, even sold out" }));
    else out.push(R("Show break-even", b.be, "int", "", { key: "be", display: b.be + " tickets", unit: "tickets",
      sub: fmtPct(b.be / Math.max(1, S)) + " of " + S + " sellable" + (b.be > r.n ? ", " + (b.be - r.n) + " more than now" : "") }));
    var bp = b.bePrice;
    out.push(R("Break-even price at " + r.n + " sold", bp === null ? "None" : bp, bp === null ? "text" : "money", "", { key: "bePrice",
      display: bp === null ? "None" : fmt$(bp, { cents: true }),
      sub: bp === null ? (r.n === 0 ? "No price works with 0 tickets sold" : "Even $1,000 a ticket loses") : (bp <= inp.price ? "At or under your " + priceText(inp.price) + " price" : fmt$(bp - inp.price, { cents: true }) + " above your price") }));
    var h = r.headliner, hsub = [];
    if (h.versus) {
      hsub.push("greater of guarantee " + fmt$(h.guarantee) + " or " + fmt$(h.pctPart + h.perTicketPart) + " in % and per-ticket");
    } else {
      if (h.guarantee) hsub.push("guarantee " + fmt$(h.guarantee));
      if (h.pctPart) hsub.push("% part " + fmt$(h.pctPart));
      if (h.perTicketPart) hsub.push("per ticket " + fmt$(h.perTicketPart));
    }
    if (h.backend) hsub.push("backend " + fmt$(h.backend));
    out.push(R("Headliner payout", h.pay, "money", "", { key: "hl", display: fmt$(h.pay), sub: (h.versus ? "Versus: " : "") + (hsub.join(", ") || "nothing owed at this count") }));
    out.push(R("Buyer pays at checkout (online)", r.buyerPaysOnline, "money", "", { key: "buyer", display: fmt$(r.buyerPaysOnline, { cents: true }),
      sub: "Door " + fmt$(r.buyerPaysDoor, { cents: true }) + "; " + platLabel(inp) + " fees " + (inp.ebMode === "pass" ? "passed to buyer" : "absorbed by us") }));
    return out;
  }

  // "Where the money goes" categories. color = page token, hex = light-palette value for the sheet.
  var CATS = [
    { k: "tax", name: "Sales tax", detail: "to the state", color: "var(--seg-tax)", text: "var(--seg-tax-text)", hex: LIGHT.segTax },
    { k: "ebFees", name: "{P} fees", detail: "", color: "var(--s1)", hex: LIGHT.s1 },
    { k: "doorProc", name: "Door card processing", detail: "", color: "var(--s2)", hex: LIGHT.s2 },
    { k: "venue", name: "Venue", detail: "% of door, rental, per-head", color: "var(--s3)", hex: LIGHT.s3 },
    { k: "headliner", name: "Headliner", detail: "pay, travel, rider", color: "var(--s4)", text: "#0b0b0b", hex: LIGHT.s4 },
    { k: "supportVj", name: "Support + VJ", detail: "", color: "var(--s5)", hex: LIGHT.s5 },
    { k: "production", name: "Production & labor", detail: "sound, security, gear, crew", color: "var(--s6)", hex: LIGHT.s6 },
    { k: "marketing", name: "Marketing", detail: "", color: "var(--s7)", hex: LIGHT.s7 },
    { k: "other", name: "Other costs and contingency", detail: "", color: "var(--s8)", hex: LIGHT.s8 },
    { k: "profit", name: "Profit", detail: "ours", color: "var(--seg-profit)", text: "var(--seg-profit-text)", hex: LIGHT.segProfit }
  ];
  function catName(c, inp) { return c.name.replace("{P}", platLabel(inp)); }
  function catLabel(c, inp) { return catName(c, inp) + (c.detail ? " (" + c.detail + ")" : ""); }

  // Rows of the money table: { cat, name, detail, label, v, share, perTicket, cls }.
  function moneyRows(r, inp) {
    var loss = r.money.loss, whole = r.inflow + loss, out = [];
    CATS.forEach(function (c) {
      if (c.k === "profit" && loss > 0) return;
      var v = r.money[c.k];
      out.push({ cat: c, name: catName(c, inp), detail: c.detail, label: catLabel(c, inp), v: v, share: whole > 0 ? v / whole : 0, perTicket: r.perTicket[c.k], cls: "" });
    });
    if (loss > 0.005) {
      out.push({ cat: null, name: "Loss", detail: "costs not covered", label: "Loss (costs not covered)", v: -loss, share: whole > 0 ? -loss / whole : 0, perTicket: -r.perTicket.loss, cls: "loss" });
    }
    out.push({ cat: null, name: "Buyers paid" + (r.otherIncome ? " + other income" : ""), detail: "", label: "Buyers paid" + (r.otherIncome ? " + other income" : ""),
      v: r.inflow, share: null, perTicket: r.n ? r.inflow / r.n : 0, cls: "total" });
    return out;
  }

  function scenarioRows(b) {
    return b.scen.map(function (s) {
      return { pct: s.pct, sold: s.pct === 100 ? "Sold out" : s.pct + "%", n: s.r.n, netTix: s.r.netTicketRevenue, hlPay: s.r.headliner.pay, costs: s.r.totalCosts, net: s.r.net };
    });
  }

  var HEAT_PRICES = [15, 20, 25, 30, 35, 40];
  var HEAT_PCTS = [25, 50, 75, 90, 100];
  function heatGrid(inp, M) {
    var S = M.sellable(inp), maxAbs = 1;
    var rows = HEAT_PCTS.map(function (p) {
      var n = Math.round(S * p / 100);
      return { p: p, n: n, cells: HEAT_PRICES.map(function (price) {
        var net = M.compute(M.withPrice(inp, price), n).net;
        maxAbs = Math.max(maxAbs, Math.abs(net));
        return { price: price, net: net };
      }) };
    });
    rows.forEach(function (row) { row.cells.forEach(function (c) { c.t = Math.min(1, Math.abs(c.net) / maxAbs); }); });
    return { prices: HEAT_PRICES, rows: rows, maxAbs: maxAbs };
  }

  // color-mix(in oklab, mid, pole pct%) reimplemented for the sheet (fixed light palette).
  function hexToRgb(h) { h = h.replace("#", ""); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); }
  function toLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function fromLin(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  function rgbToOklab(rgb) {
    var r = toLin(rgb[0]), g = toLin(rgb[1]), b = toLin(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function oklabToRgb(lab) {
    var l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
    var m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
    var s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2], 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(function (c) { return Math.max(0, Math.min(1, fromLin(c))); });
  }
  function mixOklab(hexA, hexB, pctB) {
    var a = rgbToOklab(hexToRgb(hexA)), b = rgbToOklab(hexToRgb(hexB)), t = pctB / 100;
    var rgb = oklabToRgb([0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * t; }));
    return "#" + rgb.map(function (c) { var h = Math.round(c * 255).toString(16); return h.length < 2 ? "0" + h : h; }).join("");
  }
  function heatColor(cell) {
    var pct = Math.round(cell.t * 100);
    return { fill: mixOklab(LIGHT.divMid, cell.net >= 0 ? LIGHT.divPos : LIGHT.divNeg, pct), text: cell.t > 0.55 ? LIGHT.hmStrongText : LIGHT.hmWeakText };
  }

  function perTicketRows(r, inp) {
    var p = r.perTicketPrices, pn = platLabel(inp), out = [];
    out.push(R("Ours after sales tax", p.faceNet));
    out.push(R("Sales tax " + (inp.taxOn ? (inp.taxMode === "included" ? "(inside the price)" : "(added on top)") : "(off)"), p.tax));
    out.push(R(pn + " service fee", p.ebService, "money", "sub"));
    out.push(R(pn + " processing", p.ebProc, "money", "sub"));
    out.push(R(pn + " fees " + (inp.ebMode === "pass" ? "paid by the buyer" : "absorbed by us"), p.ebFee));
    out.push(R("Buyer pays online", p.onlineBuyer, "money", "total"));
    if (inp.doorPriceOn) {
      out.push(R("Door face price", p.doorPrice));
      out.push(R("Door: ours after sales tax", p.doorFaceNet, "money", "sub"));
      out.push(R("Door: sales tax", p.doorTax, "money", "sub"));
    }
    out.push(R("Door card fee (card buyers)", p.doorCardProc));
    out.push(R("Buyer pays at the door", p.doorBuyer, "money", "total"));
    var lab = "We keep per ticket sold, after fees and the venue's cut";
    out.push(r.n ? R(lab, r.netTicketRevenue / r.n) : R(lab, "n/a", "text"));
    return out;
  }

  function ticketMoneyRows(r, inp) {
    var c = r.counts, pn = platLabel(inp), out = [];
    out.push(R("Online (" + pn + ")", c.online + " tickets", "text"));
    out.push(R("Door", c.door + " tickets (" + c.doorCash + " cash, " + c.doorCard + " card)", "text"));
    out.push(R("Buyers paid online", r.buyersPaidOnline, "money", "sub"));
    out.push(R("Buyers paid at the door", r.buyersPaidDoor, "money", "sub"));
    out.push(R("Everything buyers paid", r.buyersPaid, "money", "total"));
    out.push(R("Sales tax collected (to the state)", -r.tax));
    out.push(R(pn + " fees paid by buyers", -r.eventbrite.passed));
    out.push(R("Ticket sales after tax", r.faceNet, "money", "total"));
    out.push(R(pn + " fees we absorb", -r.eventbrite.absorbed));
    out.push(R("Door card processing", -r.doorProc));
    if (inp.doorCutOn) out.push(R("Venue " + inp.doorCutPct + "% of door (of " + fmt$(r.doorCutBasis) + ")", -r.venue.doorCut));
    if (inp.venuePerHeadOn) out.push(R("Venue per-head fee (" + r.attending + " in the room)", -r.venue.perHead));
    out.push(R("Net ticket revenue (ours)", r.netTicketRevenue, "money", "total"));
    return out;
  }

  function headlinerRows(r, inp, hlBE) {
    var h = r.headliner, out = [], C = { cents: true };
    out.push(R("Deal", hlDescription(inp), "text", "", { wrap: true }));
    out.push(inp.hlGuaranteeOn ? R("Guarantee", h.guarantee) : OFF("Guarantee"));
    function beyond(th) { return th > 0 ? " beyond " + (isFinite(th) ? th + " tickets" : "break-even (never reached)") : ""; }
    if (inp.hlPctOn) out.push(R(inp.hlPct + "% of " + HL_BASIS_SHORT[inp.hlPctBasis] + beyond(h.pctThreshold), h.pctPart));
    if (inp.hlPerTicketOn) out.push(R(fmt$(inp.hlPerTicket, C) + " per ticket" + beyond(h.perTicketThreshold), h.perTicketPart));
    if (inp.hlVersus) out.push(R("Versus: greater of guarantee or the parts above", h.dealPay, "money", "sub"));
    if (inp.hlBackendOn) out.push(R(inp.hlBackendPct + "% backend of " + fmt$(Math.max(0, r.netBeforeBackend)) + " profit", h.backend));
    out.push(R("Headliner pay", h.pay, "money", "total"));
    out.push(R("Travel / hotel", h.travel, "money", "sub"));
    out.push(R("Hospitality / rider", h.hospitality, "money", "sub"));
    out.push(R("Headliner all-in", h.total, "money", "total"));
    out.push(R("Headliner break-even (guarantee and all other costs, no bonus parts)", hlBE === null ? "never" : hlBE + " tickets", "text"));
    return out;
  }

  function talentRows(r, inp) {
    var L = r.costs, out = [];
    out.push(R("Headliner all-in (pay, travel, rider)", r.headliner.total));
    out.push(R("Supporting artists (" + inp.supportSlots + " x " + fmt$(inp.supportPrice) + ")", L.support));
    out.push(inp.vjOn ? R("VJ", L.vj) : OFF("VJ"));
    out.push(R("Total talent cost", talentTotal(r), "money", "total"));
    return out;
  }

  // Venue rows: { label, on, now, out, cls }
  function venueRows(r, so, inp) {
    return [
      { label: inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis], on: inp.doorCutOn, now: r.venue.doorCut, out: so.venue.doorCut, cls: "" },
      { label: "Flat rental / fee", on: inp.venueRentalOn, now: r.venue.rental, out: so.venue.rental, cls: "" },
      { label: fmt$(inp.venuePerHead, { cents: true }) + " per head (" + r.attending + " / " + so.attending + " in the room)", on: inp.venuePerHeadOn, now: r.venue.perHead, out: so.venue.perHead, cls: "" },
      { label: "Venue takes", on: true, now: r.venue.total, out: so.venue.total, cls: "total" }
    ];
  }

  // Costs by category: same grouping as the ledger (photo / video sits in Production).
  function costCategoryRows(r) {
    var L = r.costs;
    var rows = [
      R("Talent", talentTotal(r)),
      R("Venue rental", L.venueRental),
      R("Labor", L.soundTechs + L.stagehands),
      R("Production", L.security + L.sound + L.gear + L.photo),
      R("Marketing", L.ads + L.poster),
      R("Insurance", L.insurance),
      R("Custom", L.custom),
      R("Contingency", r.contingency)
    ];
    rows.push(R("Total costs", r.totalCosts, "money", "total"));
    return rows;
  }

  // Full ledger for the sheet: { group, rows: [{label, v, t, cls, role, input}] }.
  // role: 'line' (adds to total costs), 'info' (shown, not counted), 'subtotal'.
  function ledgerGroups(r, inp) {
    var L = r.costs, h = r.headliner, groups = [];
    function line(label, v, on, input) {
      return on === false ? { label: label, v: "off", t: "text", off: true, role: "line", amount: 0 } : { label: label, v: v, t: "money", role: "line", input: !!input, amount: v };
    }
    groups.push({ title: "Talent", rows: [
      line("Headliner pay", h.pay),
      line("Headliner travel / hotel and hospitality", L.headlinerTravel + L.headlinerHospitality),
      line("Supporting artists (" + inp.supportSlots + " x " + fmt$(inp.supportPrice) + ")", L.support),
      line("VJ", L.vj, inp.vjOn)
    ], subtotal: { label: "Talent subtotal", v: talentTotal(r) } });
    var taken = r.venue.doorCut + r.venue.perHead;
    groups.push({ title: "Venue", rows: [
      line("Flat rental / fee", L.venueRental, inp.venueRentalOn),
      (inp.doorCutOn || inp.venuePerHeadOn)
        ? { label: "% of door and per-head fee (already out of ticket revenue, not counted again)", v: taken, t: "money", role: "info" }
        : { label: "% of door and per-head fee (already out of ticket revenue, not counted again)", v: "off", t: "text", off: true, role: "info" }
    ], subtotal: { label: "Venue rental subtotal", v: L.venueRental } });
    LEDGER.forEach(function (g) {
      var sub = 0;
      groups.push({ title: g.title, rows: g.rows.map(function (f) {
        var on = f.toggle ? !!inp[f.toggle] : true;
        var v = ledgerLineValue(f, L);
        if (on) sub += v;
        return line(f.pay ? crewLabel(f, inp) : f.label, v, on ? undefined : false, !f.pay);
      }), subtotal: { label: g.title + " subtotal", v: sub } });
    });
    groups.push({ title: "Custom cost lines", rows: inp.custom.map(function (c, i) {
      return line(String(c.name || "").trim() || "Cost line " + (i + 1), c.amount, undefined, true);
    }), subtotal: { label: "Custom cost lines subtotal", v: L.custom } });
    return groups;
  }

  // Same {v: 1, inputs, n} shape and base64-of-UTF-8 encoding as the page's scenario code.
  function b64Utf8(str) {
    if (typeof Buffer !== "undefined" && typeof window === "undefined") return Buffer.from(str, "utf8").toString("base64");
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function encodeScenario(inputs, n, M) {
    return b64Utf8(JSON.stringify({ v: 1, inputs: M.sanitize(inputs), n: n }));
  }

  // Share links: PAGE_URL#s=<base64url JSON {v:2, d: inputs that differ from LINK_BASE, n}>.
  // Saved files: PAGE_URL#f=<Drive file id>. Old v1 codes are base64 JSON {v:1, inputs, n}.
  function sameVal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function b64urlEncode(str) { return b64Utf8(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function b64Decode(b64) {
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error("not base64");
    if (typeof Buffer !== "undefined" && typeof window === "undefined") return Buffer.from(b64, "base64").toString("utf8");
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  function encodeLink(inputs, n, M) {
    var inp = M.sanitize(inputs), d = {};
    Object.keys(inp).forEach(function (k) {
      var base = Object.prototype.hasOwnProperty.call(LINK_BASE, k) ? LINK_BASE[k] : M.DEFAULTS[k];
      if (!sameVal(inp[k], base)) d[k] = inp[k];
    });
    return PAGE_URL + "#s=" + b64urlEncode(JSON.stringify({ v: 2, d: d, n: n }));
  }
  function decodeShared(text, M) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return null;
    var f = /(?:^|[#&])f=([A-Za-z0-9_-]{10,})/.exec(t);
    if (f) return { fileId: f[1] };
    var s = /(?:^|[#&])s=([A-Za-z0-9_-]*)/.exec(t);
    try {
      if (s) {
        var o = JSON.parse(b64Decode(s[1]));
        if (!o || o.v !== 2 || typeof o.d !== "object") return null;
        return { kind: "link", inputs: M.sanitize(Object.assign({}, LINK_BASE, o.d)), n: Math.max(0, Math.round(+o.n) || 0) };
      }
      var raw = t.replace(/\s+/g, "");
      var obj;
      try { obj = JSON.parse(b64Decode(raw)); }
      catch (e) { obj = JSON.parse(b64Decode(raw.slice(0, raw.lastIndexOf("=") + 1))); } // stray text pasted after the padding
      if (!obj || !obj.inputs) return null;
      return { kind: "code", inputs: M.sanitize(obj.inputs), n: obj.n == null ? null : Math.max(0, Math.round(+obj.n) || 0) };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- sheet description
  var FMT = {
    money: "$#,##0.00;-$#,##0.00",
    money0: "$#,##0;-$#,##0",
    signed0: "+$#,##0;-$#,##0;$0",
    signed: "+$#,##0.00;-$#,##0.00;$0.00",
    int: "0",
    pct: "0.0%",
    pctIn: "0.0##%"
  };
  function cell(v, t, style, extra) {
    var c = { v: v, t: t || (typeof v === "number" ? "money" : "text") };
    if (style) c.style = style;
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) c[k] = extra[k]; });
    return c;
  }
  function txt(v, style, extra) { return cell(v, "text", style, extra); }

  function localDate(d) {
    d = d || new Date();
    function p(x) { return (x < 10 ? "0" : "") + x; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function showVenueLine(inp) {
    var show = String(inp.showName || "").trim(), venue = String(inp.venueName || "").trim() || "New venue";
    return (show ? show + " at " : "") + venue;
  }

  function topBlock(title, ctx, ncols) {
    var inp = ctx.inp;
    return [
      [txt(title, "title")],
      [txt(showVenueLine(inp), "label", { bold: true })],
      [txt("Snapshot at " + ctx.r.n + " tickets, " + priceText(inp.price) + " ticket" + (inp.doorPriceOn ? " (" + priceText(inp.doorPrice) + " at the door)" : "") + ". Exported " + ctx.date + ".", "muted")],
      [cell(PAGE_URL, "link", "muted")],
      [txt(SNAPSHOT_NOTE + " Shaded cells are inputs.", "muted")],
      []
    ];
  }
  var TOP_ROWS = 5;
  function heading(text, ncols) { return [txt(text, "heading", { span: ncols })]; }
  function blank() { return []; }

  function clsStyle(cls) { return cls === "total" ? "total" : cls === "sub" ? "muted" : "label"; }

  // Two-column table (label | value) from shared rows, starting at column `col` (0-based).
  function pairRows(rows, col, opts) {
    opts = opts || {};
    return rows.map(function (rw) {
      var st = rw.cls === "total" ? "total" : rw.cls === "sub" ? "label" : "label";
      var lab = txt(rw.label, st, { indent: rw.cls === "sub" ? 1 : undefined, color: rw.cls === "sub" ? LIGHT.ink2 : undefined, wrap: rw.wrap && opts.wrapLabels ? true : undefined });
      var val;
      if (rw.off) val = txt("off", st, { color: LIGHT.muted, align: "right" });
      else if (rw.t === "text") val = txt(String(rw.v), st, { align: "right", color: rw.cls === "sub" ? LIGHT.ink2 : undefined, wrap: rw.wrap ? true : undefined });
      else val = cell(rw.v, rw.t, st, { color: rw.cls === "sub" ? LIGHT.ink2 : undefined });
      var row = [];
      for (var i = 0; i < col; i++) row.push(null);
      row.push(lab, val);
      return row;
    });
  }

  // Input rows for one section host (label | value | on/off).
  function fieldValue(f, inp) {
    if (f.type === "select") {
      var o = f.options.filter(function (x) { return x[0] === inp[f.k]; })[0];
      return txt(o ? o[1] : String(inp[f.k]), "input");
    }
    if (f.type === "check") return txt(inp[f.k] ? "Yes" : "No", "input");
    if (f.type === "text") return txt(String(inp[f.k] || ""), "input");
    if (f.type === "pct") return cell(inp[f.k] / 100, "pct", "input", { fmt: FMT.pctIn });
    if (f.type === "int") return cell(inp[f.k], "int", "input");
    return cell(inp[f.k], "money", "input");
  }
  function fieldLabel(label, inp) { return String(label).replace("{P}", platLabel(inp)); }
  function inputRowsFor(host, inp, S, opts) {
    opts = opts || {};
    var rows = [];
    function addField(f) {
      if (f.pair) { f.pair.forEach(addField); return; }
      if (f.group) { f.fields.forEach(addField); return; }
      if (f.showIf && !f.showIf(inp) && !opts.all) return;
      if (f.type === "readout") { rows.push([txt(f.label, "label"), cell(S, "int", "label")]); return; }
      var dimmed = (f.dependsOn && !inp[f.dependsOn]) || (f.toggle && !inp[f.toggle]);
      var lab = txt(fieldLabel(f.label, inp), "label", { color: dimmed ? LIGHT.muted : undefined });
      var row = [lab, fieldValue(f, inp)];
      if (f.toggle) row.push(txt(inp[f.toggle] ? "on" : "off", "input", { color: inp[f.toggle] ? undefined : LIGHT.muted, align: "center" }));
      rows.push(row);
    }
    SECTIONS.forEach(function (s) {
      if (host && s.host !== host) return;
      rows.push([txt(s.title, "subhead", { span: 3 })]);
      s.fields.forEach(addField);
      if (!opts.compact) rows.push(blank());
    });
    return rows;
  }

  function buildSheets(inputs, n, Model, opts) {
    opts = opts || {};
    var M = Model;
    var b = bundle(inputs, n, M);
    var inp = b.inp, r = b.r, S = b.S;
    var ctx = { inp: inp, r: r, date: opts.date ? (typeof opts.date === "string" ? opts.date : localDate(opts.date)) : localDate() };
    var sheets = [];

    // 1. Overview ---------------------------------------------------------------
    (function () {
      var W = 8, rows = topBlock("Overview", ctx, W);
      rows.push(heading("Headline numbers", W));
      headlineRows(b).forEach(function (h) {
        var st = h.key === "net" ? "total" : "label";
        var v;
        if (h.t === "text") v = txt(h.v, st, { align: "right" });
        else if (h.key === "net") v = cell(h.v, "money", "total", { fmt: FMT.signed0, sign: true });
        else if (h.t === "int") v = cell(h.v, "int", st);
        else v = cell(h.v, "money", st, { fmt: h.key === "hl" ? FMT.money0 : FMT.money });
        rows.push([null, txt(h.label, st), v, txt(h.sub, "muted")]);
      });
      rows.push([null, txt("Buyer pays at the door", "label"), cell(r.buyerPaysDoor, "money", "label"), txt(inp.doorPriceOn ? "Door price " + priceText(inp.doorPrice) + " plus any on-top tax" : "Same face price as online, plus any on-top tax", "muted")]);
      rows.push(blank());

      rows.push(heading("Where the money goes", W));
      rows.push([null, txt("At " + r.n + " tickets: buyers paid " + fmt$(r.buyersPaid) + (r.otherIncome ? " plus " + fmt$(r.otherIncome) + " other income" : ""), "muted")]);
      rows.push([null, txt("Goes to", "subhead"), txt("Amount", "subhead", { align: "right" }), txt("Share", "subhead", { align: "right" }), txt("Per ticket sold", "subhead", { align: "right" })]);
      moneyRows(r, inp).forEach(function (m) {
        var st = m.cls === "total" ? "total" : "label";
        var col = m.cls === "loss" ? LIGHT.critText : undefined;
        rows.push([
          m.cat ? txt("", "label", { fill: m.cat.hex }) : null,
          txt(m.label, st, { color: col }),
          cell(m.v, "money", st, { color: col, tag: "money-goes", kind: m.cls || "cat" }),
          m.share === null ? txt("", st) : cell(m.share, "pct", st, { color: col }),
          cell(m.perTicket, "money", st, { color: col })
        ]);
      });
      if (r.money.loss > 0.005) rows.push([null, txt("Shortfall " + fmt$(r.money.loss) + ": costs and pass-throughs exceed the " + fmt$(r.inflow) + " coming in.", "label", { color: LIGHT.critText, bold: true })]);
      rows.push(blank());

      rows.push(heading("Scenarios at this price", W));
      rows.push([null, txt("At " + priceText(inp.price) + " a ticket", "muted")]);
      rows.push([null, txt("Sold", "subhead"), txt("Tickets", "subhead", { align: "right" }), txt("Net ticket revenue", "subhead", { align: "right" }),
        txt("Headliner pay", "subhead", { align: "right" }), txt("Total costs", "subhead", { align: "right" }), txt("Net", "subhead", { align: "right" })]);
      scenarioRows(b).forEach(function (s) {
        var here = s.n === r.n ? LIGHT.accentWash : undefined;
        rows.push([null, txt(s.sold, "label", { fill: here }), cell(s.n, "int", "label", { fill: here }), cell(s.netTix, "money", "label", { fmt: FMT.money0, fill: here }),
          cell(s.hlPay, "money", "label", { fmt: FMT.money0, fill: here }), cell(s.costs, "money", "label", { fmt: FMT.money0, fill: here }),
          cell(s.net, "money", "label", { fmt: FMT.signed0, sign: true, bold: true, fill: here })]);
      });
      rows.push(blank());

      rows.push(heading("Net profit by price and attendance", W));
      rows.push([null, txt("Blue is profit, red is loss, gray is about $0. Rows: share of sellable and tickets sold; columns: ticket price.", "muted")]);
      var hg = heatGrid(inp, M);
      rows.push([null, txt("Sold \\ price", "subhead")].concat(hg.prices.map(function (p) {
        return cell(p, "money", "subhead", { fmt: FMT.money0, align: "center", bold: true, color: Math.abs(p - inp.price) < 0.005 ? LIGHT.ink : undefined });
      })));
      hg.rows.forEach(function (row) {
        var cur = row.n === r.n;
        rows.push([null, txt(row.p + "% · " + row.n + " tix", "label", { align: "right", bold: cur, color: cur ? LIGHT.ink : LIGHT.ink2 })].concat(row.cells.map(function (c) {
          var hc = heatColor(c), here = cur && Math.abs(c.price - inp.price) < 0.005;
          return cell(c.net, "money", "label", { fmt: FMT.money0, fill: hc.fill, color: hc.text, bold: true, align: "center", tag: "heat", box: here ? LIGHT.ink : undefined });
        })));
      });
      rows.push(blank());

      sheets.push({ name: "Overview", columns: [3, 34, 14, 18, 16, 13, 13, 13], rows: rows, freeze: 0 });
    })();

    // 2. Tickets & fees -----------------------------------------------------------
    (function () {
      var rows = topBlock("Tickets & fees", ctx, 3);
      rows.push(heading("Inputs", 3));
      rows = rows.concat(inputRowsFor("in-tickets", inp, S));
      rows.push(heading("Per ticket", 3));
      var p = r.perTicketPrices;
      rows.push([txt(fmt$(inp.price, { cents: true }) + " face price" + (inp.doorPriceOn ? ", " + fmt$(p.doorPrice, { cents: true }) + " at the door" : ""), "muted")]);
      rows = rows.concat(pairRows(perTicketRows(r, inp), 0));
      rows.push(blank());
      rows.push(heading("Ticket money", 3));
      rows.push([txt(r.n + " sold + " + inp.comps + " comps = " + (r.n + inp.comps) + " attending", "muted")]);
      rows = rows.concat(pairRows(ticketMoneyRows(r, inp), 0));
      sheets.push({ name: "Tickets & fees", columns: [52, 30, 8], rows: rows, freeze: TOP_ROWS });
    })();

    // 3. Venue ----------------------------------------------------------------------
    (function () {
      var rows = topBlock("Venue", ctx, 3);
      rows.push(heading("Deal", 3));
      rows = rows.concat(inputRowsFor("in-venue", inp, S));
      rows.push(heading("What the venue takes", 3));
      rows.push([txt(venueDescription(inp), "muted")]);
      rows.push([txt("Part", "subhead"), txt("At " + r.n + " tickets", "subhead", { align: "right" }), txt("Sold out (" + S + ")", "subhead", { align: "right" })]);
      venueRows(r, b.soldOut, inp).forEach(function (v) {
        var st = v.cls === "total" ? "total" : "label";
        rows.push([txt(v.label, st),
          v.on ? cell(v.now, "money", st) : txt("off", st, { color: LIGHT.muted, align: "right" }),
          v.on ? cell(v.out, "money", st) : txt("off", st, { color: LIGHT.muted, align: "right" })]);
      });
      rows.push(blank());
      rows.push([txt("The % of door and the per-head fee come out of ticket revenue. The flat rental is a cost line, so it also counts toward contingency.", "muted", { span: 3, wrap: true })]);
      sheets.push({ name: "Venue", columns: [44, 36, 16], rows: rows, freeze: 0 });
    })();

    // 4. Talent ---------------------------------------------------------------------
    (function () {
      var rows = topBlock("Talent", ctx, 3);
      rows.push(heading("Deal", 3));
      rows = rows.concat(inputRowsFor("in-talent", inp, S));
      rows.push(heading("Headliner payout", 3));
      rows.push([txt("At " + r.n + " tickets", "muted")]);
      rows = rows.concat(pairRows(headlinerRows(r, inp, b.hlBE), 0));
      rows.push(blank());
      rows.push(heading("Total talent cost", 3));
      rows.push([txt("At " + r.n + " tickets", "muted")]);
      rows = rows.concat(pairRows(talentRows(r, inp), 0));
      sheets.push({ name: "Talent", columns: [62, 38, 8], rows: rows, freeze: TOP_ROWS });
    })();

    // 5. Costs ----------------------------------------------------------------------
    (function () {
      var rows = topBlock("Costs", ctx, 3);
      rows.push(heading("Cost ledger at " + r.n + " tickets", 3));
      ledgerGroups(r, inp).forEach(function (g) {
        rows.push([txt(g.title, "subhead", { span: 2 })]);
        if (!g.rows.length) rows.push([txt("No custom cost lines", "muted", { indent: 1 })]);
        g.rows.forEach(function (l) {
          var lab = txt(l.label, "label", { indent: 1, color: l.role === "info" ? LIGHT.ink2 : undefined, wrap: l.label.length > 50 ? true : undefined });
          var val = l.off ? txt("off", "label", { color: LIGHT.muted, align: "right", tag: l.role })
            : cell(l.v, "money", l.input ? "input" : "label", { tag: l.role, color: l.role === "info" ? LIGHT.ink2 : undefined });
          rows.push([lab, val]);
        });
        rows.push([txt(g.subtotal.label, "subtotal"), cell(g.subtotal.v, "money", "subtotal", { tag: "subtotal" })]);
        rows.push(blank());
      });
      rows.push([txt("Contingency (" + inp.contingencyPct + "% of " + fmt$(r.contingencyBase, { cents: true }) + ")", "label"), cell(r.contingency, "money", "label", { tag: "line" }), cell(inp.contingencyPct / 100, "pct", "input", { fmt: FMT.pctIn })]);
      rows.push([txt(CONTINGENCY_HINT, "muted", { span: 3, wrap: true })]);
      rows.push([txt("Total costs", "total"), cell(r.totalCosts, "money", "total", { tag: "total-costs" })]);
      rows.push(blank());
      rows.push(heading("Net", 3));
      rows.push([txt("Net ticket revenue (after tax, fees and the venue's cut)", "label"), cell(r.netTicketRevenue, "money", "label", { tag: "net-tix" })]);
      rows.push([txt("Other income (merch, sponsor)", "label"), cell(r.otherIncome, "money", "input", { tag: "other-income" })]);
      rows.push([txt("Minus total costs", "label"), cell(-r.totalCosts, "money", "label")]);
      rows.push([txt("Net at " + r.n + " tickets", "total"), cell(r.net, "money", "total", { sign: true, tag: "net" })]);
      rows.push(blank());
      rows.push(heading("Costs by category", 3));
      rows.push([txt("Category", "subhead"), txt("Amount", "subhead", { align: "right" })]);
      costCategoryRows(r).forEach(function (c) {
        var st = c.cls === "total" ? "total" : "label";
        rows.push([txt(c.label, st), cell(c.v, "money", st)]);
      });
      sheets.push({ name: "Costs", columns: [58, 16, 10], rows: rows, freeze: TOP_ROWS });
    })();

    // 6. Profit by tickets ------------------------------------------------------------
    (function () {
      var rows = topBlock("Profit by tickets", ctx, 5);
      rows.push([txt("Net profit for every ticket count at " + priceText(inp.price) + " a ticket (stands in for the chart on the page).", "muted")]);
      rows.push([txt("Tickets", "subhead", { align: "right" }), txt("Net ticket revenue", "subhead", { align: "right" }), txt("Total costs", "subhead", { align: "right" }),
        txt("Net", "subhead", { align: "right" }), txt("", "subhead")]);
      var header = rows.length;
      b.sw.forEach(function (p) {
        var x = M.compute(inp, p.n, { hlBE: b.hlBE });
        var notes = [];
        if (b.be !== null && p.n === b.be) notes.push("Break-even");
        if (p.n === r.n) notes.push("Chosen count");
        var fill = p.n === r.n ? LIGHT.accentWash : (b.be !== null && p.n === b.be) ? "#fdf0d5" : undefined;
        var bold = !!notes.length;
        rows.push([cell(p.n, "int", "label", { fill: fill, bold: bold, tag: "sweep" }), cell(x.netTicketRevenue, "money", "label", { fill: fill, bold: bold }),
          cell(x.totalCosts, "money", "label", { fill: fill, bold: bold }), cell(p.net, "money", "label", { fill: fill, bold: true, sign: true }),
          txt(notes.join(", "), "label", { fill: fill, bold: bold })]);
      });
      sheets.push({ name: "Profit by tickets", columns: [10, 20, 16, 16, 24], rows: rows, freeze: header });
    })();

    // 7. Scenario -----------------------------------------------------------------------
    (function () {
      var rows = topBlock("Scenario", ctx, 3);
      rows.push(heading("Every input", 3));
      rows.push([txt("Names", "subhead", { span: 3 })]);
      rows.push([txt("Show / event", "label"), txt(String(inp.showName || ""), "input")]);
      rows.push([txt("Venue", "label"), txt(String(inp.venueName || ""), "input")]);
      rows.push([txt("Tickets sold (this snapshot)", "label"), cell(r.n, "int", "input")]);
      rows.push(blank());
      rows = rows.concat(inputRowsFor(null, inp, S, { all: true }));
      LEDGER.forEach(function (g) {
        rows.push([txt(g.title, "subhead", { span: 3 })]);
        g.rows.forEach(function (f) {
          if (f.pay) {
            rows.push([txt(f.label + ": people", "label", { color: inp[f.toggle] ? undefined : LIGHT.muted }), cell(inp[f.k], "int", "input"),
              txt(inp[f.toggle] ? "on" : "off", "input", { color: inp[f.toggle] ? undefined : LIGHT.muted, align: "center" })]);
            rows.push([txt(f.label + ": pay each", "label", { color: inp[f.toggle] ? undefined : LIGHT.muted }), cell(inp[f.pay], "money", "input")]);
            return;
          }
          var row = [txt(f.label, "label", { color: f.toggle && !inp[f.toggle] ? LIGHT.muted : undefined }), cell(inp[f.k], "money", "input")];
          if (f.toggle) row.push(txt(inp[f.toggle] ? "on" : "off", "input", { color: inp[f.toggle] ? undefined : LIGHT.muted, align: "center" }));
          rows.push(row);
        });
        rows.push(blank());
      });
      rows.push([txt("Other costs and income", "subhead", { span: 3 })]);
      inp.custom.forEach(function (c, i) {
        rows.push([txt("Custom cost line " + (i + 1) + ": " + (String(c.name || "").trim() || "(no name)"), "label"), cell(c.amount, "money", "input")]);
      });
      if (!inp.custom.length) rows.push([txt("Custom cost lines", "label"), txt("none", "label", { color: LIGHT.muted })]);
      rows.push([txt("Contingency", "label"), cell(inp.contingencyPct / 100, "pct", "input", { fmt: FMT.pctIn })]);
      rows.push([txt("Other income (merch, sponsor)", "label"), cell(inp.otherIncome, "money", "input")]);
      rows.push([txt("Default tickets sold (% of sellable, used when a code has no count)", "label"), cell(inp.expectedPct / 100, "pct", "input", { fmt: FMT.pctIn })]);
      rows.push(blank());
      rows.push(heading("Scenario code", 3));
      rows.push([txt("Paste this into Share > Load a scenario code at " + PAGE_URL + " to reopen this scenario.", "muted", { span: 3, wrap: true })]);
      rows.push([txt(encodeScenario(inp, r.n, M), "label", { span: 3, wrap: true, mono: true, tag: "scenario-code" })]);
      sheets.push({ name: "Scenario", columns: [56, 34, 8], rows: rows, freeze: TOP_ROWS });
    })();

    return sheets;
  }

  // ---------------------------------------------------------------- ExcelJS writer (thin)
  function argb(hex) { return "FF" + String(hex).replace("#", "").toUpperCase(); }
  function writeWorkbook(ExcelJS, sheets) {
    var wb = new ExcelJS.Workbook();
    wb.creator = "Show Feasibility";
    wb.created = new Date();
    var FONT = "Calibri";
    function border(color, style) { return { style: style || "thin", color: { argb: argb(color) } }; }

    sheets.forEach(function (sh) {
      var views = [{ showGridLines: false }];
      if (sh.freeze) views = [{ state: "frozen", xSplit: 0, ySplit: sh.freeze, showGridLines: false }];
      var ws = wb.addWorksheet(sh.name, {
        views: views,
        pageSetup: { paperSize: 1, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
          margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } }
      });
      ws.columns = sh.columns.map(function (w) { return { width: w }; });
      var ncols = sh.columns.length;

      sh.rows.forEach(function (row, ri) {
        var exRow = ws.getRow(ri + 1);
        var maxLines = 1;
        (row || []).forEach(function (c, ci) {
          if (!c) return;
          var x = exRow.getCell(ci + 1);
          var st = c.style || "label";
          var font = { name: FONT, size: 11, color: { argb: argb(LIGHT.ink) } };
          var fill = null, bd = {}, al = { vertical: "middle" };
          if (st === "title") { font.size = 16; font.bold = true; }
          else if (st === "heading") { font.size = 12; font.bold = true; font.color = { argb: argb(LIGHT.accent) }; fill = LIGHT.accentWash; bd.bottom = border(LIGHT.accent); }
          else if (st === "subhead") { font.size = 9; font.bold = true; font.color = { argb: argb(LIGHT.ink2) }; bd.bottom = border(LIGHT.line); }
          else if (st === "muted") { font.size = 10; font.color = { argb: argb(LIGHT.ink2) }; }
          else if (st === "subtotal") { font.bold = true; bd.top = border(LIGHT.axis); }
          else if (st === "total") { font.bold = true; font.size = 12; bd.top = border(LIGHT.axis); }
          else if (st === "input") { fill = LIGHT.input; bd = { top: border(LIGHT.fieldLine), bottom: border(LIGHT.fieldLine), left: border(LIGHT.fieldLine), right: border(LIGHT.fieldLine) }; }

          if (c.t === "link") {
            x.value = { text: String(c.v), hyperlink: String(c.v) };
            font.color = { argb: argb(LIGHT.accent) }; font.underline = true;
          } else if (c.t === "money" || c.t === "int" || c.t === "pct") {
            x.value = typeof c.v === "number" && isFinite(c.v) ? c.v : 0;
            x.numFmt = c.fmt || (c.t === "money" ? FMT.money : c.t === "int" ? FMT.int : FMT.pct);
            al.horizontal = "right";
          } else {
            x.value = c.v == null ? "" : String(c.v);
          }
          if (c.bold) font.bold = true;
          if (c.color) font.color = { argb: argb(c.color) };
          if (c.sign && typeof c.v === "number") {
            if (c.v >= 0.5) font.color = { argb: argb(LIGHT.goodText) };
            else if (c.v <= -0.5) font.color = { argb: argb(LIGHT.critText) };
          }
          if (c.fill) fill = c.fill;
          if (c.align) al.horizontal = c.align;
          if (c.indent) al.indent = c.indent;
          if (c.box) { var bb = border(c.box, "medium"); bd = { top: bb, bottom: bb, left: bb, right: bb }; }

          x.font = font;
          if (fill) x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
          if (Object.keys(bd).length) x.border = bd;

          var span = Math.min(c.span || 1, ncols - ci);
          // Long text would be cut off by a filled neighbour: wrap it inside its own column instead.
          var neighbour = row[ci + 1];
          if (!c.wrap && span === 1 && c.t === "text" && neighbour && neighbour.v !== "" && neighbour.v != null &&
              String(c.v).length > sh.columns[ci] * 1.1) c = Object.assign({}, c, { wrap: true });
          if (c.wrap) {
            al.wrapText = true; al.vertical = "top";
            var chars = 0;
            for (var k = 0; k < span; k++) chars += sh.columns[ci + k];
            var perLine = Math.max(10, chars * 1.1);
            maxLines = Math.max(maxLines, Math.ceil(String(c.v).length / perLine));
            if (span > 1) ws.mergeCells(ri + 1, ci + 1, ri + 1, ci + span);
          }
          x.alignment = al;
          // Carry fills and borders across the spanned cells (headings, table headers) without merging.
          if (span > 1 && !c.wrap) {
            for (var j = 1; j < span; j++) {
              var y = exRow.getCell(ci + 1 + j);
              if (fill) y.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
              if (Object.keys(bd).length) y.border = bd;
            }
          }
        });
        if (maxLines > 1) exRow.height = Math.min(409, Math.ceil(maxLines * 15 + 3)); // Excel's row height limit is 409 points
        else if (row && row[0] && row[0].style === "title") exRow.height = 24;
      });
      if (sh.freeze) ws.pageSetup.printTitlesRow = "1:" + sh.freeze;
    });
    return wb;
  }

  function fileSlug(inp) {
    var s = String(inp.showName || "").trim() || String(inp.venueName || "").trim() || "scenario";
    s = s.toLowerCase().normalize ? s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "") : s.toLowerCase();
    s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    return s || "scenario";
  }
  function fileName(inp, date) {
    return "show-feasibility-" + fileSlug(inp) + "-" + (typeof date === "string" ? date : localDate(date)) + ".xlsx";
  }

  return {
    PAGE_URL: PAGE_URL, SNAPSHOT_NOTE: SNAPSHOT_NOTE, MINUS: MINUS, LIGHT: LIGHT, FMT: FMT,
    // formatting and wording
    fmt$: fmt$, fmtCompact: fmtCompact, fmtPct: fmtPct, fmtInt: fmtInt, statusOf: statusOf, STATUS_LABEL: STATUS_LABEL,
    priceText: priceText, platName: platName, platLabel: platLabel,
    SECTIONS: SECTIONS, LEDGER: LEDGER, CONTINGENCY_HINT: CONTINGENCY_HINT, CATS: CATS, catName: catName, catLabel: catLabel,
    CUT_SHORT: CUT_SHORT, HL_BASIS_SHORT: HL_BASIS_SHORT, hlDescription: hlDescription, venueDescription: venueDescription, talentTotal: talentTotal,
    // rows
    bundle: bundle, headlineRows: headlineRows, moneyRows: moneyRows, scenarioRows: scenarioRows, heatGrid: heatGrid, mixOklab: mixOklab, heatColor: heatColor,
    perTicketRows: perTicketRows, ticketMoneyRows: ticketMoneyRows, headlinerRows: headlinerRows, talentRows: talentRows, venueRows: venueRows,
    costCategoryRows: costCategoryRows, ledgerGroups: ledgerGroups, ledgerLineValue: ledgerLineValue, crewLabel: crewLabel,
    encodeScenario: encodeScenario, LINK_BASE: LINK_BASE, encodeLink: encodeLink, decodeShared: decodeShared, localDate: localDate, fileName: fileName,
    // export
    buildSheets: buildSheets, writeWorkbook: writeWorkbook
  };
});
