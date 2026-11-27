/* Show Feasibility: the live spreadsheet export (full build).
 * Works in the browser (window.ShowWorkbook) and in Node (module.exports). Needs export.js (ShowExport).
 *
 *   buildSheets(inputs, n, Model, opts) -> [{ name, columns, rows, ranges, cf, freeze, freezeCols, tab }]
 *   writeWorkbook(ExcelJS, sheets)      -> ExcelJS workbook
 *   decorations(sheets)                 -> { inputs: [{ sheet, r1, c1, r2, c2 }], chart: {...} } for the Sheets API
 *
 * The workbook is a full calculator. Every input on the Inputs tab is a yellow cell, every number is a
 * formula, and the chain mirrors model.js:
 *   Inputs -> per-ticket constants (Tickets & fees, named PT_*) -> "By ticket count" (one row per ticket
 *   count up to MaxRows; rows past Sellable are blank and excluded) -> every "at the chosen count" number
 *   via INDEX(column, ChosenN + 1).
 *   The price grid and the break-even price need the headliner break-even at other prices, so the
 *   "Price math" tab repeats the ticket side once per price: one column per grid price, one for $0, one
 *   for $1,000 and 17 for the cent-by-cent bisection (the same steps breakEvenPrice takes).
 * Whole-ticket splits use ROUND(ROUND(x,9),0): 50 x 0.29 is 14.499999999999998 in floating point while
 * the model's 50 x 29 / 100 is exactly 14.5.
 *
 * Cell: { v, t: 'money'|'int'|'pct'|'text'|'link'|'auto', s: style, f: formula without '=', name,
 *         dv: data validation, fmt, bold, color, fill, align, wrap, span, indent, box, link }
 * Every formula cell carries v, its value computed by the model, so viewers that don't recalculate
 * still show numbers.
 */
