/* Show Feasibility: shared wording and table rows, plus the spreadsheet export.
 * Works in the browser (window.ShowExport) and in Node (module.exports). No DOM, no ExcelJS dependency at load.
 *
 * Three layers:
 *   1. Row builders (perTicketRows, ticketMoneyRows, ...) used by both the page (app.js) and the export,
 *      so the wording lives in one place.
 *   2. Share links and scenario codes (encodeLink, decodeShared).
 * The live workbook itself is built in workbook.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowExport = api;
})(this, function () {
  "use strict";

  var PAGE_URL = "https://snowcrab22.github.io/show-feasibility/";
  var MINUS = "−";

  // Frozen copy of the defaults when share links were introduced (v2). Never change a value: links store
  // only the inputs that differ from this, so changing one would change what old links mean. New inputs
  // are added with the value that matches how old links behaved (the fee cap is off for them).
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
    ebCapOn: false,
    ebCap: 5.5,
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
    hlCapOn: false,
    hlCap: 1500,
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
        note: "The Eventbrite preset uses its US rates as of Nov 2026 (service 3.7% + $1.79, processing 2.9%). Rates change; check the platform's pricing page." },
      { k: "ebCap", toggle: "ebCapOn", label: "Fees capped at, per ticket", type: "money", step: 0.25,
        hint: "The most the platform charges per online ticket, service and processing together." }
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
        hint: "Backend is still added on top. Starting points apply only to tickets beyond them." },
      { k: "hlCap", toggle: "hlCapOn", label: "Cap total pay at", type: "money",
        hint: "Covers the guarantee, %, per-ticket and backend together. Never below the guarantee; travel and rider aren't included." }
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
    if (s && inp.hlCapOn) s += ", capped at " + fmt$(Math.max(inp.hlCap, inp.hlGuaranteeOn ? inp.hlGuarantee : 0), { ascii: true });
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
    out.push(R(pn + " fees " + (inp.ebMode === "pass" ? "paid by the buyer" : "absorbed by us") +
      (p.ebCapped ? " (capped at " + fmt$(inp.ebCap, { cents: true }) + ")" : ""), p.ebFee));
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
    out.push(R("Headliner pay" + (h.capped ? " (capped)" : ""), h.pay, "money", "total"));
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
  // Readable links the spreadsheet builds with formulas: PAGE_URL#q=n=105&price=27.5&taxOn=0&c1=Fog~40.
  // Only inputs that differ from LINK_BASE; booleans are 1/0, percents are whole numbers (29 = 29%),
  // c<i>=name~amount are custom lines. ebPreset and hlPreset aren't sent: they're worked out again.
  var Q_SKIP = { ebPreset: 1, hlPreset: 1, custom: 1 };
  function qEnc(s) {
    return String(s).replace(/%/g, "%25").replace(/&/g, "%26").replace(/#/g, "%23").replace(/=/g, "%3D")
      .replace(/~/g, "%7E").replace(/ /g, "%20").replace(/\+/g, "%2B").replace(/"/g, "%22");
  }
  function qNum(v, d) { var m = Math.pow(10, d); return String(Math.round(v * m) / m); }
  function encodeQueryLink(inputs, n, M) {
    var inp = M.sanitize(inputs), out = "n=" + n;
    Object.keys(M.DEFAULTS).forEach(function (k) {
      if (Q_SKIP[k] || sameVal(inp[k], LINK_BASE[k])) return;
      var v = inp[k];
      if (typeof v === "boolean") v = v ? "1" : "0";
      else if (typeof v === "number") v = /Pct$|Rate$/.test(k) || k === "hlPct" ? qNum(v, 6) : qNum(v, 2);
      else v = qEnc(v);
      out += "&" + k + "=" + v;
    });
    inp.custom.forEach(function (c, i) { out += "&c" + (i + 1) + "=" + qEnc(c.name) + "~" + qNum(c.amount, 2); });
    return PAGE_URL + "#q=" + out;
  }
  function decodeQuery(q, M) {
    var obj = {}, custom = [], n = 0;
    q.split("&").forEach(function (part) {
      var i = part.indexOf("=");
      if (i < 1) return;
      var k = part.slice(0, i), v = part.slice(i + 1);
      try { v = decodeURIComponent(v); } catch (e) { /* keep as typed */ }
      var cm = /^c(\d+)$/.exec(k);
      if (k === "n") n = Math.max(0, Math.round(+v) || 0);
      else if (cm) { var t = v.lastIndexOf("~"); custom.push({ i: +cm[1], name: t < 0 ? v : v.slice(0, t), amount: t < 0 ? 0 : parseFloat(v.slice(t + 1)) || 0 }); }
      else if (Object.prototype.hasOwnProperty.call(M.DEFAULTS, k) && !Q_SKIP[k]) {
        var d = M.DEFAULTS[k];
        obj[k] = typeof d === "boolean" ? v === "1" || v === "true" : typeof d === "number" ? parseFloat(v) : v;
      }
    });
    custom.sort(function (a, b) { return a.i - b.i; });
    var raw = Object.assign({}, LINK_BASE, obj, { custom: custom.map(function (c) { return { name: c.name, amount: c.amount }; }) });
    delete raw.ebPreset; // sanitize works it out from the three rates
    var inp = M.sanitize(raw);
    inp.hlPreset = M.detectPreset(inp);
    return { kind: "link", inputs: inp, n: n };
  }
  function decodeShared(text, M) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return null;
    var qm = /(?:^|#)q=(.*)$/.exec(t);
    if (qm) return decodeQuery(qm[1], M);
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
      // Codes from before the fee cap open with it off.
      return { kind: "code", inputs: M.sanitize(Object.assign({ ebCapOn: false }, obj.inputs)), n: obj.n == null ? null : Math.max(0, Math.round(+obj.n) || 0) };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- number formats (spreadsheet)
  var FMT = {
    money: "$#,##0.00;-$#,##0.00",
    money0: "$#,##0;-$#,##0",
    signed0: "+$#,##0;-$#,##0;$0",
    signed: "+$#,##0.00;-$#,##0.00;$0.00",
    int: "0",
    pct: "0.0%",
    pctIn: "0.0##%"
  };
  function localDate(d) {
    d = d || new Date();
    function p(x) { return (x < 10 ? "0" : "") + x; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
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
    PAGE_URL: PAGE_URL, MINUS: MINUS, LIGHT: LIGHT, FMT: FMT,
    // formatting and wording
    fmt$: fmt$, fmtCompact: fmtCompact, fmtPct: fmtPct, fmtInt: fmtInt, statusOf: statusOf, STATUS_LABEL: STATUS_LABEL,
    priceText: priceText, platName: platName, platLabel: platLabel,
    SECTIONS: SECTIONS, LEDGER: LEDGER, CONTINGENCY_HINT: CONTINGENCY_HINT, CATS: CATS, catName: catName, catLabel: catLabel,
    CUT_SHORT: CUT_SHORT, HL_BASIS_SHORT: HL_BASIS_SHORT, hlDescription: hlDescription, venueDescription: venueDescription, talentTotal: talentTotal,
    // rows
    bundle: bundle, headlineRows: headlineRows, moneyRows: moneyRows, scenarioRows: scenarioRows, heatGrid: heatGrid, mixOklab: mixOklab, heatColor: heatColor,
    perTicketRows: perTicketRows, ticketMoneyRows: ticketMoneyRows, headlinerRows: headlinerRows, talentRows: talentRows, venueRows: venueRows,
    costCategoryRows: costCategoryRows,
    encodeScenario: encodeScenario, LINK_BASE: LINK_BASE, encodeLink: encodeLink, encodeQueryLink: encodeQueryLink, decodeShared: decodeShared, localDate: localDate, fileName: fileName
  };
});