(function (root, factory) {
  var X = root && root.ShowExport;
  if (!X && typeof require === "function") X = require("./export.js");
  var api = factory(X);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowWorkbook = api;
})(this, function (X) {
  "use strict";

  var LIGHT = X.LIGHT, FMT = X.FMT;
  var ON = "On", OFF = "Off", YES = "Yes", NO = "No";
  var START_LABEL = { first: "From ticket 1", breakEven: "After break-even", afterN: "After N tickets" };
  var BASIS_LABEL = { grossFace: "Gross face", faceNet: "Face net of sales tax", net: "Our net ticket revenue" };
  var TAX_LABEL = { ontop: "Added on top", included: "Included in price" };
  var TRIGGER_LABEL = { tickets: "N tickets", pct: "% sold", sellout: "Sell out" };
  var BONUS_SLOTS = 5; // = model MAX_BONUSES
  var FEE_LABEL = { pass: "Passed to buyer", absorb: "Absorbed by us" };
  var CUT_LABEL = X.CUT_SHORT; // afterTax, afterTaxFees, gross
  var NEVER = 1000000000; // threshold stand-in for "never reached"
  var EPS = "0.000000001";
  var PRICE_CAP_CENTS = 100000, BISECT_STEPS = 17; // same search as model.breakEvenPrice ($1,000 ceiling)
  var EDIT_NOTE = "Yellow cells on the Inputs tab can be changed here; everything else recalculates.";
  var BLANK_CUSTOM_ROWS = 5;
  var PM = "Price math";

  // ---------------------------------------------------------------- tiny builders
  function colLetter(c) { var s = ""; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function quoteSheet(name) { return "'" + name.replace(/'/g, "''") + "'"; }
  function Sheet(name, columns, tab) {
    this.name = name; this.columns = columns; this.rows = []; this.ranges = []; this.cf = []; this.freeze = 0; this.freezeCols = 0; this.tab = tab;
  }
  Sheet.prototype.add = function (cells) { this.rows.push(cells || []); return this.rows.length; };
  Sheet.prototype.next = function () { return this.rows.length + 1; };
  Sheet.prototype.range = function (name, col, r1, r2) {
    this.ranges.push({ name: name, ref: quoteSheet(this.name) + "!$" + colLetter(col) + "$" + r1 + ":$" + colLetter(col) + "$" + r2 });
  };
  Sheet.prototype.signCF = function (ref) { this.cf.push({ ref: ref, kind: "sign" }); };

  function cell(v, t, s, extra) {
    var c = { v: v, t: t || (typeof v === "number" ? "money" : "text"), s: s || "label" };
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) c[k] = extra[k]; });
    return c;
  }
  function txt(v, s, extra) { return cell(v, "text", s, extra); }
  function fx(f, v, t, s, extra) { var c = cell(v, t, s, extra); c.f = f; return c; }
  function choice(list, blank) { return { type: "list", list: list, blank: !!blank }; }
  function str(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

  function onOff(b) { return b ? ON : OFF; }
  function idx(col) { return "INDEX(" + col + ",ChosenN+1)"; }
  function basisValue(r, basis) { return basis === "grossFace" ? r.grossFace : basis === "net" ? r.netTicketRevenue : r.faceNet; }
  function threshold(start, startN, hlBE) {
    if (start === "first") return 0;
    if (start === "afterN") return Math.max(0, startN);
    return hlBE === null ? NEVER : hlBE;
  }
  function startF(startName, nName, hlBERef) {
    return "IF(" + startName + "=" + str(START_LABEL.first) + ",0,IF(" + startName + "=" + str(START_LABEL.afterN) + ",MAX(0," + nName + "),IF(ISNUMBER(" + hlBERef + ")," + hlBERef + "," + NEVER + ")))";
  }
  // "$1,234" / "$1,234.50" without TEXT thousands formats (not every engine has them).
  function moneyText(e, cents) {
    var I = cents ? "INT(ROUND(" + e + ",2))" : "ROUND(" + e + ",0)";
    var grp = "IF(" + I + ">=1000000,INT(" + I + "/1000000)&\",\"&TEXT(MOD(INT(" + I + "/1000),1000),\"000\")&\",\"&TEXT(MOD(" + I + ",1000),\"000\")," +
      "IF(" + I + ">=1000,INT(" + I + "/1000)&\",\"&TEXT(MOD(" + I + ",1000),\"000\")," + I + "&\"\"))";
    return "\"$\"&" + grp + (cents ? "&RIGHT(TEXT(ROUND(" + e + ",2),\"0.00\"),3)" : "");
  }
  function moneyTextAuto(e) { return "IF(MOD(ROUND(" + e + ",2),1)<>0," + moneyText(e, true) + "," + moneyText(e, false) + ")"; }
  function urlEnc(e) {
    var s = e;
    [["%", "%25"], ["&", "%26"], ["#", "%23"], ["=", "%3D"], ["~", "%7E"], [" ", "%20"], ["+", "%2B"], ['"', "%22"]].forEach(function (p) {
      s = "SUBSTITUTE(" + s + "," + (p[0] === '"' ? "CHAR(34)" : str(p[0])) + "," + str(p[1]) + ")";
    });
    return s;
  }
  function enumF(name, labels) { // sheet label -> model key
    var keys = Object.keys(labels), f = str(keys[keys.length - 1]);
    for (var i = keys.length - 2; i >= 0; i--) f = "IF(" + name + "=" + str(labels[keys[i]]) + "," + str(keys[i]) + "," + f + ")";
    return f;
  }

  // Per-ticket constants for an online price P and door price DP, mirroring model.ticketSide().
  // R(key) gives the reference to an earlier constant.
  var PT_KEYS = ["fn", "tx", "gr", "svcU", "feeU", "fee", "svc", "proc", "buyer", "abs", "pass", "dfn", "dtx", "dgr", "dcp"];
  function ptFormulas(P, DP, R) {
    var INC = "TaxMode=" + str(TAX_LABEL.included);
    return {
      fn: "IF(" + INC + "," + P + "/(1+TaxR)," + P + ")",
      tx: "IF(" + INC + "," + P + "-" + R("fn") + "," + P + "*TaxR)",
      gr: P + "+IF(" + INC + ",0," + R("tx") + ")",
      svcU: "SvcPct*" + P + "+SvcFixed",
      feeU: "IF(FeeMode=" + str(FEE_LABEL.pass) + ",(" + R("gr") + "+" + R("svcU") + ")/(1-ProcPct)-" + R("gr") + "," + R("svcU") + "+" + R("gr") + "*ProcPct)",
      // Fee cap: the whole fee stops at FeeCap; service and processing shrink together.
      fee: "IF(AND(FeeCapOn=\"On\"," + R("feeU") + ">FeeCap),FeeCap," + R("feeU") + ")",
      svc: "IF(" + R("feeU") + ">0," + R("svcU") + "*" + R("fee") + "/" + R("feeU") + "," + R("svcU") + ")",
      proc: R("fee") + "-" + R("svc"),
      buyer: R("gr") + "+IF(FeeMode=" + str(FEE_LABEL.pass) + "," + R("fee") + ",0)",
      abs: "IF(FeeMode=" + str(FEE_LABEL.absorb) + "," + R("fee") + ",0)",
      pass: "IF(FeeMode=" + str(FEE_LABEL.pass) + "," + R("fee") + ",0)",
      dfn: "IF(" + INC + "," + DP + "/(1+TaxR)," + DP + ")",
      dtx: "IF(" + INC + "," + DP + "-" + R("dfn") + "," + DP + "*TaxR)",
      dgr: DP + "+IF(" + INC + ",0," + R("dtx") + ")",
      dcp: "DoorCardPct*" + R("dgr") + "+DoorCardFixed"
    };
  }
  function ptValues(pt) { // model perTicketPrices -> PT_KEYS values
    return { fn: pt.faceNet, tx: pt.tax, gr: pt.gross, svcU: pt.ebServiceU, feeU: pt.ebFeeU, svc: pt.ebService, buyer: pt.onlineBuyer, proc: pt.ebProc, fee: pt.ebFee,
      abs: pt.ebAbsorbed, pass: pt.ebPassed, dfn: pt.doorFaceNet, dtx: pt.doorTax, dgr: pt.doorGross, dcp: pt.doorCardProc };
  }
  // Ticket side at a count N (a reference), given the per-ticket constant references K(key), P and DP.
  // R(key) refers to earlier rows of the same block. Mirrors ticketSide(): counts, then money.
  function tsFormulas(N, P, DP, K, R) {
    return {
      on: "ROUND(ROUND(" + N + "*OnlinePct,9),0)",
      door: N + "-" + R("on"),
      card: R("door") + "-ROUND(ROUND(" + R("door") + "*DoorCashPct,9),0)",
      fnT: R("on") + "*" + K("fn") + "+" + R("door") + "*" + K("dfn"),
      gf: R("on") + "*" + P + "+" + R("door") + "*" + DP,
      absT: R("on") + "*" + K("abs"),
      dpT: R("card") + "*" + K("dcp"),
      cb: "IF(DoorCutBasis=" + str(CUT_LABEL.afterTax) + "," + R("fnT") + ",IF(DoorCutBasis=" + str(CUT_LABEL.afterTaxFees) + "," +
        R("fnT") + "-" + R("absT") + "-" + R("dpT") + "," + R("on") + "*" + K("gr") + "+" + R("door") + "*" + K("dgr") + "))",
      cut: "IF(DoorCutOn=\"On\",MAX(0," + R("cb") + ")*DoorCutPct,0)",
      ph: "IF(PerHeadOn=\"On\",(" + N + "+CompsEff)*PerHead,0)",
      ntr: R("fnT") + "-" + R("absT") + "-" + R("dpT") + "-" + R("cut") + "-" + R("ph"),
      hb: "IF(HLPctBasis=" + str(BASIS_LABEL.grossFace) + "," + R("gf") + ",IF(HLPctBasis=" + str(BASIS_LABEL.net) + "," + R("ntr") + "," + R("fnT") + "))"
    };
  }
  var TS_KEYS = ["on", "door", "card", "fnT", "gf", "absT", "dpT", "cb", "cut", "ph", "ntr", "hb"];
  var TS_LABEL = { on: "Online tickets", door: "Door tickets", card: "Door card tickets", fnT: "Face net of tax", gf: "Gross face", absT: "Fees we absorb",
    dpT: "Door card processing", cb: "Venue % basis", cut: "Venue % of door", ph: "Per-head fee", ntr: "Net ticket revenue", hb: "Headliner % basis" };
  function tsValues(r, inp) {
    return { on: r.counts.online, door: r.counts.door, card: r.counts.doorCard, fnT: r.faceNet, gf: r.grossFace, absT: r.eventbrite.absorbed,
      dpT: r.doorProc, cb: r.doorCutBasis, cut: r.doorCut, ph: r.venue.perHead, ntr: r.netTicketRevenue, hb: basisValue(r, inp.hlPctBasis) };
  }
  // Ticket bonuses at count N: each slot pays its amount once N reaches BonusAt_i (NEVER when off or blank).
  function bonusF(N) {
    var t = [];
    for (var i = 1; i <= BONUS_SLOTS; i++) t.push("IF(" + N + ">=BonusAt_" + i + ",N(Bonus_" + i + "_Amount),0)");
    return t.join("+");
  }
  // Deal pay before ticket bonuses: guarantee plus the parts, or the versus amount.
  function preBonusF(pct, pt) { return 'IF(HLVersus="Yes",MAX(GuaranteeAmt,' + pct + "+" + pt + "),GuaranteeAmt+" + pct + "+" + pt + ")"; }
  // Ticket count a bonus slot pays from (blank trigger: blank).
  function paysFromF(i) {
    var T = "Bonus_" + i + "_Trigger", num = "N(Bonus_" + i + "_Number)";
    return "IF(" + T + '="","",IF(' + T + "=" + str(TRIGGER_LABEL.tickets) + ",ROUND(MAX(0," + num + "),0),IF(" + T + "=" + str(TRIGGER_LABEL.pct) +
      ",ROUNDUP(ROUND(Sellable*MIN(100,MAX(0," + num + "))/100,9),0),Sellable)))";
  }
  // Headliner and profit at count N from a ticket-side block, mirroring computeCore().
  var DEAL_KEYS = ["pct", "pt", "bonus", "deal", "nbb", "backend", "net", "ok"];
  var DEAL_LABEL = { pct: "% part", pt: "$ per ticket part", bonus: "Ticket bonuses", deal: "Deal pay", nbb: "Net before backend", backend: "Backend", net: "Net", ok: "Breaks even (1)" };
  // Headliner pay cap: deal pay and backend together never above MAX(HLCap, guarantee).
  var CAP_AMT = "MAX(HLCap,GuaranteeAmt)";
  function capDeal(f) { return "IF(HLCapOn=\"On\",MIN(" + CAP_AMT + "," + f + ")," + f + ")"; }
  function capBackend(f, deal) { return "IF(HLCapOn=\"On\",MIN(" + CAP_AMT + "-" + deal + "," + f + ")," + f + ")"; }
  function dealFormulas(N, R, pctThr, ptThr, hbThr) {
    return {
      pct: "IF(AND(HLPctOn=\"On\"," + N + ">" + pctThr + "),MAX(0," + R("hb") + "-" + hbThr + ")*HLPct,0)",
      pt: "IF(HLPerTicketOn=\"On\",MAX(0," + N + "-" + ptThr + ")*HLPerTicket,0)",
      bonus: bonusF(N),
      deal: capDeal(preBonusF(R("pct"), R("pt")) + "+" + R("bonus")),
      nbb: R("ntr") + "+OtherIncome-FixedTotal-(" + R("deal") + "-GuaranteeAmt)",
      backend: capBackend("IF(HLBackendOn=\"On\",MAX(0," + R("nbb") + ")*HLBackendPct,0)", R("deal")),
      net: R("nbb") + "-" + R("backend"),
      ok: "IF(" + R("net") + ">=-" + EPS + ",1,0)"
    };
  }
  function dealValues(r) {
    var h = r.headliner;
    return { pct: h.pctPart, pt: h.perTicketPart, bonus: h.bonusPart, deal: h.dealPay, nbb: r.netBeforeBackend, backend: h.backend, net: r.net, ok: r.net >= -1e-9 ? 1 : 0 };
  }

  function topBlock(sh, title, ctx, titleCell) {
    sh.add([null, txt(title, "title")]);
    sh.add([null, titleCell || fx("ScenarioTitle", ctx.title, "text", "label", { bold: true })]);
    sh.add([null, txt("Exported " + ctx.date + ". " + EDIT_NOTE, "muted", { span: 6 })]);
    sh.add([null, linkCell()]);
    sh.add([]);
  }
  function linkCell() { return fx('HYPERLINK(CalcLink,"Open this scenario in the calculator")', "Open this scenario in the calculator", "text", "muted", { link: true }); }
  function heading(sh, text, span) { sh.add([null, txt(text, "heading", { span: span || 3 })]); }

  // ---------------------------------------------------------------- the workbook
  function buildSheets(inputs, n, M, opts) {
    opts = opts || {};
    var inp = M.sanitize(inputs);
    var S = M.sellable(inp);
    var MAXR = Math.max(1000, Math.ceil(inp.capacity * 2 / 100) * 100); // table rows: 0..MAXR tickets
    n = Math.max(0, Math.min(S, Math.round(+n) || 0));
    var hlBE = M.headlinerBreakEven(inp);
    var rs = [];
    for (var k = 0; k <= S; k++) rs.push(M.compute(inp, k, { hlBE: hlBE }));
    var r = rs[n], L = r.costs, h = r.headliner;
    var be = M.breakEven(inp);
    var ctx = {
      inp: inp, r: r,
      date: opts.date ? (typeof opts.date === "string" ? opts.date : X.localDate(opts.date)) : X.localDate(),
      title: (String(inp.showName || "").trim() ? String(inp.showName).trim() + " at " : "") + (String(inp.venueName || "").trim() || "New venue"),
      link: X.encodeQueryLink(inp, n, M)
    };
    var pn = X.platLabel(inp);
    var pctThr = threshold(inp.hlPctStart, inp.hlPctStartN, hlBE);
    var ptThr = threshold(inp.hlPerTicketStart, inp.hlPerTicketStartN, hlBE);
    var pctBasisAtStart = pctThr > 0 ? basisValue(rs[Math.min(pctThr, S)], inp.hlPctBasis) : 0;
    var guaranteeAmt = inp.hlGuaranteeOn ? inp.hlGuarantee : 0;
    var talentTotal = h.total + L.support;
    // Offer (padded) version: same tickets and deal, offer cost amounts (M.offerInputs).
    var offerInp = M.offerInputs(inp);
    var oHLBE = M.headlinerBreakEven(offerInp);
    var oAt = M.compute(offerInp, n, { hlBE: oHLBE }), oSO = M.compute(offerInp, S, { hlBE: oHLBE });
    var oDelta = oAt.fixedCostsTotal - r.fixedCostsTotal, OL = oAt.costs;
    var oPctThr = threshold(inp.hlPctStart, inp.hlPctStartN, oHLBE);
    var oPtThr = threshold(inp.hlPerTicketStart, inp.hlPerTicketStartN, oHLBE);
    var oPctBasisAtStart = oPctThr > 0 ? basisValue(rs[Math.min(oPctThr, S)], inp.hlPctBasis) : 0;
    var offerLinesSum = inp.offerExtra.reduce(function (s2, x2) { return s2 + x2.amount; }, 0);
    var rS = rs[S];
    var laborAmt = L.soundTechs + L.stagehands;
    var inflow = r.inflow;
    var pt = ptValues(r.perTicketPrices);
    var PLAT = 'IF(TRIM(Platform)="","Ticketing platform",TRIM(Platform))';
    function platF(before, after) { return (before ? str(before) + "&" : "") + PLAT + (after ? "&" + str(after) : ""); }

    var sheets = {};

    // ---------- Inputs
    var I = new Sheet("Inputs", [2, 50, 18, 10, 52], LIGHT.input);
    sheets.inputs = I;
    topBlock(I, "Inputs", ctx, fx('IF(TRIM(ShowName)<>"",TRIM(ShowName)&" at ","")&IF(TRIM(VenueName)<>"",TRIM(VenueName),"New venue")', ctx.title, "text", "label", { bold: true, name: "ScenarioTitle" }));
    function inRow(label, valueCell, toggleCell, note) {
      return I.add([null, typeof label === "string" ? txt(label, "label") : label, valueCell, toggleCell || null, note ? (typeof note === "string" ? txt(note, "muted") : note) : null]);
    }
    function yMoney(v, name) { return cell(v, "money", "input", { name: name, dv: { type: "min0" } }); }
    function yInt(v, name, dv) { return cell(v, "int", "input", { name: name, dv: dv || { type: "int0" } }); }
    function yPct(v, name, max) { return cell(v / 100, "pct", "input", { name: name, fmt: FMT.pctIn, dv: { type: "pct", max: max } }); }
    function yOn(b, name) { return cell(onOff(b), "text", "input", { name: name, dv: choice([ON, OFF]), align: "center" }); }
    function yChoice(v, name, list) { return cell(v, "text", "input", { name: name, dv: choice(list) }); }
    function yText(v, name) { return cell(v, "text", "input", { name: name }); }
    function vals(o) { return Object.keys(o).map(function (k) { return o[k]; }); }

    heading(I, "Show", 4);
    inRow("Venue name", yText(inp.venueName, "VenueName"));
    inRow("Show name", yText(inp.showName, "ShowName"));
    inRow("Tickets sold", yInt(n, "TicketsSold", { type: "range", min: 0, max: MAXR }), null,
      fx('"0 to "&Sellable&" (sellable tickets)."', "0 to " + S + " (sellable tickets).", "text", "muted"));
    inRow("Default tickets sold (% of sellable)", yPct(inp.expectedPct, "ExpectedPct"), null, "Where the calculator's slider starts. Only used by the link.");
    I.add([]);

    heading(I, "Tickets & sales", 4);
    inRow("Venue capacity", yInt(inp.capacity, "Capacity", { type: "range", min: 1, max: MAXR }), null, "Up to " + MAXR.toLocaleString("en-US") + " in this sheet.");
    inRow("Comps / guest list", yInt(inp.comps, "Comps", { type: "range", min: 0, max: MAXR }));
    inRow(txt("Sellable tickets", "label"), fx("MAX(0,CapEff-CompsEff)", S, "int", "label", { name: "Sellable" }), null, "Capacity minus comps.");
    inRow("Ticket price", yMoney(inp.price, "Price"));
    inRow("Different price at the door", yMoney(inp.doorPrice, "DoorPrice"), yOn(inp.doorPriceOn, "DoorPriceOn"));
    inRow(fx(platF("Sold online via "), "Sold online via " + pn, "text", "label"), yPct(inp.onlinePct, "OnlinePct"), null, "The rest sell at the door.");
    inRow("Door sales paid in cash", yPct(inp.doorCashPct, "DoorCashPct"));
    inRow("Door card processing", yPct(inp.doorCardPct, "DoorCardPct"));
    inRow("Plus per card ticket", yMoney(inp.doorCardFixed, "DoorCardFixed"));
    I.add([]);

    heading(I, "Sales tax", 4);
    inRow("Sales tax rate", yPct(inp.taxRate, "TaxRate", 10), yOn(inp.taxOn, "TaxOn"));
    inRow("Sales tax is", yChoice(TAX_LABEL[inp.taxMode], "TaxMode", vals(TAX_LABEL)));
    I.add([]);

    heading(I, "Ticketing platform", 4);
    inRow("Ticketing platform", yText(inp.ticketPlatform, "Platform"));
    inRow(fx(platF("", " fees"), pn + " fees", "text", "label"), yChoice(FEE_LABEL[inp.ebMode], "FeeMode", vals(FEE_LABEL)));
    inRow("Service fee", yPct(inp.ebServicePct, "SvcPct"));
    inRow("Plus per ticket", yMoney(inp.ebServiceFixed, "SvcFixed"));
    inRow("Payment processing", yPct(inp.ebProcPct, "ProcPct", 0.5), null, "Up to 50%.");
    inRow("Fees capped at, per ticket", yMoney(inp.ebCap, "FeeCap"), yOn(inp.ebCapOn, "FeeCapOn"), "Service and processing together, per online ticket.");
    I.add([]);

    heading(I, "Venue", 4);
    inRow("Venue % of door", yPct(inp.doorCutPct, "DoorCutPct"), yOn(inp.doorCutOn, "DoorCutOn"));
    inRow("% of door is taken from", yChoice(CUT_LABEL[inp.doorCutBasis], "DoorCutBasis", vals(CUT_LABEL)));
    inRow("Flat rental / fee", yMoney(inp.venueRental, "VenueRental"), yOn(inp.venueRentalOn, "VenueRentalOn"));
    inRow("Venue per-head fee", yMoney(inp.venuePerHead, "PerHead"), yOn(inp.venuePerHeadOn, "PerHeadOn"), "Everyone in the room, comps included.");
    I.add([]);

    heading(I, "Headliner deal", 4);
    inRow("Guarantee (flat)", yMoney(inp.hlGuarantee, "HLGuarantee"), yOn(inp.hlGuaranteeOn, "HLGuaranteeOn"));
    inRow("% of ticket sales", yPct(inp.hlPct, "HLPct"), yOn(inp.hlPctOn, "HLPctOn"));
    inRow("% of", yChoice(BASIS_LABEL[inp.hlPctBasis], "HLPctBasis", vals(BASIS_LABEL)));
    inRow("% starts", yChoice(START_LABEL[inp.hlPctStart], "HLPctStart", vals(START_LABEL)));
    inRow("% starts after how many tickets", yInt(inp.hlPctStartN, "HLPctStartN"), null, "Used when % starts is " + START_LABEL.afterN + ".");
    inRow("$ per ticket sold", yMoney(inp.hlPerTicket, "HLPerTicket"), yOn(inp.hlPerTicketOn, "HLPerTicketOn"));
    inRow("$ per ticket starts", yChoice(START_LABEL[inp.hlPerTicketStart], "HLPerTicketStart", vals(START_LABEL)));
    inRow("$ per ticket starts after how many tickets", yInt(inp.hlPerTicketStartN, "HLPerTicketStartN"));
    inRow("Ticket bonuses", null, yOn(inp.hlBonusOn, "HLBonusOn"), "Each pays its whole amount once tickets sold reach its trigger; they add up.");
    I.add([null, txt("Bonus trigger", "subhead"), txt("Amount", "subhead", { align: "right" }), txt("Number", "subhead", { align: "right" }), txt("Pays from", "subhead")]);
    for (var bi = 1; bi <= BONUS_SLOTS; bi++) {
      var brow = inp.hlBonuses[bi - 1];
      I.add([null, cell(brow ? TRIGGER_LABEL[brow.trigger] : "", "text", "input", { name: "Bonus_" + bi + "_Trigger", dv: choice(vals(TRIGGER_LABEL), true) }),
        cell(brow ? brow.amount : null, "money", "input", { name: "Bonus_" + bi + "_Amount", dv: { type: "min0" } }),
        cell(brow ? brow.n : null, "auto", "input", { name: "Bonus_" + bi + "_Number", dv: { type: "min0" }, fmt: "General" }),
        fx(paysFromF(bi), brow ? M.bonusAt(brow, S) : "", "auto", "muted", { name: "Bonus_" + bi + "_PaysFrom", fmt: '#,##0" tickets"', align: "left" })]);
    }
    I.add([null, txt("Number is the ticket count for " + TRIGGER_LABEL.tickets + ", or the percent of sellable tickets for " + TRIGGER_LABEL.pct +
      " (80 = 80%). " + TRIGGER_LABEL.sellout + " needs none. Blank rows are there to add bonuses.", "muted", { span: 4, wrap: true })]);
    inRow("Backend: % of profit after break-even", yPct(inp.hlBackendPct, "HLBackendPct"), yOn(inp.hlBackendOn, "HLBackendOn"));
    inRow("Versus: pay the greater of the guarantee or the % and per-ticket parts",
      cell(inp.hlVersus ? YES : NO, "text", "input", { name: "HLVersus", dv: choice([YES, NO]), align: "center" }), null, "Ticket bonuses and backend are still added on top.");
    inRow("Cap total pay at", yMoney(inp.hlCap, "HLCap"), yOn(inp.hlCapOn, "HLCapOn"), "Guarantee, %, per ticket, ticket bonuses and backend together. Never below the guarantee.");
    inRow("Travel / hotel", yMoney(inp.hlTravel, "HLTravel"));
    inRow("Hospitality / rider", yMoney(inp.hlHospitality, "HLHospitality"));
    I.add([]);

    heading(I, "Support", 4);
    inRow("Supporting slots", yInt(inp.supportSlots, "SupportSlots"));
    inRow("Price per slot", yMoney(inp.supportPrice, "SupportPrice"));
    I.add([]);

    heading(I, "Labor", 4);
    inRow("Sound techs: people", yInt(inp.soundTechs, "SoundTechs"), yOn(inp.soundTechsOn, "SoundTechsOn"));
    inRow("Sound techs: pay each for the night", yMoney(inp.soundTechPay, "SoundTechPay"));
    inRow("Stagehands: people", yInt(inp.stagehands, "Stagehands"), yOn(inp.stagehandsOn, "StagehandsOn"));
    inRow("Stagehands: pay each for the night", yMoney(inp.stagehandPay, "StagehandPay"));
    I.add([]);

    heading(I, "Production", 4);
    inRow("Contracted security (flat)", yMoney(inp.security, "Security"), yOn(inp.securityOn, "SecurityOn"));
    inRow("Sound rental", yMoney(inp.sound, "SoundRental"), yOn(inp.soundOn, "SoundRentalOn"));
    inRow("Additional deck / gear", yMoney(inp.gear, "Gear"), yOn(inp.gearOn, "GearOn"));
    inRow("Photo / video", yMoney(inp.photo, "Photo"));
    I.add([]);

    heading(I, "Visual production", 4);
    inRow("VJ", yMoney(inp.vj, "VJFee"), yOn(inp.vjOn, "VJOn"));
    inRow("Lighting designer (LD)", yMoney(inp.ld, "LDFee"), yOn(inp.ldOn, "LDOn"));
    I.add([]);

    heading(I, "Marketing", 4);
    inRow("Advertising budget", yMoney(inp.ads, "Ads"));
    inRow("Poster design", yMoney(inp.poster, "Poster"));
    I.add([]);

    heading(I, "Insurance", 4);
    inRow("Event insurance", yMoney(inp.insurance, "Insurance"), yOn(inp.insuranceOn, "InsuranceOn"));
    I.add([]);

    heading(I, "Custom cost lines", 4);
    I.add([null, txt("Name", "subhead"), txt("Amount", "subhead", { align: "right" })]);
    var customRows = inp.custom.map(function (c) { return { name: c.name, amount: c.amount }; });
    for (var b = 0; b < BLANK_CUSTOM_ROWS; b++) customRows.push({ name: "", amount: null });
    var cFirst = 0, cLast = 0;
    customRows.forEach(function (c, i) {
      var row = I.add([null, cell(c.name, "text", "input", { name: "Custom_" + (i + 1) + "_Name" }),
        cell(c.amount, "money", "input", { name: "Custom_" + (i + 1) + "_Amount", dv: { type: "min0" } })]);
      if (!cFirst) cFirst = row;
      cLast = row;
    });
    I.range("CustomAmounts", 3, cFirst, cLast);
    I.add([null, txt("Blank rows are there to add lines.", "muted")]);
    I.add([]);

    heading(I, "Other", 4);
    inRow("Contingency", yPct(inp.contingencyPct, "ContingencyPct"), null, X.CONTINGENCY_HINT);
    inRow("Other income (merch, sponsor)", yMoney(inp.otherIncome, "OtherIncome"));
    I.add([]);

    // Offer (padded) costs: blank means "same as the amount above".
    heading(I, "Offer (padded costs)", 4);
    I.add([null, txt("What the offer shows the artist. Leave a cell blank to use the amount above; a cost that's off stays off.", "muted", { span: 4, wrap: true })]);
    X.OFFER_ROWS.forEach(function (o) {
      var ov = inp.offerAmounts[o.key];
      inRow("Offer: " + o.label.charAt(0).toLowerCase() + o.label.slice(1),
        cell(ov === undefined ? null : ov, "money", "input", { name: "Offer_" + o.key, dv: { type: "min0" } }), null, "Blank = same as above.");
    });
    I.add([null, txt("Offer-only lines", "subhead"), txt("Amount", "subhead", { align: "right" })]);
    var offerLineRows = inp.offerExtra.map(function (c) { return { name: c.name, amount: c.amount }; });
    for (var ob = 0; ob < BLANK_CUSTOM_ROWS; ob++) offerLineRows.push({ name: "", amount: null });
    var oFirst = 0, oLast = 0;
    offerLineRows.forEach(function (c, i) {
      var row = I.add([null, cell(c.name, "text", "input", { name: "OfferLine_" + (i + 1) + "_Name" }),
        cell(c.amount, "money", "input", { name: "OfferLine_" + (i + 1) + "_Amount", dv: { type: "min0" } })]);
      if (!oFirst) oFirst = row;
      oLast = row;
    });
    I.range("OfferLineAmounts", 3, oFirst, oLast);
    I.add([]);

    // Link back to the calculator: PAGE_URL#q=n=..&key=value for every input that differs from LINK_BASE.
    heading(I, "Link back to the calculator", 4);
    I.add([null, linkCell()]);
    var Q = [ // [model key, sheet name, kind]
      ["venueName", "VenueName", "text"], ["showName", "ShowName", "text"], ["capacity", "Capacity", "int"], ["comps", "Comps", "int"],
      ["price", "Price", "money"], ["expectedPct", "ExpectedPct", "pct"], ["onlinePct", "OnlinePct", "pct"], ["doorPriceOn", "DoorPriceOn", "bool"],
      ["doorPrice", "DoorPrice", "money"], ["doorCashPct", "DoorCashPct", "pct"], ["doorCardPct", "DoorCardPct", "pct"], ["doorCardFixed", "DoorCardFixed", "money"],
      ["taxOn", "TaxOn", "bool"], ["taxRate", "TaxRate", "pct"], ["taxMode", "TaxMode", TAX_LABEL], ["ticketPlatform", "Platform", "text"],
      ["ebServicePct", "SvcPct", "pct"], ["ebServiceFixed", "SvcFixed", "money"], ["ebProcPct", "ProcPct", "pct"], ["ebMode", "FeeMode", FEE_LABEL],
      ["ebCapOn", "FeeCapOn", "bool"], ["ebCap", "FeeCap", "money"],
      ["doorCutOn", "DoorCutOn", "bool"], ["doorCutPct", "DoorCutPct", "pct"], ["doorCutBasis", "DoorCutBasis", CUT_LABEL],
      ["venueRentalOn", "VenueRentalOn", "bool"], ["venueRental", "VenueRental", "money"], ["venuePerHeadOn", "PerHeadOn", "bool"], ["venuePerHead", "PerHead", "money"],
      ["hlGuaranteeOn", "HLGuaranteeOn", "bool"], ["hlGuarantee", "HLGuarantee", "money"], ["hlPctOn", "HLPctOn", "bool"], ["hlPct", "HLPct", "pct"],
      ["hlPctBasis", "HLPctBasis", BASIS_LABEL], ["hlPctStart", "HLPctStart", START_LABEL], ["hlPctStartN", "HLPctStartN", "int"],
      ["hlPerTicketOn", "HLPerTicketOn", "bool"], ["hlPerTicket", "HLPerTicket", "money"], ["hlPerTicketStart", "HLPerTicketStart", START_LABEL],
      ["hlPerTicketStartN", "HLPerTicketStartN", "int"], ["hlBackendOn", "HLBackendOn", "bool"], ["hlBackendPct", "HLBackendPct", "pct"], ["hlVersus", "HLVersus", "yes"],
      ["hlCapOn", "HLCapOn", "bool"], ["hlCap", "HLCap", "money"], ["hlBonusOn", "HLBonusOn", "bool"],
      ["hlTravel", "HLTravel", "money"], ["hlHospitality", "HLHospitality", "money"], ["supportSlots", "SupportSlots", "int"], ["supportPrice", "SupportPrice", "money"],
      ["vjOn", "VJOn", "bool"], ["vj", "VJFee", "money"], ["ldOn", "LDOn", "bool"], ["ld", "LDFee", "money"], ["soundTechsOn", "SoundTechsOn", "bool"], ["soundTechs", "SoundTechs", "int"],
      ["soundTechPay", "SoundTechPay", "money"], ["stagehandsOn", "StagehandsOn", "bool"], ["stagehands", "Stagehands", "int"], ["stagehandPay", "StagehandPay", "money"],
      ["securityOn", "SecurityOn", "bool"], ["security", "Security", "money"], ["soundOn", "SoundRentalOn", "bool"], ["sound", "SoundRental", "money"],
      ["gearOn", "GearOn", "bool"], ["gear", "Gear", "money"], ["photo", "Photo", "money"], ["ads", "Ads", "money"], ["poster", "Poster", "money"],
      ["insuranceOn", "InsuranceOn", "bool"], ["insurance", "Insurance", "money"], ["contingencyPct", "ContingencyPct", "pct"], ["otherIncome", "OtherIncome", "money"]
    ];
    function qPiece(q) {
      var key = q[0], nm = q[1], kind = q[2], base = X.LINK_BASE[key], e, b;
      if (kind === "text") { e = nm + '&""'; b = str(base); return "IF(" + e + "<>" + b + ',"&' + key + '="&' + urlEnc(e) + ',"")'; }
      if (kind === "money") { e = "ROUND(" + nm + ",2)"; b = base; }
      else if (kind === "int") { e = "ROUND(" + nm + ",0)"; b = base; }
      else if (kind === "pct") { e = "ROUND(" + nm + "*100,6)"; b = base; }
      else if (kind === "bool") { e = "IF(" + nm + '="On",1,0)'; b = base ? 1 : 0; }
      else if (kind === "yes") { e = "IF(" + nm + '="Yes",1,0)'; b = base ? 1 : 0; }
      else { e = enumF(nm, kind); b = str(base); }
      return "IF(" + e + "<>" + b + ',"&' + key + '="&' + e + ',"")';
    }
    var linkParts = [], per = 12;
    for (var qi = 0; qi < Q.length; qi += per) linkParts.push(Q.slice(qi, qi + per).map(qPiece).join("&"));
    var custParts = customRows.map(function (c, i) {
      var nm = "Custom_" + (i + 1) + "_Name", am = "Custom_" + (i + 1) + "_Amount";
      return "IF(AND(" + nm + '="",' + am + '=""),"","&c' + (i + 1) + '="&' + urlEnc(nm + '&""') + '&"~"&ROUND(N(' + am + "),2))";
    });
    for (var ci2 = 0; ci2 < custParts.length; ci2 += 8) linkParts.push(custParts.slice(ci2, ci2 + 8).join("&")); // keeps each formula well under Excel's 8,192 characters
    var bonusParts = [];
    for (var bq = 1; bq <= BONUS_SLOTS; bq++) {
      var bt = "Bonus_" + bq + "_Trigger";
      bonusParts.push("IF(" + bt + '="","","&b' + bq + '="&' + enumF(bt, TRIGGER_LABEL) + '&"~"&ROUND(N(Bonus_' + bq + '_Number),6)&"~"&ROUND(N(Bonus_' + bq + "_Amount),2))");
    }
    linkParts.push(bonusParts.join("&"));
    var offerParts = X.OFFER_ROWS.map(function (o) {
      var nm = "Offer_" + o.key;
      return "IF(" + nm + '="","","&o_' + o.key + '="&ROUND(N(' + nm + "),2))";
    });
    for (var op = 0; op < offerParts.length; op += 7) linkParts.push(offerParts.slice(op, op + 7).join("&"));
    var lineParts = offerLineRows.map(function (c, i) {
      var nm = "OfferLine_" + (i + 1) + "_Name", am = "OfferLine_" + (i + 1) + "_Amount";
      return "IF(AND(" + nm + '="",' + am + '=""),"","&x' + (i + 1) + '="&' + urlEnc(nm + '&""') + '&"~"&ROUND(N(' + am + "),2))";
    });
    for (var lp = 0; lp < lineParts.length; lp += 8) linkParts.push(lineParts.slice(lp, lp + 8).join("&"));
    var partNames = [];
    linkParts.forEach(function (f, i) {
      partNames.push("Link_Part_" + (i + 1));
      I.add([null, txt(i ? "" : "Link pieces (used by the formula below)", "muted"), fx(f, "", "text", "work", { name: "Link_Part_" + (i + 1) })]);
    });
    inRow(txt("Link (copy this if the link above doesn't open)", "label"),
      fx(str(X.PAGE_URL + "#q=n=") + "&ChosenN&" + partNames.join("&"), ctx.link, "text", "muted", { name: "CalcLink", span: 3 }));
    I.add([]);

    heading(I, "Working values", 4);
    inRow("Capacity used (whole, at least 1)", fx("MAX(1,ROUND(Capacity,0))", inp.capacity, "int", "work", { name: "CapEff" }));
    inRow("Comps used (whole, at most capacity)", fx("MIN(ROUND(Comps,0),CapEff)", inp.comps, "int", "work", { name: "CompsEff" }));
    inRow("Table rows (largest ticket count in the sheet)", fx(String(MAXR), MAXR, "int", "work", { name: "MaxRows" }),
      null, fx('IF(Sellable>MaxRows,"Too many tickets for this sheet: export again from the calculator.","")', "", "text", "muted"));
    inRow("Sales tax rate used", fx('IF(TaxOn="On",TaxRate,0)', inp.taxOn ? inp.taxRate / 100 : 0, "pct", "work", { name: "TaxR", fmt: FMT.pctIn }));

    // ---------- By ticket count (built before the sheets that read it; listed last)
    var B = new Sheet("By ticket count", [], LIGHT.ink2);
    sheets.byT = B;
    var COLS = [
      // key, header, width, kind ('res' result column, 'tix' ticket side, 'work' headliner working), type
      ["n", "Tickets", 9, "res", "int"],
      ["online", "Online", 9, "res", "int"],
      ["door", "Door", 9, "res", "int"],
      ["paid", "Buyers paid", 14, "res", "money"],
      ["ntr", "Net ticket revenue", 16, "res", "money"],
      ["hlpay", "Headliner pay", 14, "res", "money"],
      ["costs", "Total costs", 14, "res", "money"],
      ["net", "Net", 14, "res", "money"],
      ["note", "", 22, "res", "text"],
      ["gap", "", 3, "gap", "text"],
      ["doorCard", "Door card tickets", 11, "tix", "int"],
      ["gross", "Gross face", 13, "tix", "money"],
      ["faceNet", "Face net of tax", 13, "tix", "money"],
      ["tax", "Sales tax", 12, "tix", "money"],
      ["fees", null, 12, "tix", "money"],
      ["passed", "Fees paid by buyers", 12, "tix", "money"],
      ["absorbed", "Fees we absorb", 12, "tix", "money"],
      ["doorProc", "Door card processing", 12, "tix", "money"],
      ["cutBasis", "Venue % basis", 13, "tix", "money"],
      ["doorCut", "Venue % of door", 12, "tix", "money"],
      ["perHead", "Per-head fee", 12, "tix", "money"],
      ["paidOn", "Buyers paid online", 13, "tix", "money"],
      ["paidDoor", "Buyers paid at door", 13, "tix", "money"],
      ["base", "Net before bonus parts", 14, "work", "money"],
      ["basis", "Headliner % basis", 13, "work", "money"],
      ["pctPart", "% part", 11, "work", "money"],
      ["ptPart", "$ per ticket part", 11, "work", "money"],
      ["bonus", "Ticket bonuses", 11, "work", "money"],
      ["deal", "Deal pay", 11, "work", "money"],
      ["nbb", "Net before backend", 14, "work", "money"],
      ["backend", "Backend", 11, "work", "money"],
      ["baseFlag", "Past headliner break-even", 10, "work", "int"],
      ["netFlag", "Past show break-even", 10, "work", "int"],
      ["offerFlag", "Past offer break-even", 10, "work", "int"]
    ];
    var C = {};
    COLS.forEach(function (c, i) { C[c[0]] = i + 1; });
    B.columns = COLS.map(function (c) { return c[2]; });
    function L$(key) { return colLetter(C[key]); }
    B.add([txt("By ticket count", "title")]);
    B.add([fx("ScenarioTitle", ctx.title, "text", "label", { bold: true })]);
    B.add([fx('"One row per ticket count at "&' + moneyTextAuto("Price") + '&" a ticket, up to the sellable tickets. Every number is a formula."',
      "One row per ticket count at " + X.priceText(inp.price) + " a ticket, up to the sellable tickets. Every number is a formula.", "text", "muted", { span: 9 })]);
    B.add([txt("Chosen count", "label", { bold: true, span: 2 }), null,
      fx("MIN(MAX(ROUND(TicketsSold,0),0),Sellable)", n, "int", "total", { name: "ChosenN" }), txt("From Tickets sold on Inputs.", "muted", { span: 4 })]);
    B.add([txt("Results", "band", { span: 9 }), null, null, null, null, null, null, null, null, null,
      txt("Ticket side", "band", { span: 13, fill: "#ecebe6" }), null, null, null, null, null, null, null, null, null, null, null, null,
      txt("Headliner and profit", "band", { span: 11 })]);
    var head = B.add(COLS.map(function (c) {
      if (c[0] === "gap") return null;
      if (c[0] === "fees") return fx(platF("", " fees"), pn + " fees", "text", "colhead", { wrap: true, align: "right" });
      return txt(c[1], "colhead", { wrap: true, align: c[4] === "text" ? "left" : "right" });
    }));
    var r0 = head + 1, rN = head + 1 + MAXR;
    B.freeze = head; B.freezeCols = 1;
    var ARGS = function (R) { return function (key) { return L$(key) + R; }; };
    for (var kk = 0; kk <= MAXR; kk++) {
      var R = r0 + kk, row = [], ref = ARGS(R), x = rs[kk];
      var blank = !x;
      var g = function (f) { return 'IF(' + ref("n") + '="","",' + f + ")"; };
      var v = function (val) { return blank ? "" : val; };
      var basis = x ? basisValue(x, inp.hlPctBasis) : "";
      var base = x ? x.netTicketRevenue + inp.otherIncome - x.fixedCostsTotal : "";
      var vals2 = {
        n: fx("IF(" + kk + "<=Sellable," + kk + ',"")', v(kk), "int", "label"),
        online: fx(g("ROUND(ROUND(" + ref("n") + "*OnlinePct,9),0)"), v(x && x.counts.online), "int", "snap"),
        door: fx(g(ref("n") + "-" + ref("online")), v(x && x.counts.door), "int", "snap"),
        paid: fx(g(ref("paidOn") + "+" + ref("paidDoor")), v(x && x.buyersPaid), "money", "snap"),
        ntr: fx(g(ref("faceNet") + "-" + ref("absorbed") + "-" + ref("doorProc") + "-" + ref("doorCut") + "-" + ref("perHead")), v(x && x.netTicketRevenue), "money", "snap"),
        hlpay: fx(g(ref("deal") + "+" + ref("backend")), v(x && x.headliner.pay), "money", "label"),
        costs: fx(g("FixedTotal+(" + ref("deal") + "-GuaranteeAmt)+" + ref("backend")), v(x && x.totalCosts), "money", "label"),
        net: fx(g(ref("nbb") + "-" + ref("backend")), v(x && x.net), "money", "label", { bold: true }),
        note: fx(g('IF(' + ref("n") + '=BreakEven,"Break-even","")&IF(AND(' + ref("n") + '=BreakEven,' + ref("n") + '=ChosenN),", ","")&IF(' + ref("n") + '=ChosenN,"Chosen count","")'),
          blank ? "" : (be === kk ? "Break-even" : "") + (be === kk && n === kk ? ", " : "") + (n === kk ? "Chosen count" : ""), "text", "label", { bold: true }),
        gap: null,
        doorCard: fx(g(ref("door") + "-ROUND(ROUND(" + ref("door") + "*DoorCashPct,9),0)"), v(x && x.counts.doorCard), "int", "snap"),
        gross: fx(g(ref("online") + "*Price+" + ref("door") + "*PT_DP"), v(x && x.grossFace), "money", "snap"),
        faceNet: fx(g(ref("online") + "*PT_fn+" + ref("door") + "*PT_dfn"), v(x && x.faceNet), "money", "snap"),
        tax: fx(g(ref("online") + "*PT_tx+" + ref("door") + "*PT_dtx"), v(x && x.tax), "money", "snap"),
        fees: fx(g(ref("online") + "*PT_fee"), v(x && x.eventbrite.total), "money", "snap"),
        passed: fx(g(ref("online") + "*PT_pass"), v(x && x.eventbrite.passed), "money", "snap"),
        absorbed: fx(g(ref("online") + "*PT_abs"), v(x && x.eventbrite.absorbed), "money", "snap"),
        doorProc: fx(g(ref("doorCard") + "*PT_dcp"), v(x && x.doorProc), "money", "snap"),
        cutBasis: fx(g("IF(DoorCutBasis=" + str(CUT_LABEL.afterTax) + "," + ref("faceNet") + ",IF(DoorCutBasis=" + str(CUT_LABEL.afterTaxFees) + "," +
          ref("faceNet") + "-" + ref("absorbed") + "-" + ref("doorProc") + "," + ref("online") + "*PT_gr+" + ref("door") + "*PT_dgr))"), v(x && x.doorCutBasis), "money", "snap"),
        doorCut: fx(g('IF(DoorCutOn="On",MAX(0,' + ref("cutBasis") + ")*DoorCutPct,0)"), v(x && x.doorCut), "money", "snap"),
        perHead: fx(g('IF(PerHeadOn="On",(' + ref("n") + "+CompsEff)*PerHead,0)"), v(x && x.venue.perHead), "money", "snap"),
        paidOn: fx(g(ref("online") + "*PT_buyer"), v(x && x.buyersPaidOnline), "money", "snap"),
        paidDoor: fx(g(ref("door") + "*PT_dgr"), v(x && x.buyersPaidDoor), "money", "snap"),
        base: fx(g(ref("ntr") + "+OtherIncome-FixedTotal"), v(base), "money", "work"),
        basis: fx(g('IF(HLPctBasis="' + BASIS_LABEL.grossFace + '",' + ref("gross") + ',IF(HLPctBasis="' + BASIS_LABEL.net + '",' + ref("ntr") + "," + ref("faceNet") + "))"), v(basis), "money", "work"),
        pctPart: fx(g('IF(AND(HLPctOn="On",' + ref("n") + ">PctThreshold),MAX(0," + ref("basis") + "-PctBasisAtStart)*HLPct,0)"), v(x && x.headliner.pctPart), "money", "work"),
        ptPart: fx(g('IF(HLPerTicketOn="On",MAX(0,' + ref("n") + "-PerTicketThreshold)*HLPerTicket,0)"), v(x && x.headliner.perTicketPart), "money", "work"),
        bonus: fx(g(bonusF(ref("n"))), v(x && x.headliner.bonusPart), "money", "work"),
        deal: fx(g(capDeal(preBonusF(ref("pctPart"), ref("ptPart")) + "+" + ref("bonus"))), v(x && x.headliner.dealPay), "money", "work"),
        nbb: fx(g(ref("ntr") + "+OtherIncome-FixedTotal-(" + ref("deal") + "-GuaranteeAmt)"), v(x && x.netBeforeBackend), "money", "work"),
        backend: fx(g(capBackend('IF(HLBackendOn="On",MAX(0,' + ref("nbb") + ")*HLBackendPct,0)", ref("deal"))), v(x && x.headliner.backend), "money", "work"),
        baseFlag: fx(g("IF(" + ref("base") + ">=-" + EPS + ",1,0)"), v(base >= -1e-9 ? 1 : 0), "int", "work"),
        netFlag: fx(g("IF(" + ref("net") + ">=-" + EPS + ",1,0)"), v(x && x.net >= -1e-9 ? 1 : 0), "int", "work"),
        offerFlag: fx(g("IF(" + ref("base") + "-OfferDelta>=-" + EPS + ",1,0)"), v(x ? (base - oDelta >= -1e-9 ? 1 : 0) : ""), "int", "work")
      };
      COLS.forEach(function (c) { row.push(vals2[c[0]]); });
      B.add(row);
    }
    var BYT = {
      n: "ByT_Tickets", online: "ByT_Online", door: "ByT_Door", paid: "ByT_BuyersPaid", ntr: "ByT_NTR", hlpay: "ByT_HLPay", costs: "ByT_TotalCosts", net: "ByT_Net",
      doorCard: "ByT_DoorCard", gross: "ByT_GrossFace", faceNet: "ByT_FaceNet", tax: "ByT_Tax", fees: "ByT_Fees", passed: "ByT_FeesPassed", absorbed: "ByT_FeesAbsorbed",
      doorProc: "ByT_DoorProc", cutBasis: "ByT_CutBasis", doorCut: "ByT_DoorCut", perHead: "ByT_PerHead", paidOn: "ByT_PaidOnline", paidDoor: "ByT_PaidDoor",
      basis: "ByT_HLBasis", pctPart: "ByT_PctPart", ptPart: "ByT_PerTicketPart", bonus: "ByT_Bonus", deal: "ByT_DealPay", backend: "ByT_Backend", baseFlag: "ByT_BaseFlag", netFlag: "ByT_NetFlag", offerFlag: "ByT_OfferFlag"
    };
    Object.keys(BYT).forEach(function (key) { B.range(BYT[key], C[key], r0, rN); });
    B.signCF("$" + L$("net") + "$" + r0 + ":$" + L$("net") + "$" + rN);
    B.cf.push({ ref: "$A$" + r0 + ":$" + L$("note") + "$" + rN, kind: "rowMark", noteCol: L$("note"), first: r0 });
    B.chart = { headerRow: head, firstRow: r0, lastRow: rN, nCol: C.n, netCol: C.net, payCol: C.hlpay };

    // ---------- Price math (helper for the price grid and the break-even price)
    var P = buildPriceMath(inp, n, S, MAXR, M, sheets);

    // ---------- Costs
    var Co = new Sheet("Costs", [2, 60, 18, 12], LIGHT.s7);
    sheets.costs = Co;
    topBlock(Co, "Costs", ctx);
    heading(Co, "Cost ledger at the chosen count");
    Co.add([null, fx('"At "&ChosenN&" tickets"', "At " + n + " tickets", "text", "muted")]);
    function line(label, f, val, name, extra) { return Co.add([null, txt(label, "label", { indent: 1 }), fx(f, val, "money", "label", Object.assign({ name: name }, extra || {}))]); }
    function sub(label, f, val) { return Co.add([null, txt(label, "subtotal"), fx(f, val, "money", "subtotal")]); }
    function group(title) { Co.add([null, txt(title, "subhead", { span: 2 })]); }
    group("Talent");
    line("Headliner pay", "HLPayAtCount", h.pay);
    Co.add([null, txt("Ticket bonuses (part of headliner pay)", "muted", { indent: 2 }),
      fx(idx("ByT_DealPay") + "-" + capDeal(preBonusF(idx("ByT_PctPart"), idx("ByT_PerTicketPart"))), h.bonusPaid, "money", "muted", { name: "BonusAmt" })]);
    line("Headliner travel / hotel and hospitality", "HLTravel+HLHospitality", L.headlinerTravel + L.headlinerHospitality);
    line("Supporting artists (slots x price per slot)", "SupportSlots*SupportPrice", L.support, "SupportAmt");
    sub("Talent subtotal", "HLPayAtCount+HLTravel+HLHospitality+SupportAmt", talentTotal);
    Co.add([]);
    group("Venue");
    line("Flat rental / fee", 'IF(VenueRentalOn="On",VenueRental,0)', L.venueRental, "VenueRentalAmt");
    Co.add([null, txt("% of door and per-head fee (already out of ticket revenue, not counted again)", "muted", { indent: 1, wrap: true }),
      fx(idx("ByT_DoorCut") + "+" + idx("ByT_PerHead"), r.venue.doorCut + r.venue.perHead, "money", "muted")]);
    sub("Venue rental subtotal", "VenueRentalAmt", L.venueRental);
    Co.add([]);
    group("Labor");
    line("Sound techs (people x pay each)", 'IF(SoundTechsOn="On",SoundTechs*SoundTechPay,0)', L.soundTechs, "SoundTechsAmt");
    line("Stagehands (people x pay each)", 'IF(StagehandsOn="On",Stagehands*StagehandPay,0)', L.stagehands, "StagehandsAmt");
    sub("Labor subtotal", "SoundTechsAmt+StagehandsAmt", laborAmt);
    Co.add([]);
    group("Production");
    line("Contracted security (flat)", 'IF(SecurityOn="On",Security,0)', L.security, "SecurityAmt");
    line("Sound rental", 'IF(SoundRentalOn="On",SoundRental,0)', L.sound, "SoundAmt");
    line("Additional deck / gear", 'IF(GearOn="On",Gear,0)', L.gear, "GearAmt");
    line("Photo / video", "Photo", L.photo, "PhotoAmt");
    sub("Production subtotal", "SecurityAmt+SoundAmt+GearAmt+PhotoAmt", L.security + L.sound + L.gear + L.photo);
    Co.add([]);
    group("Visual production");
    line("VJ", 'IF(VJOn="On",VJFee,0)', L.vj, "VJAmt");
    line("Lighting designer (LD)", 'IF(LDOn="On",LDFee,0)', L.ld, "LDAmt");
    sub("Visual production subtotal", "VJAmt+LDAmt", L.vj + L.ld);
    Co.add([]);
    group("Marketing");
    line("Advertising budget", "Ads", L.ads, "AdsAmt");
    line("Poster design", "Poster", L.poster, "PosterAmt");
    sub("Marketing subtotal", "AdsAmt+PosterAmt", L.ads + L.poster);
    Co.add([]);
    group("Insurance");
    line("Event insurance", 'IF(InsuranceOn="On",Insurance,0)', L.insurance, "InsuranceAmt");
    sub("Insurance subtotal", "InsuranceAmt", L.insurance);
    Co.add([]);
    group("Custom cost lines");
    line("Custom cost lines (listed on Inputs)", "SUM(CustomAmounts)", L.custom, "CustomAmt");
    Co.add([]);
    Co.add([null, txt("Contingency base (fixed costs, guarantee included)", "label"),
      fx("GuaranteeAmt+HLTravel+HLHospitality+SupportAmt+VJAmt+LDAmt+VenueRentalAmt+SoundTechsAmt+StagehandsAmt+SecurityAmt+SoundAmt+GearAmt+PhotoAmt+AdsAmt+PosterAmt+InsuranceAmt+CustomAmt",
        r.contingencyBase, "money", "label", { name: "FixedBase" })]);
    Co.add([null, txt("Contingency", "label"), fx("FixedBase*ContingencyPct", r.contingency, "money", "label", { name: "Contingency" }),
      fx("ContingencyPct", inp.contingencyPct / 100, "pct", "muted", { fmt: FMT.pctIn })]);
    Co.add([null, txt(X.CONTINGENCY_HINT, "muted", { span: 3, wrap: true })]);
    Co.add([null, txt("Fixed costs with contingency", "label"), fx("FixedBase+Contingency", r.fixedCostsTotal, "money", "label", { name: "FixedTotal" })]);
    Co.add([null, txt("Total costs at the chosen count", "total"), fx(idx("ByT_TotalCosts"), r.totalCosts, "money", "total", { name: "TotalCostsAtCount" })]);
    Co.add([]);
    heading(Co, "Net");
    Co.add([null, txt("Net ticket revenue (after tax, fees and the venue's cut)", "label"), fx(idx("ByT_NTR"), r.netTicketRevenue, "money", "label", { name: "NTRAtCount" })]);
    Co.add([null, txt("Other income (merch, sponsor)", "label"), fx("OtherIncome", inp.otherIncome, "money", "label")]);
    Co.add([null, txt("Minus total costs", "label"), fx("-TotalCostsAtCount", -r.totalCosts, "money", "label")]);
    var netRow = Co.add([null, fx('"Net at "&ChosenN&" tickets"', "Net at " + n + " tickets", "text", "total"), fx(idx("ByT_Net"), r.net, "money", "total", { name: "NetAtCount" })]);
    Co.signCF("$C$" + netRow);
    Co.add([]);
    heading(Co, "Costs by category");
    Co.add([null, txt("Category", "subhead"), txt("Amount", "subhead", { align: "right" })]);
    [["Talent", "HLPayAtCount+HLTravel+HLHospitality+SupportAmt", talentTotal],
     ["Venue rental", "VenueRentalAmt", L.venueRental],
     ["Labor", "SoundTechsAmt+StagehandsAmt", laborAmt],
     ["Production", "SecurityAmt+SoundAmt+GearAmt+PhotoAmt", L.security + L.sound + L.gear + L.photo],
     ["Visual production", "VJAmt+LDAmt", L.vj + L.ld],
     ["Marketing", "AdsAmt+PosterAmt", L.ads + L.poster],
     ["Insurance", "InsuranceAmt", L.insurance],
     ["Custom", "CustomAmt", L.custom],
     ["Contingency", "Contingency", r.contingency]].forEach(function (c) { Co.add([null, txt(c[0], "label"), fx(c[1], c[2], "money", "label")]); });
    Co.add([null, txt("Total costs", "total"), fx("TotalCostsAtCount", r.totalCosts, "money", "total")]);
    Co.add([]);

    heading(Co, "Offer (padded) costs");
    Co.add([null, txt("What the offer shows the artist. Offer cells left blank on Inputs use the amounts above.", "muted", { span: 3, wrap: true })]);
    function eff(key, trueName) { return 'IF(Offer_' + key + '="",' + trueName + ",Offer_" + key + ")"; }
    function onEff(flag, key, trueName, people) { return "IF(" + flag + '="On",' + (people ? people + "*" : "") + eff(key, trueName) + ",0)"; }
    group("Offer amounts");
    line("Headliner guarantee (same as above)", "GuaranteeAmt", guaranteeAmt);
    line("Headliner travel / hotel", eff("hlTravel", "HLTravel"), OL.headlinerTravel, "OfferTravelAmt");
    line("Headliner hospitality / rider", eff("hlHospitality", "HLHospitality"), OL.headlinerHospitality, "OfferHospAmt");
    line("Supporting artists (slots x price per slot)", "SupportSlots*" + eff("supportPrice", "SupportPrice"), OL.support, "OfferSupportAmt");
    line("VJ", onEff("VJOn", "vj", "VJFee"), OL.vj, "OfferVJAmt");
    line("Lighting designer (LD)", onEff("LDOn", "ld", "LDFee"), OL.ld, "OfferLDAmt");
    line("Flat rental / fee", onEff("VenueRentalOn", "venueRental", "VenueRental"), OL.venueRental, "OfferVenueRentalAmt");
    line("Sound techs (people x pay each)", onEff("SoundTechsOn", "soundTechPay", "SoundTechPay", "SoundTechs"), OL.soundTechs, "OfferSoundTechsAmt");
    line("Stagehands (people x pay each)", onEff("StagehandsOn", "stagehandPay", "StagehandPay", "Stagehands"), OL.stagehands, "OfferStagehandsAmt");
    line("Contracted security (flat)", onEff("SecurityOn", "security", "Security"), OL.security, "OfferSecurityAmt");
    line("Sound rental", onEff("SoundRentalOn", "sound", "SoundRental"), OL.sound, "OfferSoundAmt");
    line("Additional deck / gear", onEff("GearOn", "gear", "Gear"), OL.gear, "OfferGearAmt");
    line("Photo / video", eff("photo", "Photo"), OL.photo, "OfferPhotoAmt");
    line("Advertising budget", eff("ads", "Ads"), OL.ads, "OfferAdsAmt");
    line("Poster design", eff("poster", "Poster"), OL.poster, "OfferPosterAmt");
    line("Event insurance", onEff("InsuranceOn", "insurance", "Insurance"), OL.insurance, "OfferInsuranceAmt");
    line("Custom cost lines (same as above)", "CustomAmt", L.custom);
    line("Offer-only lines (listed on Inputs)", "SUM(OfferLineAmounts)", offerLinesSum, "OfferLinesAmt");
    Co.add([null, txt("Offer contingency base", "label"),
      fx("GuaranteeAmt+OfferTravelAmt+OfferHospAmt+OfferSupportAmt+OfferVJAmt+OfferLDAmt+OfferVenueRentalAmt+OfferSoundTechsAmt+OfferStagehandsAmt+OfferSecurityAmt+OfferSoundAmt+OfferGearAmt+OfferPhotoAmt+OfferAdsAmt+OfferPosterAmt+OfferInsuranceAmt+CustomAmt+OfferLinesAmt",
        oAt.contingencyBase, "money", "label", { name: "OfferFixedBase" })]);
    Co.add([null, txt("Offer contingency", "label"), fx("OfferFixedBase*ContingencyPct", oAt.contingency, "money", "label", { name: "OfferContingency" })]);
    Co.add([null, txt("Offer fixed costs with contingency", "subtotal"), fx("OfferFixedBase+OfferContingency", oAt.fixedCostsTotal, "money", "subtotal", { name: "OfferFixedTotal" })]);
    Co.add([null, txt("The offer adds to fixed costs", "label"), fx("OfferFixedTotal-FixedTotal", oDelta, "money", "label", { name: "OfferDelta" })]);

    // ---------- Talent
    var T = new Sheet("Talent", [2, 62, 18, 40], LIGHT.s4);
    sheets.talent = T;
    topBlock(T, "Talent", ctx);
    heading(T, "Headliner payout at the chosen count");
    function trow(label, f, val, extra, s) { return T.add([null, txt(label, s || "label", { indent: s ? undefined : 1 }), fx(f, val, "money", s || "label", extra)]); }
    trow("Guarantee", 'IF(HLGuaranteeOn="On",HLGuarantee,0)', guaranteeAmt, { name: "GuaranteeAmt" });
    trow("% of ticket sales part", idx("ByT_PctPart"), h.pctPart);
    trow("$ per ticket part", idx("ByT_PerTicketPart"), h.perTicketPart);
    trow("Ticket bonuses", idx("ByT_Bonus"), h.bonusPart);
    trow("Deal pay (versus takes the greater of the guarantee or the % and per-ticket parts; ticket bonuses on top)", idx("ByT_DealPay"), h.dealPay);
    trow("Backend (% of profit)", idx("ByT_Backend"), h.backend);
    trow("Headliner pay", idx("ByT_HLPay"), h.pay, { name: "HLPayAtCount" }, "subtotal");
    trow("Travel / hotel", "HLTravel", h.travel);
    trow("Hospitality / rider", "HLHospitality", h.hospitality);
    trow("Headliner all-in", "HLPayAtCount+HLTravel+HLHospitality", h.total, { name: "HLAllIn" }, "total");
    T.add([]);
    heading(T, "When the bonus parts start");
    T.add([null, txt("Headliner break-even (guarantee and all other costs, no bonus parts)", "label", { wrap: true }),
      fx('IFERROR(MATCH(1,ByT_BaseFlag,0)-1,"never")', hlBE === null ? "never" : hlBE, "auto", "label", { name: "HLBreakEven" }), txt("tickets", "muted")]);
    T.add([null, txt("% part pays on tickets after", "label"),
      fx('IF(PctThreshold>=' + NEVER + ',"never",PctThreshold)', pctThr >= NEVER ? "never" : pctThr, "auto", "label"), txt("tickets", "muted")]);
    T.add([null, txt("$ per ticket part pays on tickets after", "label"),
      fx('IF(PerTicketThreshold>=' + NEVER + ',"never",PerTicketThreshold)', ptThr >= NEVER ? "never" : ptThr, "auto", "label"), txt("tickets", "muted")]);
    T.add([]);
    heading(T, "Total talent cost");
    trow("Headliner all-in (pay, travel, rider)", "HLAllIn", h.total);
    trow("Supporting artists", "SupportAmt", L.support);
    trow("Total talent cost", "HLAllIn+SupportAmt", talentTotal, null, "total");
    T.add([]);
    heading(T, "Working values");
    T.add([null, txt("Used by the formulas. " + NEVER.toLocaleString("en-US") + " stands for never.", "muted", { span: 3 })]);
    T.add([null, txt("% part threshold (tickets)", "label"), fx(startF("HLPctStart", "HLPctStartN", "HLBreakEven"), pctThr, "int", "work", { name: "PctThreshold" })]);
    T.add([null, txt("$ per ticket part threshold (tickets)", "label"), fx(startF("HLPerTicketStart", "HLPerTicketStartN", "HLBreakEven"), ptThr, "int", "work", { name: "PerTicketThreshold" })]);
    T.add([null, txt("% basis at the threshold", "label"), fx("IF(PctThreshold>0,INDEX(ByT_HLBasis,MIN(PctThreshold,Sellable)+1),0)", pctBasisAtStart, "money", "work", { name: "PctBasisAtStart" })]);
    for (var ba = 1; ba <= BONUS_SLOTS; ba++) {
      var bRow = inp.hlBonuses[ba - 1];
      T.add([null, txt("Ticket bonus " + ba + " pays from (tickets)", "label"), fx('IF(AND(HLBonusOn="On",Bonus_' + ba + '_Trigger<>""),Bonus_' + ba + "_PaysFrom," + NEVER + ")",
        inp.hlBonusOn && bRow ? M.bonusAt(bRow, S) : NEVER, "int", "work", { name: "BonusAt_" + ba })]);
    }

    // ---------- Tickets & fees
    var Tk = new Sheet("Tickets & fees", [2, 56, 18, 10], LIGHT.s1);
    sheets.tickets = Tk;
    topBlock(Tk, "Tickets & fees", ctx);
    heading(Tk, "Per ticket");
    Tk.add([null, fx(moneyText("Price", true) + '&" face price"&IF(DoorPriceOn="On",", "&' + moneyText("DoorPrice", true) + '&" at the door","")',
      X.fmt$(inp.price, { cents: true }) + " face price" + (inp.doorPriceOn ? ", " + X.fmt$(inp.doorPrice, { cents: true }) + " at the door" : ""), "text", "muted")]);
    var ptF = ptFormulas("Price", "PT_DP", function (key) { return "PT_" + key; });
    function ptRow(label, key, st, extra) {
      var lab = typeof label === "string" ? txt(label, st === "sub" ? "label" : st || "label", { indent: st === "sub" ? 1 : undefined }) : label;
      Tk.add([null, lab, fx(ptF[key], pt[key], "money", st === "total" ? "total" : "label", Object.assign({ name: "PT_" + key }, extra || {}))]);
    }
    var taxLbl = '"Sales tax "&IF(TaxOn="On",IF(TaxMode=' + str(TAX_LABEL.included) + ',"(inside the price)","(added on top)"),"(off)")';
    ptRow("Ours after sales tax", "fn");
    ptRow(fx(taxLbl, "Sales tax " + (inp.taxOn ? (inp.taxMode === "included" ? "(inside the price)" : "(added on top)") : "(off)"), "text", "label"), "tx");
    ptRow("Online price incl. sales tax", "gr");
    ptRow(fx(platF("", " service fee before any cap"), pn + " service fee before any cap", "text", "label", { indent: 1 }), "svcU", "sub");
    ptRow(fx(platF("", " fees before any cap"), pn + " fees before any cap", "text", "label", { indent: 1 }), "feeU", "sub");
    ptRow(fx(platF("", " service fee"), pn + " service fee", "text", "label", { indent: 1 }), "svc", "sub");
    ptRow(fx(platF("", " processing"), pn + " processing", "text", "label", { indent: 1 }), "proc", "sub");
    ptRow(fx(platF("", " fees ") + '&IF(FeeMode=' + str(FEE_LABEL.pass) + ',"paid by the buyer","absorbed by us")&IF(AND(FeeCapOn="On",PT_feeU>FeeCap)," (capped at "&' + moneyText("FeeCap", true) + '&")","")',
      pn + " fees " + (inp.ebMode === "pass" ? "paid by the buyer" : "absorbed by us") + (r.perTicketPrices.ebCapped ? " (capped at " + X.fmt$(inp.ebCap, { cents: true }) + ")" : ""), "text", "label"), "fee");
    ptRow("Fees we absorb, per online ticket", "abs", "sub");
    ptRow("Fees the buyer pays, per online ticket", "pass", "sub");
    ptRow("Buyer pays online", "buyer", "total", { name: "PT_buyer" });
    Tk.add([null, txt("Door face price", "label"), fx('IF(DoorPriceOn="On",DoorPrice,Price)', pt ? r.perTicketPrices.doorPrice : 0, "money", "label", { name: "PT_DP" })]);
    ptRow("Door: ours after sales tax", "dfn", "sub");
    ptRow("Door: sales tax", "dtx", "sub");
    ptRow("Door card fee (card buyers)", "dcp");
    ptRow("Buyer pays at the door", "dgr", "total");
    Tk.add([null, txt("We keep per ticket sold, after fees and the venue's cut", "total", { wrap: true }), fx('IF(ChosenN>0,NTRAtCount/ChosenN,"n/a")', r.n ? r.netTicketRevenue / r.n : "n/a", "auto", "total", { fmt: FMT.money })]);
    Tk.add([]);
    heading(Tk, "Ticket money at the chosen count");
    Tk.add([null, fx('ChosenN&" sold + "&CompsEff&" comps = "&(ChosenN+CompsEff)&" attending"', n + " sold + " + inp.comps + " comps = " + (n + inp.comps) + " attending", "text", "muted")]);
    function tm(label, f, val, t, s) {
      var lab = typeof label === "string" ? txt(label, s || "label", { indent: s === "sub" ? 1 : undefined }) : label;
      Tk.add([null, lab, fx(f, val, t || "money", s === "sub" ? "label" : (s || "label"))]);
    }
    tm(fx(platF("Online tickets (", ")"), "Online tickets (" + pn + ")", "text", "label"), idx("ByT_Online"), r.counts.online, "int");
    tm("Door tickets", idx("ByT_Door"), r.counts.door, "int");
    tm("Door tickets paid by card", idx("ByT_DoorCard"), r.counts.doorCard, "int", "sub");
    tm("Buyers paid online", idx("ByT_PaidOnline"), r.buyersPaidOnline, "money", "sub");
    tm("Buyers paid at the door", idx("ByT_PaidDoor"), r.buyersPaidDoor, "money", "sub");
    tm("Everything buyers paid", idx("ByT_BuyersPaid"), r.buyersPaid, "money", "total");
    tm("Sales tax collected (to the state)", "-" + idx("ByT_Tax"), -r.tax);
    tm(fx(platF("", " fees paid by buyers"), pn + " fees paid by buyers", "text", "label"), "-" + idx("ByT_FeesPassed"), -r.eventbrite.passed);
    tm("Ticket sales after tax", idx("ByT_FaceNet"), r.faceNet, "money", "total");
    tm(fx(platF("", " fees we absorb"), pn + " fees we absorb", "text", "label"), "-" + idx("ByT_FeesAbsorbed"), -r.eventbrite.absorbed);
    tm("Door card processing", "-" + idx("ByT_DoorProc"), -r.doorProc);
    tm("Venue % of door", "-" + idx("ByT_DoorCut"), -r.venue.doorCut);
    tm("Venue per-head fee", "-" + idx("ByT_PerHead"), -r.venue.perHead);
    tm("Net ticket revenue (ours)", "NTRAtCount", r.netTicketRevenue, "money", "total");

    // ---------- Venue
    var V = new Sheet("Venue", [2, 50, 18, 18], LIGHT.s3);
    sheets.venue = V;
    topBlock(V, "Venue", ctx);
    heading(V, "Deal");
    V.add([null, txt("% of door", "label"), fx('IF(DoorCutOn="On",DoorCutPct,0)', inp.doorCutOn ? inp.doorCutPct / 100 : 0, "pct", "label", { fmt: FMT.pctIn }),
      fx('IF(DoorCutOn="On","of "&DoorCutBasis,"off")', inp.doorCutOn ? "of " + X.CUT_SHORT[inp.doorCutBasis] : "off", "text", "muted")]);
    V.add([null, txt("Flat rental / fee", "label"), fx('IF(VenueRentalOn="On",VenueRental,0)', L.venueRental, "money", "label"), txt("Change these on Inputs", "muted")]);
    V.add([null, txt("Per-head fee", "label"), fx('IF(PerHeadOn="On",PerHead,0)', inp.venuePerHeadOn ? inp.venuePerHead : 0, "money", "label"), txt("Everyone in the room, comps included", "muted")]);
    V.add([]);
    heading(V, "What the venue takes");
    var so = rs[S];
    V.add([null, txt("Part", "subhead"), fx('"At "&ChosenN&" tickets"', "At " + n + " tickets", "text", "subhead", { align: "right" }),
      fx('"Sold out ("&Sellable&")"', "Sold out (" + S + ")", "text", "subhead", { align: "right" })]);
    V.add([null, txt("% of door", "label"), fx(idx("ByT_DoorCut"), r.venue.doorCut, "money"), fx("INDEX(ByT_DoorCut,Sellable+1)", so.venue.doorCut, "money")]);
    V.add([null, txt("Flat rental / fee", "label"), fx("VenueRentalAmt", L.venueRental, "money"), fx("VenueRentalAmt", L.venueRental, "money")]);
    V.add([null, txt("Per-head fee", "label"), fx(idx("ByT_PerHead"), r.venue.perHead, "money"), fx("INDEX(ByT_PerHead,Sellable+1)", so.venue.perHead, "money")]);
    V.add([null, txt("Venue takes", "total"), fx(idx("ByT_DoorCut") + "+VenueRentalAmt+" + idx("ByT_PerHead"), r.venue.total, "money", "total"),
      fx("INDEX(ByT_DoorCut,Sellable+1)+VenueRentalAmt+INDEX(ByT_PerHead,Sellable+1)", so.venue.doorCut + L.venueRental + so.venue.perHead, "money", "total")]);
    V.add([]);
    V.add([null, txt("The % of door and the per-head fee come out of ticket revenue. The flat rental is a cost line, so it also counts toward contingency.", "muted", { span: 3, wrap: true })]);

    // ---------- Summary
    var Su = new Sheet("Summary", [3, 40, 16, 16, 16, 14, 14, 14], LIGHT.accent);
    sheets.summary = Su;
    Su.add([null, txt("Show feasibility", "title")]);
    Su.add([null, fx("ScenarioTitle", ctx.title, "text", "label", { bold: true, span: 6 })]);
    Su.add([null, txt("Exported " + ctx.date + ". " + EDIT_NOTE, "muted", { span: 7, wrap: true })]);
    Su.add([null, linkCell()]);
    Su.add([]);
    heading(Su, "Headline numbers", 7);
    var netHead = Su.add([null, fx('"Net at "&ChosenN&" tickets"', "Net at " + n + " tickets", "text", "total"), fx("NetAtCount", r.net, "money", "total", { fmt: FMT.signed }),
      fx('IF(NetAtCount>=0.5,"Profit",IF(NetAtCount<=-0.5,"Loss","Break-even"))', X.STATUS_LABEL[X.statusOf(r.net)], "text", "muted")]);
    Su.signCF("$C$" + netHead);
    Su.add([null, txt("Show break-even", "label"), fx('IFERROR(MATCH(1,ByT_NetFlag,0)-1,"Not possible")', be === null ? "Not possible" : be, "auto", "label", { name: "BreakEven" }),
      fx('IF(ISNUMBER(BreakEven),"tickets, of "&Sellable&" sellable","even sold out")', be === null ? "even sold out" : "tickets, of " + S + " sellable", "text", "muted", { span: 3 })]);
    Su.add([null, txt("Headliner pay", "label"), fx("HLPayAtCount", h.pay, "money"), fx('"Headliner break-even: "&HLBreakEven', "Headliner break-even: " + (hlBE === null ? "never" : hlBE), "text", "muted", { span: 3 })]);
    Su.add([null, txt("Net ticket revenue", "label"), fx("NTRAtCount", r.netTicketRevenue, "money")]);
    Su.add([null, txt("Total costs", "label"), fx("TotalCostsAtCount", r.totalCosts, "money")]);
    Su.add([null, txt("Buyer pays online", "label"), fx("PT_buyer", r.buyerPaysOnline, "money", "label", { name: "BuyerPaysOnline" }),
      fx(platF("", " fees ") + '&IF(FeeMode=' + str(FEE_LABEL.pass) + ',"passed to the buyer","absorbed by us")', pn + " fees " + (inp.ebMode === "pass" ? "passed to the buyer" : "absorbed by us"), "text", "muted", { span: 3 })]);
    Su.add([null, txt("Buyer pays at the door", "label"), fx("PT_dgr", r.buyerPaysDoor, "money", "label", { name: "BuyerPaysDoor" })]);
    var bp = M.breakEvenPrice(inp, n);
    Su.add([null, fx('"Break-even price at "&ChosenN&" tickets"', "Break-even price at " + n + " tickets", "text", "label"),
      fx('IF(PM_ZeroOk=1,0,IF(ChosenN=0,"None",IF(PM_CapOk=0,"None",PM_LastHi/100)))', bp === null ? "None" : bp, "auto", "label", { name: "BreakEvenPrice", fmt: FMT.money }),
      txt("Lowest ticket price (to the cent, up to $1,000) that breaks even; the door price keeps its markup.", "muted", { span: 3 })]);
    Su.add([]);

    heading(Su, "Where the money goes", 7);
    Su.add([null, fx('"At "&ChosenN&" tickets: buyers paid, plus other income"', "At " + n + " tickets: buyers paid, plus other income", "text", "muted", { span: 4 })]);
    Su.add([null, txt("Goes to", "subhead"), txt("Amount", "subhead", { align: "right" }), txt("Share", "subhead", { align: "right" }), txt("Per ticket sold", "subhead", { align: "right" })]);
    var MONEY_F = {
      tax: idx("ByT_Tax"), ebFees: idx("ByT_Fees"), doorProc: idx("ByT_DoorProc"),
      venue: idx("ByT_DoorCut") + "+" + idx("ByT_PerHead") + "+VenueRentalAmt",
      headliner: "HLAllIn", support: "SupportAmt",
      production: "SoundAmt+SecurityAmt+GearAmt+SoundTechsAmt+StagehandsAmt+VJAmt+LDAmt",
      marketing: "AdsAmt+PosterAmt", other: "InsuranceAmt+PhotoAmt+CustomAmt+Contingency",
      profit: "MAX(0,NetAtCount)", loss: "MAX(0,-NetAtCount)"
    };
    var whole = inflow + r.money.loss;
    function moneyRow(key, label, hex, val, st, color) {
      var f = MONEY_F[key];
      Su.add([hex ? txt("", "label", { fill: hex }) : null, typeof label === "string" ? txt(label, st || "label", { color: color }) : label,
        fx(f, val, "money", st || "label", { name: "Money_" + key, color: color }),
        fx("IF(Inflow+Money_loss>0,Money_" + key + "/(Inflow+Money_loss),0)", whole > 0 ? val / whole : 0, "pct", st || "label", { color: color }),
        fx("IF(ChosenN>0,Money_" + key + "/ChosenN,0)", n > 0 ? val / n : 0, "money", st || "label", { color: color })]);
    }
    X.CATS.forEach(function (c) {
      var label = c.name.indexOf("{P}") >= 0
        ? fx(platF(c.name.split("{P}")[0], c.name.split("{P}")[1] + (c.detail ? " (" + c.detail + ")" : "")), X.catLabel(c, inp), "text", "label")
        : X.catLabel(c, inp);
      moneyRow(c.k, label, c.hex, r.money[c.k]);
    });
    moneyRow("loss", "Loss (costs not covered)", null, r.money.loss, "label", LIGHT.critText);
    Su.add([null, txt("Buyers paid + other income", "total"), fx(idx("ByT_BuyersPaid") + "+OtherIncome", inflow, "money", "total", { name: "Inflow" }), txt("", "total"),
      fx("IF(ChosenN>0,Inflow/ChosenN,0)", n > 0 ? inflow / n : 0, "money", "total")]);
    Su.add([]);

    heading(Su, "Scenarios at this price", 7);
    Su.add([null, fx('"At "&' + moneyTextAuto("Price") + '&" a ticket"', "At " + X.priceText(inp.price) + " a ticket", "text", "muted")]);
    Su.add([null, txt("Sold", "subhead"), txt("Tickets", "subhead", { align: "right" }), txt("Net ticket revenue", "subhead", { align: "right" }),
      txt("Headliner pay", "subhead", { align: "right" }), txt("Total costs", "subhead", { align: "right" }), txt("Net", "subhead", { align: "right" })]);
    var scenFirst = 0, scenLast = 0;
    [25, 50, 75, 90, 100].forEach(function (p) {
      var k2 = Math.round(S * p / 100), x = rs[k2], rowNo = Su.next();
      var at = function (col) { return "INDEX(" + col + ",$C" + rowNo + "+1)"; };
      var row = Su.add([null, txt(p === 100 ? "Sold out" : p + "%", "label"), fx("ROUND(Sellable*" + p + "/100,0)", k2, "int", "label"),
        fx(at("ByT_NTR"), x.netTicketRevenue, "money", "label", { fmt: FMT.money0 }), fx(at("ByT_HLPay"), x.headliner.pay, "money", "label", { fmt: FMT.money0 }),
        fx(at("ByT_TotalCosts"), x.totalCosts, "money", "label", { fmt: FMT.money0 }), fx(at("ByT_Net"), x.net, "money", "label", { fmt: FMT.signed0, bold: true })]);
      if (!scenFirst) scenFirst = row;
      scenLast = row;
    });
    Su.signCF("$G$" + scenFirst + ":$G$" + scenLast);
    Su.add([]);

    heading(Su, "Net profit by price and attendance", 7);
    Su.add([null, txt("Each cell is the net at that ticket price and attendance, the door price keeping its markup. Blue is profit, red is loss.", "muted", { span: 7 })]);
    var hg = X.heatGrid(inp, M);
    Su.add([null, txt("Sold \\ price", "subhead")].concat(hg.prices.map(function (p) {
      return cell(p, "money", "subhead", { fmt: FMT.money0, align: "center", bold: true });
    })));
    var gFirst = 0, gLast = 0;
    hg.rows.forEach(function (row, ri) {
      var nRef = quoteSheet(PM) + "!" + P.gridN[ri];
      var gr = Su.add([null, fx(row.p + '&"% · "&' + nRef + '&" tickets"', row.p + "% · " + row.n + " tickets", "text", "label", { align: "right" })].concat(row.cells.map(function (c, ci) {
        return fx(quoteSheet(PM) + "!" + P.gridNet[ri][ci], c.net, "money", "label", { fmt: FMT.money0, bold: true, align: "center", name: "Grid_" + (ri + 1) + "_" + (ci + 1) });
      })));
      if (!gFirst) gFirst = gr;
      gLast = gr;
    });
    Su.cf.push({ ref: "C" + gFirst + ":" + colLetter(2 + hg.prices.length) + gLast, kind: "heat" });

    // ---------- Offer (KC PLUR offer sheet layout) and the true / padded budgets
    var NAVY = "#0F1226", PINK = "#FF2E94", CYAN = "#00D4F0", PINKW = "#FFE3F2", LAV = "#E8D9E8", WHITE = "#FFFFFF";
    var DASH = '$#,##0.00;-$#,##0.00;"–"';
    function bar(sh, text, span) { sh.add([null, txt(text, "label", { bold: true, color: WHITE, fill: NAVY, size: 11, span: span })]); }
    function ylabel(text) { return txt(text, "muted", { bold: true }); }

    var Of = new Sheet("Offer", [2, 26, 18, 16, 16, 18, 16, 16], PINK);
    sheets.offer = Of;
    Of.add([null, txt("KC PLUR", "label", { bold: true, color: PINK, fill: NAVY, size: 18, span: 3 }), null, null,
      txt("ARTIST OFFER", "label", { bold: true, color: CYAN, fill: NAVY, size: 16, span: 4, align: "right" })]);
    Of.add([null, fx("ScenarioTitle", ctx.title, "text", "label", { bold: true, span: 4 })]);
    Of.add([null, txt("Yellow cells are fill-ins.", "muted", { span: 7 })]);
    Of.add([null, ylabel("CONTACT"), cell("", "text", "input", { name: "OfferContact", span: 2 }), null, ylabel("OFFER DATE"), cell(ctx.date, "text", "input", { name: "OfferDate", span: 2 })]);
    Of.add([null, ylabel("PHONE"), cell("", "text", "input", { name: "OfferPhone", span: 2 }), null, ylabel("OFFER #"), cell("", "text", "input", { name: "OfferNumber", span: 2 })]);
    Of.add([null, ylabel("EMAIL"), cell("", "text", "input", { name: "OfferEmail", span: 2 }), null, ylabel("STATUS"), cell("Hold", "text", "input", { name: "OfferStatus", span: 2 })]);
    Of.add([null, null, null, null, ylabel("OFFER EXPIRES"), cell("", "text", "input", { name: "OfferExpires", span: 2 })]);
    Of.add([]);
    bar(Of, "01   SHOW DETAILS", 7);
    var showNm = String(inp.showName || "").trim();
    var supTxt = inp.supportSlots > 0 ? inp.supportSlots + " supporting artist" + (inp.supportSlots === 1 ? "" : "s") : "";
    Of.add([null, ylabel("EVENT"), fx("TRIM(ShowName)", showNm, "text", "label", { bold: true, span: 2 }), null, ylabel("BUYER"), cell("KC PLUR", "text", "input", { name: "OfferBuyer", span: 2 })]);
    Of.add([null, ylabel("HEADLINER"), fx("TRIM(ShowName)", showNm, "text", "label", { bold: true, span: 2 }), null, ylabel("CO-PROMOTER"), cell("", "text", "input", { name: "OfferCoPromoter", span: 2 })]);
    Of.add([null, ylabel("SUPPORT"), fx('IF(SupportSlots>0,SupportSlots&" supporting artist"&IF(SupportSlots=1,"","s"),"")', supTxt, "text", "label", { span: 2 }), null,
      ylabel("VENUE"), fx("TRIM(VenueName)", String(inp.venueName || "").trim(), "text", "label", { bold: true, span: 2 })]);
    Of.add([null, ylabel("SHOW DATE"), cell("", "text", "input", { name: "OfferShowDate", span: 2 }), null, ylabel("CITY"), cell("", "text", "input", { name: "OfferCity", span: 2 })]);
    Of.add([null, ylabel("AGENCY"), cell("", "text", "input", { name: "OfferAgency", span: 2 }), null, ylabel("CAPACITY"), fx("CapEff", inp.capacity, "int", "label", { bold: true, align: "left" })]);
    Of.add([]);
    bar(Of, "02   DEAL", 7);
    // The deal as numbers: "–" means that part is off.
    var basisShort = "IF(HLPctBasis=" + str(BASIS_LABEL.grossFace) + "," + str(X.HL_BASIS_SHORT.grossFace) + ",IF(HLPctBasis=" + str(BASIS_LABEL.net) + "," + str(X.HL_BASIS_SHORT.net) + "," + str(X.HL_BASIS_SHORT.faceNet) + "))";
    var PCT_DASH = '0.0##%;-0.0##%;"–"';
    function dealStart(onName, thrName, thr, name) {
      return fx("IF(" + onName + '="On",IF(' + thrName + ">=" + NEVER + ',"never",' + thrName + '),"")', thr === null ? "" : thr >= NEVER ? "never" : thr,
        "auto", "label", { bold: true, fmt: '#,##0" tickets"', align: "left", span: 2, name: name });
    }
    Of.add([null, ylabel("GUARANTEE"), fx("GuaranteeAmt", guaranteeAmt, "money", "label", { bold: true, color: PINK, size: 14, align: "left" }), null,
      ylabel("PAY CAP"), fx('IF(HLCapOn="On",' + CAP_AMT + ",0)", inp.hlCapOn ? Math.max(inp.hlCap, guaranteeAmt) : 0, "money", "label", { bold: true, fmt: DASH, align: "left", span: 2, name: "OfferDealCap" })]);
    Of.add([null, fx('"% OF "&UPPER(' + basisShort + ")", "% OF " + X.HL_BASIS_SHORT[inp.hlPctBasis].toUpperCase(), "text", "muted", { bold: true, wrap: true }),
      fx('IF(HLPctOn="On",HLPct,0)', inp.hlPctOn ? inp.hlPct / 100 : 0, "pct", "label", { bold: true, fmt: PCT_DASH, align: "left", name: "OfferDealPct" }), null,
      ylabel("STARTS AFTER"), dealStart("HLPctOn", "OfferPctThreshold", inp.hlPctOn ? oPctThr : null, "OfferDealPctStart")]);
    Of.add([null, ylabel("$ PER TICKET"), fx('IF(HLPerTicketOn="On",HLPerTicket,0)', inp.hlPerTicketOn ? inp.hlPerTicket : 0, "money", "label", { bold: true, fmt: DASH, align: "left", name: "OfferDealPerTicket" }), null,
      ylabel("STARTS AFTER"), dealStart("HLPerTicketOn", "OfferPerTicketThreshold", inp.hlPerTicketOn ? oPtThr : null, "OfferDealPerTicketStart")]);
    Of.add([null, ylabel("BACKEND, % OF PROFIT"), fx('IF(HLBackendOn="On",HLBackendPct,0)', inp.hlBackendOn ? inp.hlBackendPct / 100 : 0, "pct", "label", { bold: true, fmt: PCT_DASH, align: "left", name: "OfferDealBackend" }), null,
      ylabel("VERSUS DEAL"), fx("HLVersus", inp.hlVersus ? YES : NO, "text", "label", { bold: true, span: 2, name: "OfferDealVersus" })]);
    // Ticket bonuses: one row per slot, blank when the slot is empty or bonuses are off.
    for (var ob2 = 1; ob2 <= BONUS_SLOTS; ob2++) {
      var oRow = inp.hlBonusOn ? inp.hlBonuses[ob2 - 1] : null, T2 = "Bonus_" + ob2 + "_Trigger";
      var used = 'AND(HLBonusOn="On",' + T2 + '<>"")';
      var oLbl = !oRow ? "" : oRow.trigger === "pct" ? "BONUS AT " + oRow.n + "% SOLD" : oRow.trigger === "sellout" ? "SELLOUT BONUS" : "TICKET BONUS";
      Of.add([null,
        fx("IF(" + used + ",IF(" + T2 + "=" + str(TRIGGER_LABEL.pct) + ',"BONUS AT "&ROUND(MIN(100,MAX(0,N(Bonus_' + ob2 + '_Number))),6)&"% SOLD",IF(' + T2 + "=" + str(TRIGGER_LABEL.sellout) +
          ',"SELLOUT BONUS","TICKET BONUS")),"")', oLbl, "text", "muted", { bold: true, name: "OfferDealBonus_" + ob2 + "_Label" }),
        fx("IF(" + used + ",N(Bonus_" + ob2 + '_Amount),"")', oRow ? oRow.amount : "", "money", "label", { bold: true, align: "left", name: "OfferDealBonus_" + ob2 + "_Amount" }), null,
        fx("IF(" + used + ',"PAYS AT","")', oRow ? "PAYS AT" : "", "text", "muted", { bold: true }),
        fx("IF(" + used + ",Bonus_" + ob2 + '_PaysFrom,"")', oRow ? M.bonusAt(oRow, S) : "", "auto", "label",
          { bold: true, fmt: '#,##0" tickets"', align: "left", span: 2, name: "OfferDealBonus_" + ob2 + "_At" })]);
    }
    Of.add([null, ylabel("PROMOTER COVERS"), cell("Travel and hotel, and hospitality per rider", "text", "input", { name: "OfferCovers", span: 6 })]);
    Of.add([null, ylabel("FEE INCLUDES"), cell("Agency commission", "text", "input", { name: "OfferFeeIncludes", span: 6 })]);
    Of.add([null, ylabel("DEPOSIT"), cell("50% on signing; balance night of show", "text", "input", { name: "OfferDeposit", span: 6 })]);
    Of.add([null, ylabel("RADIUS"), cell("Artist may not play, or be announced for, any show or festival within 80 miles of Kansas City until this show is over.", "text", "input", { name: "OfferRadius", span: 6, wrap: true })]);
    Of.add([null, ylabel("MERCHANDISE"), cell("85/15, artist sells; 90/10 on recordings", "text", "input", { name: "OfferMerch", span: 6 })]);
    Of.add([]);
    bar(Of, "03   BOX OFFICE (SOLD OUT)", 7);
    function hdr(sh, labels) { sh.add([null].concat(labels.map(function (l, i) { return txt(l, "colhead", { fill: CYAN, align: i ? "right" : "left" }); }))); }
    function at(col, N) { return "INDEX(" + col + "," + (N || "Sellable") + "+1)"; }
    hdr(Of, ["TIER", "TICKETS", "PRICE", "GROSS"]);
    var dp = inp.doorPriceOn ? inp.doorPrice : inp.price;
    Of.add([null, fx(platF("Advance (", ")"), "Advance (" + pn + ")", "text", "label"), fx(at("ByT_Online"), rS.counts.online, "int", "label"), fx("Price", inp.price, "money", "label"),
      fx(at("ByT_Online") + "*Price", rS.counts.online * inp.price, "money", "label")]);
    Of.add([null, txt("Door", "label"), fx(at("ByT_Door"), rS.counts.door, "int", "label"), fx("PT_DP", dp, "money", "label"), fx(at("ByT_Door") + "*PT_DP", rS.counts.door * dp, "money", "label")]);
    Of.add([null, txt("Comps / guest list", "label"), fx("CompsEff", inp.comps, "int", "label"), txt("", "label"), cell(0, "money", "label")]);
    Of.add([null, txt("TOTAL", "subtotal", { fill: PINKW }), fx("Sellable", S, "int", "subtotal", { fill: PINKW }),
      fx('IF(Sellable>0,OfferGrossSellout/Sellable,0)', S ? rS.grossFace / S : 0, "money", "subtotal", { fill: PINKW }),
      fx(at("ByT_GrossFace"), rS.grossFace, "money", "subtotal", { fill: PINKW, name: "OfferGrossSellout" })]);
    Of.add([null, null, null, txt("avg / ticket", "muted", { align: "right" })]);
    Of.add([]);
    bar(Of, "04   EXPENSES", 7);
    hdr(Of, ["ITEM", "BUDGET"]);
    var oExp = [
      ["Supporting artists", "OfferSupportAmt", OL.support], ["VJ", "OfferVJAmt", OL.vj], ["Lighting designer (LD)", "OfferLDAmt", OL.ld], ["Sound techs", "OfferSoundTechsAmt", OL.soundTechs],
      ["Stagehands", "OfferStagehandsAmt", OL.stagehands], ["Contracted security", "OfferSecurityAmt", OL.security], ["Sound rental", "OfferSoundAmt", OL.sound],
      ["Additional deck / gear", "OfferGearAmt", OL.gear], ["Photo / video", "OfferPhotoAmt", OL.photo], ["Advertising", "OfferAdsAmt", OL.ads],
      ["Poster design", "OfferPosterAmt", OL.poster], ["Event insurance", "OfferInsuranceAmt", OL.insurance], ["Venue rental / fee", "OfferVenueRentalAmt", OL.venueRental],
      ["Headliner travel / hotel", "OfferTravelAmt", OL.headlinerTravel], ["Headliner hospitality / rider", "OfferHospAmt", OL.headlinerHospitality]
    ];
    // Custom and offer-only lines one by one (the lines there at export); anything added later lands in "Other costs".
    var itemRefs = [], itemNo = 0;
    function itemize(list, prefix) {
      list.forEach(function (c, i) {
        var nm = prefix + (i + 1) + "_Name", am = prefix + (i + 1) + "_Amount";
        itemNo++;
        itemRefs.push("N(" + am + ")");
        oExp.push([fx("IF(TRIM(" + nm + ')="",' + str("Cost line " + itemNo) + ",TRIM(" + nm + "))", c.name || "Cost line " + itemNo, "text", "label"), "N(" + am + ")", c.amount]);
      });
    }
    itemize(inp.custom, "Custom_");
    itemize(inp.offerExtra, "OfferLine_");
    oExp.push(["Other costs", "CustomAmt+OfferLinesAmt" + (itemRefs.length ? "-(" + itemRefs.join("+") + ")" : ""), itemRefs.length ? 0 : L.custom + offerLinesSum, "OfferOtherCosts"]);
    oExp.push(["Contingency", "OfferContingency", oAt.contingency]);
    oExp.forEach(function (e) { Of.add([null, typeof e[0] === "string" ? txt(e[0], "label") : e[0], fx(e[1], e[2], "money", "label", { fmt: DASH, name: e[3] })]); });
    Of.add([null, txt("TOTAL EXPENSES", "subtotal", { fill: PINKW }), fx("OfferFixedTotal-GuaranteeAmt", oAt.fixedCostsTotal - guaranteeAmt, "money", "subtotal", { fill: PINKW })]);
    Of.add([null, txt("Not counting the guarantee, which is the artist's.", "muted", { span: 4 })]);
    Of.add([]);
    bar(Of, "05   SETTLEMENT AT SELL-OUT", 7);
    hdr(Of, ["LINE", "AMOUNT"]);
    var taxOut = rS.faceNet - rS.grossFace;
    var setl = [
      ["Gross potential", at("ByT_GrossFace"), rS.grossFace],
      ["Sales tax inside the price", at("ByT_FaceNet") + "-" + at("ByT_GrossFace"), taxOut],
      ["Ticketing fees we absorb", "-" + at("ByT_FeesAbsorbed"), -rS.eventbrite.absorbed],
      ["Door card processing", "-" + at("ByT_DoorProc"), -rS.doorProc],
      ["Venue % of door", "-" + at("ByT_DoorCut"), -rS.doorCut],
      ["Venue per-head fee", "-" + at("ByT_PerHead"), -rS.venue.perHead]
    ];
    setl.forEach(function (e) { Of.add([null, txt(e[0], "label"), fx(e[1], e[2], "money", "label", { fmt: DASH })]); });
    Of.add([null, txt("NET GROSS RECEIPTS", "subtotal"), fx(at("ByT_NTR"), rS.netTicketRevenue, "money", "subtotal")]);
    Of.add([null, txt("Other income (merch, sponsor)", "label"), fx("OtherIncome", inp.otherIncome, "money", "label", { fmt: DASH })]);
    Of.add([null, txt("Expenses (section 04)", "label"), fx("-(OfferFixedTotal-GuaranteeAmt)", -(oAt.fixedCostsTotal - guaranteeAmt), "money", "label")]);
    Of.add([null, txt("NET SHOW RECEIPTS", "subtotal", { fill: PINKW }),
      fx(at("ByT_NTR") + "+OtherIncome-(OfferFixedTotal-GuaranteeAmt)", oSO.net + oSO.headliner.pay, "money", "subtotal", { fill: PINKW, name: "OfferNSR" })]);
    Of.add([null, txt("What's left to pay the artist and the promoter.", "muted", { span: 4 })]);
    Of.add([]);
    bar(Of, "06   OFFER SUMMARY", 7);
    var beTxt = oHLBE === null ? "never" : oHLBE + " tickets";
    Of.add([null, txt("GUARANTEE", "label", { bold: true, color: CYAN, fill: NAVY }), txt("ARTIST, SOLD OUT", "label", { bold: true, color: CYAN, fill: NAVY, span: 2 }), null,
      txt("PROMOTER, SOLD OUT", "label", { bold: true, color: CYAN, fill: NAVY, span: 2 }), null, txt("BREAK-EVEN", "label", { bold: true, color: CYAN, fill: NAVY })]);
    Of.add([null, fx("GuaranteeAmt", guaranteeAmt, "money", "label", { bold: true, size: 14, color: WHITE, fill: NAVY }),
      fx("OfferPayAtSellout", oSO.headliner.pay, "money", "label", { bold: true, size: 14, color: PINK, fill: NAVY, span: 2, name: "OfferArtistSellout" }), null,
      fx("OfferNetAtSellout", oSO.net, "money", "label", { bold: true, size: 14, color: WHITE, fill: NAVY, span: 2, name: "OfferPromoterSellout" }), null,
      fx('IF(ISNUMBER(OfferHLBreakEven),OfferHLBreakEven&" tickets","never")', beTxt, "text", "label", { bold: true, size: 14, color: CYAN, fill: NAVY, align: "right" })]);
    Of.add([null, txt("Flat", "muted", { color: WHITE, fill: NAVY }), txt("Guarantee plus bonus", "muted", { color: WHITE, fill: NAVY, span: 2 }), null,
      txt("Net show receipts less artist", "muted", { color: WHITE, fill: NAVY, span: 2 }), null, txt("Before the bonus", "muted", { color: WHITE, fill: NAVY, align: "right" })]);
    // The offer math lives on Costs (names are global), so the Offer tab stays clean to send.
    Co.add([]);
    heading(Co, "Offer working values");
    function wrow(label, f, val, name, t) { Co.add([null, txt(label, "label"), fx(f, val, t || "money", "work", name ? { name: name } : undefined)]); }
    wrow("Offer headliner break-even (tickets)", 'IFERROR(MATCH(1,ByT_OfferFlag,0)-1,"never")', oHLBE === null ? "never" : oHLBE, "OfferHLBreakEven", "auto");
    wrow("% part threshold (tickets)", startF("HLPctStart", "HLPctStartN", "OfferHLBreakEven"), oPctThr, "OfferPctThreshold", "int");
    wrow("$ per ticket part threshold (tickets)", startF("HLPerTicketStart", "HLPerTicketStartN", "OfferHLBreakEven"), oPtThr, "OfferPerTicketThreshold", "int");
    wrow("% basis at the threshold", "IF(OfferPctThreshold>0,INDEX(ByT_HLBasis,MIN(OfferPctThreshold,Sellable)+1),0)", oPctBasisAtStart, "OfferPctBasisAtStart");
    function offerDeal(N, sfx, res, label) {
      var p = "Offer" + sfx + "_";
      wrow(label + ": % part", 'IF(AND(HLPctOn="On",' + N + ">OfferPctThreshold),MAX(0,INDEX(ByT_HLBasis," + N + "+1)-OfferPctBasisAtStart)*HLPct,0)", res.headliner.pctPart, p + "Pct");
      wrow(label + ": $ per ticket part", 'IF(HLPerTicketOn="On",MAX(0,' + N + "-OfferPerTicketThreshold)*HLPerTicket,0)", res.headliner.perTicketPart, p + "PT");
      wrow(label + ": ticket bonuses", bonusF(N), res.headliner.bonusPart, p + "Bonus");
      wrow(label + ": deal pay", capDeal(preBonusF(p + "Pct", p + "PT") + "+" + p + "Bonus"), res.headliner.dealPay, p + "Deal");
      wrow(label + ": ticket bonuses paid (under the cap)", p + "Deal-" + capDeal(preBonusF(p + "Pct", p + "PT")), res.headliner.bonusPaid, p + "BonusPaid");
      wrow(label + ": net before backend", "INDEX(ByT_NTR," + N + "+1)+OtherIncome-OfferFixedTotal-(" + p + "Deal-GuaranteeAmt)", res.netBeforeBackend, p + "NBB");
      wrow(label + ": backend", capBackend('IF(HLBackendOn="On",MAX(0,' + p + "NBB)*HLBackendPct,0)", p + "Deal"), res.headliner.backend, p + "Backend");
      wrow(label + ": headliner pay", p + "Deal+" + p + "Backend", res.headliner.pay, "OfferPayAt" + sfx);
      wrow(label + ": net", p + "NBB-" + p + "Backend", res.net, "OfferNetAt" + sfx);
    }
    offerDeal("ChosenN", "Count", oAt, "At the chosen count");
    offerDeal("Sellable", "Sellout", oSO, "Sold out");

    // Budgets: everything on one tab, like the Atlas9 run of show and the Enter the Abyss budget.
    function budget(kind) {
      var off = kind === "offer";
      var Bu = new Sheet(off ? "Padded budget" : "True budget", [2, 30, 30, 16, 9, 44], off ? PINK : LIGHT.accent);
      Bu.add([null, fx('ScenarioTitle&" budget (' + (off ? "padded, for the offer" : "true") + ')"', ctx.title + " budget (" + (off ? "padded, for the offer" : "true") + ")", "text", "title", { span: 5 })]);
      Bu.add([null, txt(off ? "The costs the offer shows. Change them in the Offer section of Inputs." : "Your real numbers. Change them on Inputs.", "muted", { span: 5 })]);
      Bu.add([null, txt("Yellow cells are fill-ins: who gets paid and whether they're paid.", "muted", { span: 5 })]);
      Bu.add([]);
      var res = off ? oAt : r;
      function kv(label, f, val, t) { Bu.add([null, txt(label, "label", { bold: true }), fx(f, val, t, "label", { align: "right" })]); }
      kv("Tickets sold", "ChosenN", n, "int");
      kv("Online price", "Price", inp.price, "money");
      kv("Door price", "PT_DP", dp, "money");
      kv("Sales tax rate", "TaxR", inp.taxOn ? inp.taxRate / 100 : 0, "pct");
      var beV = off ? oHLBE : hlBE;
      kv("Break-even before bonus", off ? "OfferHLBreakEven" : "HLBreakEven", beV === null ? "never" : beV, "auto");
      Bu.add([]);
      function bbar(text) { Bu.add([null, txt(text, "label", { bold: true, color: WHITE, fill: NAVY, size: 11, span: 5 })]); }
      function bhead(labels) { Bu.add([null].concat(labels.map(function (l) { return txt(l, "label", { bold: true, fill: LAV }); }))); }
      bbar("Ticket sales");
      bhead(["Channel", "Tickets", "Price", "", "Revenue after tax"]);
      Bu.add([null, fx(platF("Online (", ")"), "Online (" + pn + ")", "text", "label"), fx(idx("ByT_Online"), r.counts.online, "int", "label"), fx("Price", inp.price, "money", "label"), null,
        fx(idx("ByT_Online") + "*PT_fn", r.counts.online * r.perTicketPrices.faceNet, "money", "label")]);
      Bu.add([null, txt("Door", "label"), fx(idx("ByT_Door"), r.counts.door, "int", "label"), fx("PT_DP", dp, "money", "label"), null,
        fx(idx("ByT_Door") + "*PT_dfn", r.counts.door * r.perTicketPrices.doorFaceNet, "money", "label")]);
      Bu.add([null, txt("Total", "subtotal"), fx("ChosenN", n, "int", "subtotal"), txt("", "subtotal"), txt("", "subtotal"), fx(idx("ByT_FaceNet"), r.faceNet, "money", "subtotal")]);
      Bu.add([]);
      bbar("Expenses");
      bhead(["Payee", "Role", "Amount", "Paid", "Notes"]);
      var hl = showNm || "Headliner", ven = String(inp.venueName || "").trim() || "Venue";
      var A = off ? { travel: "OfferTravelAmt", hosp: "OfferHospAmt", sup: "OfferSupportAmt", vj: "OfferVJAmt", ld: "OfferLDAmt", st: "OfferSoundTechsAmt", sh: "OfferStagehandsAmt", sec: "OfferSecurityAmt",
                      snd: "OfferSoundAmt", gear: "OfferGearAmt", photo: "OfferPhotoAmt", ads: "OfferAdsAmt", poster: "OfferPosterAmt", ins: "OfferInsuranceAmt", rent: "OfferVenueRentalAmt",
                      cont: "OfferContingency", pay: "OfferPayAtCount", bonus: "OfferCount_BonusPaid" }
                  : { travel: "HLTravel", hosp: "HLHospitality", sup: "SupportAmt", vj: "VJAmt", ld: "LDAmt", st: "SoundTechsAmt", sh: "StagehandsAmt", sec: "SecurityAmt",
                      snd: "SoundAmt", gear: "GearAmt", photo: "PhotoAmt", ads: "AdsAmt", poster: "PosterAmt", ins: "InsuranceAmt", rent: "VenueRentalAmt",
                      cont: "Contingency", pay: "HLPayAtCount", bonus: "BonusAmt" };
      var C2 = res.costs;
      var lines = [
        [hl, "Headliner guarantee", "GuaranteeAmt", guaranteeAmt, ""],
        [hl, "Headliner bonus at this count", A.pay + "-GuaranteeAmt-" + A.bonus, res.headliner.pay - guaranteeAmt - res.headliner.bonusPaid, X.hlDescription(inp)],
        [hl, "Ticket bonuses", A.bonus, res.headliner.bonusPaid, ""],
        [hl, "Travel / hotel", A.travel, C2.headlinerTravel, ""],
        [hl, "Hospitality / rider", A.hosp, C2.headlinerHospitality, ""],
        [null, "Supporting artists", A.sup, C2.support, inp.supportSlots + " x " + X.fmt$(off ? offerInp.supportPrice : inp.supportPrice)],
        [null, "VJ", A.vj, C2.vj, ""],
        [null, "Lighting designer (LD)", A.ld, C2.ld, ""],
        [null, "Sound techs", A.st, C2.soundTechs, ""],
        [null, "Stagehands", A.sh, C2.stagehands, ""],
        [null, "Contracted security", A.sec, C2.security, ""],
        [null, "Sound rental", A.snd, C2.sound, ""],
        [null, "Additional deck / gear", A.gear, C2.gear, ""],
        [null, "Photo / video", A.photo, C2.photo, ""],
        [null, "Advertising", A.ads, C2.ads, ""],
        [null, "Poster design", A.poster, C2.poster, ""],
        [null, "Event insurance", A.ins, C2.insurance, ""],
        [ven, "Flat rental / fee", A.rent, C2.venueRental, ""],
        [ven, "Venue % of door", idx("ByT_DoorCut"), r.doorCut, "Comes out of ticket sales"],
        [ven, "Per-head fee", idx("ByT_PerHead"), r.venue.perHead, "Everyone in the room, comps included"],
        [pn, "Ticketing fees we absorb", idx("ByT_FeesAbsorbed"), r.eventbrite.absorbed, ""],
        [null, "Door card processing", idx("ByT_DoorProc"), r.doorProc, ""],
        [null, "Custom cost lines", "CustomAmt", L.custom, "Listed on Inputs"]
      ];
      if (off) lines.push([null, "Offer-only lines", "OfferLinesAmt", offerLinesSum, "Listed on Inputs"]);
      lines.push([null, "Contingency", A.cont, res.contingency, "On the fixed costs, guarantee included"]);
      var eFirst = 0, eLast = 0;
      lines.forEach(function (e) {
        var payee = e[0] === null ? cell("", "text", "input") : txt(e[0], "label");
        var row = Bu.add([null, payee, txt(e[1], "label"), fx(e[2], e[3], "money", "label", { fmt: DASH }), cell(NO, "text", "input", { dv: choice([YES, NO]), align: "center" }),
          txt(e[4], "muted")]);
        if (!eFirst) eFirst = row;
        eLast = row;
      });
      var amt = "D" + eFirst + ":D" + eLast, paid = "E" + eFirst + ":E" + eLast;
      var total = res.totalCosts + r.venue.doorCut + r.venue.perHead + r.eventbrite.absorbed + r.doorProc;
      var tRow = Bu.add([null, txt("Total expenses", "subtotal"), txt("", "subtotal"), fx("SUM(" + amt + ")", total, "money", "subtotal"),
        fx('COUNTIF(' + paid + ',"' + YES + '")&" of ' + lines.length + ' paid"', "0 of " + lines.length + " paid", "text", "subtotal")]);
      Bu.add([null, txt("Paid so far", "label"), null, fx('SUMIF(' + paid + ',"' + YES + '",' + amt + ")", 0, "money", "label")]);
      Bu.add([null, txt("Still owed", "label"), null, fx("D" + tRow + "-D" + (tRow + 1), total, "money", "label")]);
      Bu.add([]);
      bbar("Summary");
      var revRow = Bu.add([null, txt("Ticket revenue after tax", "label"), null, fx(idx("ByT_FaceNet"), r.faceNet, "money", "label")]);
      Bu.add([null, txt("Other income (merch, sponsor)", "label"), null, fx("OtherIncome", inp.otherIncome, "money", "label")]);
      Bu.add([null, txt("Total expenses", "label"), null, fx("-D" + tRow, -total, "money", "label")]);
      var netRow2 = Bu.add([null, fx('"Net at "&ChosenN&" tickets"', "Net at " + n + " tickets", "text", "total"), null,
        fx("D" + revRow + "+D" + (revRow + 1) + "+D" + (revRow + 2), res.net, "money", "total", { name: off ? "BudgetNet_Offer" : "BudgetNet_True" })]);
      Bu.signCF("$D$" + netRow2);
      return Bu;
    }
    sheets.budgetTrue = budget("true");
    sheets.budgetOffer = budget("offer");

    return [sheets.summary, sheets.inputs, sheets.offer, sheets.budgetTrue, sheets.budgetOffer, sheets.tickets, sheets.venue, sheets.talent, sheets.costs, sheets.byT, sheets.pm];
  }

  // The "Price math" tab: one column per price case. Each column has the per-ticket constants at its
  // price, a flag per ticket count (breaks even counting the guarantee and every other cost but no
  // bonus parts) whose first 1 is the headliner break-even at that price, and the net at the counts
  // it needs. The 17 bisection columns take the same steps as model.breakEvenPrice, so the answer is
  // the same to the cent. (The model's final walk-down never moves: the cent below the answer is
  // always one the search already saw lose.)
  function buildPriceMath(inp, n, S, MAXR, M, sheets) {
    var hg = X.heatGrid(inp, M);
    var gridPcts = hg.rows.map(function (rw) { return rw.p; });
    var Pm = new Sheet(PM, [44, 8, 8, 8, 8, 12], LIGHT.ink2);
    sheets.pm = Pm;
    var cases = [];
    hg.prices.forEach(function (p) { cases.push({ kind: "grid", label: "$" + p, price: p }); });
    cases.push({ kind: "zero", label: "$0", price: 0 });
    cases.push({ kind: "cap", label: "$1,000", price: PRICE_CAP_CENTS / 100 });
    for (var i = 1; i <= BISECT_STEPS; i++) cases.push({ kind: "step", label: "Step " + i, step: i });
    var FIRST_CASE_COL = 7;
    cases.forEach(function (c, ci) { c.col = colLetter(FIRST_CASE_COL + ci); Pm.columns.push(c.kind === "step" ? 10 : 11); });

    // Row layout
    var rowOf = {}, labels = [], nextRow = 5;
    function def(key, label) { rowOf[key] = nextRow++; labels.push([key, label]); }
    def("case", "Price case");
    def("lo", "Bisection: lowest losing price (cents)");
    def("hi", "Bisection: highest breaking-even price (cents)");
    def("mid", "Bisection: price tried (cents)");
    def("P", "Ticket price");
    def("DP", "Door price (keeps its markup)");
    var PT_LBL = { fn: "Ours after sales tax", tx: "Sales tax", gr: "Online price incl. tax", svcU: "Service fee before any cap", feeU: "Platform fees before any cap", svc: "Service fee", buyer: "Buyer pays online", proc: "Processing",
      fee: "Platform fees", abs: "Fees we absorb", pass: "Fees the buyer pays", dfn: "Door: ours after tax", dtx: "Door: sales tax", dgr: "Buyer pays at the door", dcp: "Door card fee" };
    PT_KEYS.forEach(function (k) { def(k, "Per ticket: " + PT_LBL[k]); });
    def("hlBE", "Headliner break-even at this price");
    def("pctThr", "% part threshold");
    def("ptThr", "$ per ticket threshold");
    def("thrN", "Count for the % basis at the threshold");
    TS_KEYS.forEach(function (k) { def("t_" + k, "At the threshold: " + TS_LABEL[k]); });
    def("hbThr", "% basis at the threshold");
    var SLOTS = gridPcts.length;
    for (var s = 1; s <= SLOTS; s++) {
      def("s" + s + "_N", "Count " + s + ": tickets");
      TS_KEYS.forEach(function (k) { def("s" + s + "_" + k, "Count " + s + ": " + TS_LABEL[k]); });
      DEAL_KEYS.forEach(function (k) { def("s" + s + "_" + k, "Count " + s + ": " + DEAL_LABEL[k]); });
    }
    def("nextLo", "Bisection: next lowest losing price");
    def("nextHi", "Bisection: next highest breaking-even price");
    var flagHead = nextRow + 1, F0 = flagHead + 1, F1 = F0 + MAXR;

    // Grid of rows: label column + per-row data columns, case columns filled below.
    var grid = [];
    function put(row, col, c) { while (grid.length < row) grid.push([]); var rw = grid[row - 1]; while (rw.length < col) rw.push(null); rw[col - 1] = c; }
    put(1, 1, txt("Price math", "title"));
    put(2, 1, txt("Helper for the price grid and the break-even price on Summary: the ticket side again at other prices. Nothing to edit here.", "muted", { span: 8 }));
    labels.forEach(function (l) { put(rowOf[l[0]], 1, txt(l[1], l[0] === "case" ? "subhead" : "label")); });
    put(flagHead, 1, txt("Ticket count rows (1 = breaks even before bonus parts)", "colhead", { wrap: true }));
    ["Tickets", "Online", "Door", "Door card", "Per-head + fixed − other"].forEach(function (h2, j) { put(flagHead, 2 + j, txt(h2, "colhead", { wrap: true, align: "right" })); });

    // Values from the model, per case
    function caseModel(price, slotsN) {
      var x = M.sanitize(M.withPrice(inp, price)), hl = M.headlinerBreakEven(x);
      var r0 = M.compute(x, 0, { hlBE: hl });
      var pThr = threshold(x.hlPctStart, x.hlPctStartN, hl), tThr = threshold(x.hlPerTicketStart, x.hlPerTicketStartN, hl);
      var thrN = pThr > 0 && pThr <= S ? pThr : 0;
      var rt = M.compute(x, thrN, { hlBE: hl });
      var fc = r0.fixedCostsTotal;
      return {
        x: x, hl: hl, pt: ptValues(r0.perTicketPrices), pThr: pThr, tThr: tThr, thrN: thrN, ts: tsValues(rt, x), hbThr: pThr > 0 ? basisValue(rt, x.hlPctBasis) : 0,
        slots: slotsN.map(function (N) { var rr = M.compute(x, N, { hlBE: hl }); return { N: N, ts: tsValues(rr, x), deal: dealValues(rr) }; }),
        flag: function (k) { return k > S ? "" : (M.compute(x, k, { hlBE: hl }).netTicketRevenue + inp.otherIncome - fc >= -1e-9 ? 1 : 0); }
      };
    }
    // Bisection, as model.breakEvenPrice runs it
    var lo = 0, hi = PRICE_CAP_CENTS;
    cases.forEach(function (c) {
      if (c.kind === "grid") { c.model = caseModel(c.price, gridPcts.map(function (p) { return Math.round(S * p / 100); })); return; }
      if (c.kind !== "step") { c.model = caseModel(c.price, [n]); return; }
      c.lo = lo; c.hi = hi; c.mid = Math.floor((lo + hi) / 2);
      c.model = caseModel(c.mid / 100, [n]);
      var ok = c.model.slots[0].deal.ok === 1;
      if (hi - lo > 1) { if (ok) hi = c.mid; else lo = c.mid; }
      c.nextLo = lo; c.nextHi = hi;
    });

    var gridN = [], gridNet = gridPcts.map(function () { return []; });
    cases.forEach(function (c, ci) {
      var col = c.col, mdl = c.model;
      var R = function (key) { return col + rowOf[key]; };
      put(rowOf["case"], FIRST_CASE_COL + ci, txt(c.label, "subhead", { align: "right" }));
      if (c.kind === "step") {
        var prev = cases[ci - 1];
        put(rowOf.lo, FIRST_CASE_COL + ci, c.step === 1 ? fx("0", 0, "int", "work") : fx(prev.col + rowOf.nextLo, c.lo, "int", "work"));
        put(rowOf.hi, FIRST_CASE_COL + ci, c.step === 1 ? fx(String(PRICE_CAP_CENTS), PRICE_CAP_CENTS, "int", "work") : fx(prev.col + rowOf.nextHi, c.hi, "int", "work"));
        put(rowOf.mid, FIRST_CASE_COL + ci, fx("INT((" + R("lo") + "+" + R("hi") + ")/2)", c.mid, "int", "work"));
        put(rowOf.P, FIRST_CASE_COL + ci, fx(R("mid") + "/100", c.mid / 100, "money", "work"));
      } else {
        put(rowOf.P, FIRST_CASE_COL + ci, fx(String(c.price), c.price, "money", "work"));
      }
      put(rowOf.DP, FIRST_CASE_COL + ci, fx('IF(DoorPriceOn="On",MAX(0,DoorPrice+' + R("P") + "-Price)," + R("P") + ")", mdl.x.doorPriceOn ? mdl.x.doorPrice : mdl.x.price, "money", "work"));
      var ptf = ptFormulas(R("P"), R("DP"), R);
      PT_KEYS.forEach(function (k) { put(rowOf[k], FIRST_CASE_COL + ci, fx(ptf[k], mdl.pt[k], "money", "work")); });
      var fr = col + "$" + F0 + ":" + col + "$" + F1;
      put(rowOf.hlBE, FIRST_CASE_COL + ci, fx("IFERROR(MATCH(1," + fr + ',0)-1,"never")', mdl.hl === null ? "never" : mdl.hl, "auto", "work"));
      put(rowOf.pctThr, FIRST_CASE_COL + ci, fx(startF("HLPctStart", "HLPctStartN", R("hlBE")), mdl.pThr, "int", "work"));
      put(rowOf.ptThr, FIRST_CASE_COL + ci, fx(startF("HLPerTicketStart", "HLPerTicketStartN", R("hlBE")), mdl.tThr, "int", "work"));
      put(rowOf.thrN, FIRST_CASE_COL + ci, fx("IF(AND(" + R("pctThr") + ">0," + R("pctThr") + "<=Sellable)," + R("pctThr") + ",0)", mdl.thrN, "int", "work"));
      var tsT = tsFormulas(R("thrN"), R("P"), R("DP"), R, function (k) { return R("t_" + k); });
      TS_KEYS.forEach(function (k) { put(rowOf["t_" + k], FIRST_CASE_COL + ci, fx(tsT[k], mdl.ts[k], k === "on" || k === "door" || k === "card" ? "int" : "money", "work")); });
      put(rowOf.hbThr, FIRST_CASE_COL + ci, fx("IF(" + R("pctThr") + ">0," + R("t_hb") + ",0)", mdl.hbThr, "money", "work"));
      mdl.slots.forEach(function (sl, si) {
        var pre = "s" + (si + 1) + "_", RS = function (k) { return R(pre + k); };
        var nf = c.kind === "grid" ? "ROUND(Sellable*" + gridPcts[si] + "/100,0)" : "ChosenN";
        put(rowOf[pre + "N"], FIRST_CASE_COL + ci, fx(nf, sl.N, "int", "work", c.kind === "grid" && ci === 0 ? { name: "Grid_N_" + (si + 1) } : undefined));
        var tsS = tsFormulas(RS("N"), R("P"), R("DP"), R, RS);
        TS_KEYS.forEach(function (k) { put(rowOf[pre + k], FIRST_CASE_COL + ci, fx(tsS[k], sl.ts[k], k === "on" || k === "door" || k === "card" ? "int" : "money", "work")); });
        var dl = dealFormulas(RS("N"), RS, R("pctThr"), R("ptThr"), R("hbThr"));
        DEAL_KEYS.forEach(function (k) {
          var nm = si === 0 && k === "ok" ? (c.kind === "zero" ? "PM_ZeroOk" : c.kind === "cap" ? "PM_CapOk" : undefined) : undefined;
          put(rowOf[pre + k], FIRST_CASE_COL + ci, fx(dl[k], sl.deal[k], k === "ok" ? "int" : "money", "work", nm ? { name: nm } : undefined));
        });
        if (c.kind === "grid") {
          if (ci === 0) gridN.push("$" + col + "$" + rowOf[pre + "N"]);
          gridNet[si].push("$" + col + "$" + rowOf[pre + "net"]);
        }
      });
      if (c.kind === "step") {
        var okR = R("s1_ok");
        put(rowOf.nextLo, FIRST_CASE_COL + ci, fx("IF(" + R("hi") + "-" + R("lo") + ">1,IF(" + okR + "=1," + R("lo") + "," + R("mid") + ")," + R("lo") + ")", c.nextLo, "int", "work"));
        put(rowOf.nextHi, FIRST_CASE_COL + ci, fx("IF(" + R("hi") + "-" + R("lo") + ">1,IF(" + okR + "=1," + R("mid") + "," + R("hi") + ")," + R("hi") + ")", c.nextHi, "int", "work",
          c.step === BISECT_STEPS ? { name: "PM_LastHi" } : undefined));
      }
      // Flags: 1 when the ticket count breaks even counting the guarantee and every cost, no bonus parts.
      for (var k = 0; k <= MAXR; k++) {
        var rr = F0 + k, on = "$C" + rr, dr = "$D" + rr, cd = "$E" + rr;
        var K = function (key) { return col + "$" + rowOf[key]; };
        var fnT = on + "*" + K("fn") + "+" + dr + "*" + K("dfn");
        var cbF = "IF(DoorCutBasis=" + str(CUT_LABEL.afterTax) + "," + fnT + ",IF(DoorCutBasis=" + str(CUT_LABEL.afterTaxFees) + "," + fnT + "-" + on + "*" + K("abs") + "-" + cd + "*" + K("dcp") +
          "," + on + "*" + K("gr") + "+" + dr + "*" + K("dgr") + "))";
        var f = 'IF($B' + rr + '="","",IF(' + fnT + "-" + on + "*" + K("abs") + "-" + cd + "*" + K("dcp") + '-IF(DoorCutOn="On",MAX(0,' + cbF + ")*DoorCutPct,0)-$F" + rr + ">=-" + EPS + ",1,0))";
        put(rr, FIRST_CASE_COL + ci, fx(f, mdl.flag(k), "int", "work"));
      }
    });
    // Per-count columns shared by every case
    var fcTotal = M.compute(inp, 0).fixedCostsTotal;
    for (var k2 = 0; k2 <= MAXR; k2++) {
      var rr2 = F0 + k2, live = k2 <= S, x2 = live ? M.compute(inp, k2) : null;
      put(rr2, 2, fx("IF(" + k2 + "<=Sellable," + k2 + ',"")', live ? k2 : "", "int", "work"));
      put(rr2, 3, fx('IF($B' + rr2 + '="","",ROUND(ROUND($B' + rr2 + "*OnlinePct,9),0))", live ? x2.counts.online : "", "int", "work"));
      put(rr2, 4, fx('IF($B' + rr2 + '="","",$B' + rr2 + "-$C" + rr2 + ")", live ? x2.counts.door : "", "int", "work"));
      put(rr2, 5, fx('IF($B' + rr2 + '="","",$D' + rr2 + "-ROUND(ROUND($D" + rr2 + "*DoorCashPct,9),0))", live ? x2.counts.doorCard : "", "int", "work"));
      put(rr2, 6, fx('IF($B' + rr2 + '="","",IF(PerHeadOn="On",($B' + rr2 + "+CompsEff)*PerHead,0)+FixedTotal-OtherIncome)",
        live ? x2.venue.perHead + fcTotal - inp.otherIncome : "", "money", "work"));
    }
    Pm.rows = grid;
    Pm.freeze = rowOf["case"]; Pm.freezeCols = 1;
    return { gridN: gridN, gridNet: gridNet };
  }

  // ---------------------------------------------------------------- ExcelJS writer
  function argb(hex) { return "FF" + String(hex).replace("#", "").toUpperCase(); }
  function writeWorkbook(ExcelJS, sheets) {
    var wb = new ExcelJS.Workbook();
    wb.creator = "Show Feasibility";
    wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };
    var FONT = "Arial";
    function border(color, style) { return { style: style || "thin", color: { argb: argb(color) } }; }

    sheets.forEach(function (sh) {
      var view = { showGridLines: false };
      if (sh.freeze || sh.freezeCols) view = { state: "frozen", xSplit: sh.freezeCols || 0, ySplit: sh.freeze || 0, showGridLines: false };
      var ws = wb.addWorksheet(sh.name, {
        views: [view],
        properties: sh.tab ? { tabColor: { argb: argb(sh.tab) } } : undefined,
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
          var st = c.s || "label";
          var font = { name: FONT, size: 10, color: { argb: argb(LIGHT.ink) } };
          var fill = null, bd = {}, al = { vertical: "middle" };
          if (st === "title") { font.size = 16; font.bold = true; }
          else if (st === "heading") { font.size = 11; font.bold = true; font.color = { argb: argb(LIGHT.accent) }; fill = LIGHT.accentWash; bd.bottom = border(LIGHT.accent); }
          else if (st === "subhead") { font.size = 9; font.bold = true; font.color = { argb: argb(LIGHT.ink2) }; bd.bottom = border(LIGHT.line); }
          else if (st === "band") { font.size = 9; font.bold = true; font.color = { argb: argb(LIGHT.ink2) }; fill = LIGHT.accentWash; }
          else if (st === "colhead") { font.size = 9; font.bold = true; font.color = { argb: argb(LIGHT.ink2) }; bd.bottom = border(LIGHT.axis); al.vertical = "bottom"; }
          else if (st === "muted") { font.size = 9; font.color = { argb: argb(LIGHT.ink2) }; }
          else if (st === "snap") { font.color = { argb: argb(LIGHT.ink2) }; }
          else if (st === "work") { font.size = 9; font.color = { argb: argb(LIGHT.ink2) }; }
          else if (st === "subtotal") { font.bold = true; bd.top = border(LIGHT.axis); }
          else if (st === "total") { font.bold = true; font.size = 11; bd.top = border(LIGHT.axis); }
          else if (st === "input") { fill = LIGHT.input; bd = { top: border(LIGHT.fieldLine), bottom: border(LIGHT.fieldLine), left: border(LIGHT.fieldLine), right: border(LIGHT.fieldLine) }; }

          var numeric = c.t === "money" || c.t === "int" || c.t === "pct" || c.t === "auto";
          var fmt = c.fmt || (c.t === "money" ? FMT.money : c.t === "pct" ? FMT.pct : c.t === "int" || c.t === "auto" ? "#,##0" : null);
          if (c.t === "link") {
            x.value = { text: c.text || String(c.v), hyperlink: String(c.v) };
            font.color = { argb: argb(LIGHT.accent) }; font.underline = true;
          } else if (c.f) {
            x.value = { formula: c.f, result: c.v };
          } else if (numeric) {
            x.value = typeof c.v === "number" && isFinite(c.v) ? c.v : (c.v == null ? null : c.v);
          } else {
            x.value = c.v == null ? "" : String(c.v);
          }
          if (fmt && (numeric || (c.f && typeof c.v === "number"))) x.numFmt = fmt;
          if (numeric) al.horizontal = "right";
          if (c.link) { font.color = { argb: argb(LIGHT.accent) }; font.underline = true; }
          if (c.bold) font.bold = true;
          if (c.size) font.size = c.size;
          if (c.color) font.color = { argb: argb(c.color) };
          if (c.fill) fill = c.fill;
          if (c.align) al.horizontal = c.align;
          if (c.indent) al.indent = c.indent;
          if (c.box) { var bb = border(c.box, "medium"); bd = { top: bb, bottom: bb, left: bb, right: bb }; }

          x.font = font;
          if (fill) x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
          if (Object.keys(bd).length) x.border = bd;
          if (c.dv) x.dataValidation = validation(c.dv);
          if (st === "input") x.protection = { locked: false };
          if (c.name) wb.definedNames.add(quoteSheet(sh.name) + "!$" + colLetter(ci + 1) + "$" + (ri + 1), c.name);

          var span = Math.min(c.span || 1, ncols - ci);
          if (c.wrap) {
            al.wrapText = true; al.vertical = "top";
            var chars = 0;
            for (var k = 0; k < span; k++) chars += sh.columns[ci + k];
            maxLines = Math.max(maxLines, Math.ceil(String(c.v == null ? "" : c.v).length / Math.max(10, chars * 1.15)));
            if (span > 1) ws.mergeCells(ri + 1, ci + 1, ri + 1, ci + span);
          }
          x.alignment = al;
          if (span > 1 && !c.wrap) {
            for (var j = 1; j < span; j++) {
              var y = exRow.getCell(ci + 1 + j);
              if (fill) y.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
              if (Object.keys(bd).length) y.border = bd;
            }
          }
        });
        if (maxLines > 1) exRow.height = Math.min(409, Math.ceil(maxLines * 13 + 4));
        else if (row && row.some(function (c) { return c && c.s === "title"; })) exRow.height = 24;
        else if (row && row.some(function (c) { return c && c.s === "colhead"; })) exRow.height = 30;
      });
      sh.ranges.forEach(function (rg) { wb.definedNames.add(rg.ref, rg.name); });
      sh.cf.forEach(function (cf) {
        if (cf.kind === "sign") {
          ws.addConditionalFormatting({ ref: cf.ref.replace(/\$/g, ""), rules: [
            { type: "cellIs", operator: "greaterThan", priority: 1, formulae: ["0.5"], style: { font: { color: { argb: argb(LIGHT.goodText) }, bold: true } } },
            { type: "cellIs", operator: "lessThan", priority: 2, formulae: ["-0.5"], style: { font: { color: { argb: argb(LIGHT.critText) }, bold: true } } }
          ] });
        } else if (cf.kind === "heat") {
          ws.addConditionalFormatting({ ref: cf.ref, rules: [
            { type: "colorScale", priority: 4, cfvo: [{ type: "min" }, { type: "num", value: 0 }, { type: "max" }],
              color: [{ argb: argb(LIGHT.divNeg) }, { argb: argb(LIGHT.divMid) }, { argb: argb(LIGHT.divPos) }] }
          ] });
        } else if (cf.kind === "rowMark") {
          ws.addConditionalFormatting({ ref: cf.ref.replace(/\$/g, ""), rules: [
            { type: "expression", priority: 3, formulae: ["$" + cf.noteCol + cf.first + '<>""'], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: argb(LIGHT.accentWash) } } } }
          ] });
        }
      });
      if (sh.freeze) ws.pageSetup.printTitlesRow = "1:" + sh.freeze;
    });
    return wb;
  }

  function validation(dv) {
    var base = { allowBlank: true, showErrorMessage: true, errorStyle: "stop" };
    if (dv.type === "list") return Object.assign(base, { type: "list", allowBlank: !!dv.blank, formulae: ['"' + dv.list.join(",") + '"'], errorTitle: "Pick from the list", error: "Choose one of: " + dv.list.join(", ") });
    if (dv.type === "range") return Object.assign(base, { type: "whole", operator: "between", formulae: [dv.min, dv.max], errorTitle: "Out of range", error: "Enter a whole number from " + dv.min + " to " + dv.max + "." });
    if (dv.type === "int0") return Object.assign(base, { type: "whole", operator: "greaterThanOrEqual", formulae: [0], errorTitle: "Whole number", error: "Enter a whole number, 0 or more." });
    if (dv.type === "pct") { var mx = dv.max || 1; return Object.assign(base, { type: "decimal", operator: "between", formulae: [0, mx], errorTitle: "Percent", error: "Enter a percent from 0% to " + Math.round(mx * 100) + "%." }); }
    return Object.assign(base, { type: "decimal", operator: "greaterThanOrEqual", formulae: [0], errorTitle: "Amount", error: "Enter an amount, 0 or more." });
  }

  // What the Sheets API adds after upload (the .xlsx can't carry a warning-only lock or a chart that
  // Google keeps): input cell ranges, per sheet, to leave unprotected, and the profit chart's source.
  function decorations(sheets) {
    var out = { sheets: [], inputs: [], chart: null };
    sheets.forEach(function (sh) {
      out.sheets.push(sh.name);
      var cols = {};
      sh.rows.forEach(function (row, ri) {
        (row || []).forEach(function (c, ci) { if (c && c.s === "input") (cols[ci] = cols[ci] || []).push(ri); });
      });
      Object.keys(cols).forEach(function (ci) {
        var rows = cols[ci], start = rows[0], prev = rows[0];
        for (var i = 1; i <= rows.length; i++) {
          if (i < rows.length && rows[i] === prev + 1) { prev = rows[i]; continue; }
          out.inputs.push({ sheet: sh.name, r1: start, r2: prev + 1, c1: +ci, c2: +ci + 1 }); // 0-based, end exclusive
          if (i < rows.length) { start = prev = rows[i]; }
        }
      });
      if (sh.chart) out.chart = { sheet: sh.name, headerRow: sh.chart.headerRow - 1, lastRow: sh.chart.lastRow, nCol: sh.chart.nCol - 1, netCol: sh.chart.netCol - 1,
        payCol: sh.chart.payCol ? sh.chart.payCol - 1 : null };
    });
    return out;
  }

  return { buildSheets: buildSheets, writeWorkbook: writeWorkbook, decorations: decorations, fileName: X.fileName,
    START_LABEL: START_LABEL, BASIS_LABEL: BASIS_LABEL, TAX_LABEL: TAX_LABEL, FEE_LABEL: FEE_LABEL };
});
