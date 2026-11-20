/* Show Feasibility: the live spreadsheet export (light build).
 * Works in the browser (window.ShowWorkbook) and in Node (module.exports). Needs export.js (ShowExport).
 *
 *   buildSheets(inputs, n, Model, opts) -> [{ name, columns, rows, ranges, cf, freeze, freezeCols, tab }]
 *   writeWorkbook(ExcelJS, sheets)      -> ExcelJS workbook
 *
 * Live chain: yellow cells on Inputs -> named amounts on Costs and Talent -> "By ticket count"
 * (one row per ticket count; ticket-side columns are values from the calculator, cost-side columns
 * are formulas) -> every "at the chosen count" number via INDEX(column, ChosenN + 1).
 * A cell is yellow only when everything downstream of it is a formula. Ticket-side inputs (price,
 * tax, fees, online/door split, venue % and per-head, capacity) are gray: change them in the calculator.
 *
 * Cell: { v, t: 'money'|'int'|'pct'|'text'|'link'|'auto', s: style, f: formula without '=', name,
 *         dv: data validation, fmt, bold, color, fill, align, wrap, span, indent, box }
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
  var NEVER = 1000000000; // threshold stand-in for "never reached"
  var EPS = "0.000000001";
  var SNAP_NOTE = "Gray numbers are from the calculator at export. Change those in the calculator and export again.";
  var EDIT_NOTE = "Yellow cells on the Inputs tab can be changed here; everything else recalculates.";
  var BLANK_CUSTOM_ROWS = 5;

  // ---------------------------------------------------------------- tiny builders
  function colLetter(c) { var s = ""; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function quoteSheet(name) { return "'" + name.replace(/'/g, "''") + "'"; }
  function Sheet(name, columns, tab) {
    this.name = name; this.columns = columns; this.rows = []; this.ranges = []; this.cf = []; this.freeze = 0; this.freezeCols = 0; this.tab = tab;
  }
  Sheet.prototype.add = function (cells) { this.rows.push(cells || []); return this.rows.length; };
  Sheet.prototype.abs = function (col, row) { return quoteSheet(this.name) + "!$" + colLetter(col) + "$" + row; };
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
  function snap(v, t, extra) { return cell(v, t, "snap", extra); }
  function choice(list) { return { type: "list", list: list }; }

  function onOff(b) { return b ? ON : OFF; }
  function idx(col) { return "INDEX(" + col + ",ChosenN+1)"; }
  function basisValue(r, basis) { return basis === "grossFace" ? r.grossFace : basis === "net" ? r.netTicketRevenue : r.faceNet; }
  function threshold(start, startN, hlBE) {
    if (start === "first") return 0;
    if (start === "afterN") return Math.max(0, startN);
    return hlBE === null ? NEVER : hlBE;
  }

  function topBlock(sh, title, ctx) {
    sh.add([null, txt(title, "title")]);
    sh.add([null, txt(ctx.title, "label", { bold: true })]);
    sh.add([null, txt("Exported " + ctx.date + " at " + ctx.r.n + " tickets, " + X.priceText(ctx.inp.price) + " a ticket" +
      (ctx.inp.doorPriceOn ? " (" + X.priceText(ctx.inp.doorPrice) + " at the door)" : "") + ". " + EDIT_NOTE, "muted", { span: 6 })]);
    sh.add([null, cell(ctx.link, "link", "muted", { text: "Open this scenario in the calculator" })]);
    sh.add([]);
  }
  function heading(sh, text, span) { sh.add([null, txt(text, "heading", { span: span || 3 })]); }

  // ---------------------------------------------------------------- the workbook
  function buildSheets(inputs, n, M, opts) {
    opts = opts || {};
    var inp = M.sanitize(inputs);
    var S = M.sellable(inp);
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
      link: X.encodeLink(inp, n, M)
    };
    var pn = X.platLabel(inp);
    var pctThr = threshold(inp.hlPctStart, inp.hlPctStartN, hlBE);
    var ptThr = threshold(inp.hlPerTicketStart, inp.hlPerTicketStartN, hlBE);
    var pctBasisAtStart = pctThr > 0 ? basisValue(rs[Math.min(pctThr, S)], inp.hlPctBasis) : 0;
    var guaranteeAmt = inp.hlGuaranteeOn ? inp.hlGuarantee : 0;
    var talentTotal = h.total + L.support + L.vj;
    var laborAmt = L.soundTechs + L.stagehands;
    var inflow = r.inflow;

    var sheets = {};

    // ---------- Inputs
    var I = new Sheet("Inputs", [2, 50, 18, 10, 52], LIGHT.input);
    sheets.inputs = I;
    topBlock(I, "Inputs", ctx);
    function inRow(label, valueCell, toggleCell, note) {
      return I.add([null, txt(label, "label"), valueCell, toggleCell || null, note ? txt(note, "muted") : null]);
    }
    function yMoney(v, name) { return cell(v, "money", "input", { name: name, dv: { type: "min0" } }); }
    function yInt(v, name) { return cell(v, "int", "input", { name: name, dv: { type: "int0" } }); }
    function yPct(v, name) { return cell(v / 100, "pct", "input", { name: name, fmt: FMT.pctIn, dv: { type: "pct" } }); }
    function yOn(b, name) { return cell(onOff(b), "text", "input", { name: name, dv: choice([ON, OFF]), align: "center" }); }
    function yChoice(v, name, list) { return cell(v, "text", "input", { name: name, dv: choice(list) }); }
    function gOn(b) { return snap(onOff(b), "text", { align: "center" }); }

    heading(I, "This snapshot", 4);
    inRow("Tickets sold", cell(n, "int", "input", { name: "TicketsSold", dv: { type: "range", min: 0, max: S } }), null, "0 to " + S + " (sellable tickets).");
    I.add([]);

    heading(I, "Set in the calculator (gray)", 4);
    inRow("Venue capacity", snap(inp.capacity, "int"));
    inRow("Comps / guest list", snap(inp.comps, "int", { name: "Comps" }));
    inRow("Sellable tickets", snap(S, "int", { name: "Sellable" }));
    inRow("Ticket price", snap(inp.price, "money"));
    inRow("Different price at the door", snap(inp.doorPrice, "money"), gOn(inp.doorPriceOn));
    inRow("Sold online via " + pn, snap(inp.onlinePct / 100, "pct", { fmt: FMT.pctIn }), null, "The rest sell at the door.");
    inRow("Door sales paid in cash", snap(inp.doorCashPct / 100, "pct", { fmt: FMT.pctIn }));
    inRow("Door card processing", snap(inp.doorCardPct / 100, "pct", { fmt: FMT.pctIn }));
    inRow("Plus per card ticket", snap(inp.doorCardFixed, "money"));
    inRow("Sales tax rate", snap(inp.taxRate / 100, "pct", { fmt: FMT.pctIn }), gOn(inp.taxOn));
    inRow("Sales tax is", snap(inp.taxMode === "included" ? "Included in price" : "Added on top", "text", { align: "right" }));
    inRow("Ticketing platform", snap(pn, "text", { align: "right" }));
    inRow(pn + " fees", snap(inp.ebMode === "pass" ? "Passed to buyer" : "Absorbed by us", "text", { align: "right" }));
    inRow("Service fee", snap(inp.ebServicePct / 100, "pct", { fmt: FMT.pctIn }));
    inRow("Plus per ticket", snap(inp.ebServiceFixed, "money"));
    inRow("Payment processing", snap(inp.ebProcPct / 100, "pct", { fmt: FMT.pctIn }));
    inRow("Venue % of door", snap(inp.doorCutPct / 100, "pct", { fmt: FMT.pctIn }), gOn(inp.doorCutOn));
    inRow("% of door is taken from", snap(X.CUT_SHORT[inp.doorCutBasis], "text", { align: "right" }));
    inRow("Venue per-head fee", snap(inp.venuePerHead, "money"), gOn(inp.venuePerHeadOn), "Everyone in the room, comps included.");
    inRow("Default tickets sold (% of sellable)", snap(inp.expectedPct / 100, "pct", { fmt: FMT.pctIn }));
    I.add([]);

    heading(I, "Headliner deal", 4);
    inRow("Guarantee (flat)", yMoney(inp.hlGuarantee, "HLGuarantee"), yOn(inp.hlGuaranteeOn, "HLGuaranteeOn"));
    inRow("% of ticket sales", yPct(inp.hlPct, "HLPct"), yOn(inp.hlPctOn, "HLPctOn"));
    inRow("% of", yChoice(BASIS_LABEL[inp.hlPctBasis], "HLPctBasis", [BASIS_LABEL.grossFace, BASIS_LABEL.faceNet, BASIS_LABEL.net]));
    inRow("% starts", yChoice(START_LABEL[inp.hlPctStart], "HLPctStart", [START_LABEL.first, START_LABEL.breakEven, START_LABEL.afterN]));
    inRow("% starts after how many tickets", yInt(inp.hlPctStartN, "HLPctStartN"), null, "Used when % starts is " + START_LABEL.afterN + ".");
    inRow("$ per ticket sold", yMoney(inp.hlPerTicket, "HLPerTicket"), yOn(inp.hlPerTicketOn, "HLPerTicketOn"));
    inRow("$ per ticket starts", yChoice(START_LABEL[inp.hlPerTicketStart], "HLPerTicketStart", [START_LABEL.first, START_LABEL.breakEven, START_LABEL.afterN]));
    inRow("$ per ticket starts after how many tickets", yInt(inp.hlPerTicketStartN, "HLPerTicketStartN"));
    inRow("Backend: % of profit after break-even", yPct(inp.hlBackendPct, "HLBackendPct"), yOn(inp.hlBackendOn, "HLBackendOn"));
    inRow("Versus: pay the greater of the guarantee or the % and per-ticket parts",
      cell(inp.hlVersus ? YES : NO, "text", "input", { name: "HLVersus", dv: choice([YES, NO]), align: "center" }), null, "Backend is still added on top.");
    inRow("Travel / hotel", yMoney(inp.hlTravel, "HLTravel"));
    inRow("Hospitality / rider", yMoney(inp.hlHospitality, "HLHospitality"));
    I.add([]);

    heading(I, "Support & VJ", 4);
    inRow("Supporting slots", yInt(inp.supportSlots, "SupportSlots"));
    inRow("Price per slot", yMoney(inp.supportPrice, "SupportPrice"));
    inRow("VJ", yMoney(inp.vj, "VJFee"), yOn(inp.vjOn, "VJOn"));
    I.add([]);

    heading(I, "Venue", 4);
    inRow("Flat rental / fee", yMoney(inp.venueRental, "VenueRental"), yOn(inp.venueRentalOn, "VenueRentalOn"));
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

    // ---------- By ticket count (built before the sheets that read it; listed last)
    var B = new Sheet("By ticket count", [], LIGHT.ink2);
    sheets.byT = B;
    var COLS = [
      // key, header, width, kind ('res' result column, 'snap' calculator value, 'work' formula), type
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
      ["doorCard", "Door card tickets", 11, "snap", "int"],
      ["gross", "Gross face", 13, "snap", "money"],
      ["faceNet", "Face net of tax", 13, "snap", "money"],
      ["tax", "Sales tax", 12, "snap", "money"],
      ["fees", pn + " fees", 12, "snap", "money"],
      ["passed", "Fees paid by buyers", 12, "snap", "money"],
      ["absorbed", "Fees we absorb", 12, "snap", "money"],
      ["doorProc", "Door card processing", 12, "snap", "money"],
      ["doorCut", "Venue % of door", 12, "snap", "money"],
      ["perHead", "Per-head fee", 12, "snap", "money"],
      ["paidOn", "Buyers paid online", 13, "snap", "money"],
      ["paidDoor", "Buyers paid at door", 13, "snap", "money"],
      ["base", "Net before bonus parts", 14, "work", "money"],
      ["basis", "Headliner % basis", 13, "work", "money"],
      ["pctPart", "% part", 11, "work", "money"],
      ["ptPart", "$ per ticket part", 11, "work", "money"],
      ["deal", "Deal pay", 11, "work", "money"],
      ["nbb", "Net before backend", 14, "work", "money"],
      ["backend", "Backend", 11, "work", "money"],
      ["baseFlag", "Past headliner break-even", 10, "work", "int"],
      ["netFlag", "Past show break-even", 10, "work", "int"]
    ];
    var C = {};
    COLS.forEach(function (c, i) { C[c[0]] = i + 1; });
    B.columns = COLS.map(function (c) { return c[2]; });
    function L$(key) { return colLetter(C[key]); }
    B.add([txt("By ticket count", "title")]);
    B.add([txt(ctx.title, "label", { bold: true })]);
    B.add([txt("One row per ticket count at " + X.priceText(inp.price) + " a ticket. Gray columns come from the calculator; the rest are formulas.", "muted", { span: 9 })]);
    var chosenRow = B.add([txt("Chosen count", "label", { bold: true, span: 2 }), null,
      fx("MIN(MAX(ROUND(TicketsSold,0),0),Sellable)", n, "int", "total", { name: "ChosenN" }), txt("From Tickets sold on Inputs.", "muted", { span: 4 })]);
    var bandRow = B.add([txt("Results", "band", { span: 9 }), null, null, null, null, null, null, null, null, null,
      txt("Ticket side (from the calculator)", "band", { span: 12, fill: "#ecebe6" }), null, null, null, null, null, null, null, null, null, null, null,
      txt("Headliner and profit (formulas)", "band", { span: 9 })]);
    var head = B.add(COLS.map(function (c) { return c[0] === "gap" ? null : txt(c[1], "colhead", { wrap: true, align: c[4] === "text" ? "left" : "right" }); }));
    var r0 = head + 1, rN = head + 1 + S;
    B.freeze = head; B.freezeCols = 1;
    rs.forEach(function (x, i) {
      var R = r0 + i, row = [];
      function ref(key) { return L$(key) + R; }
      var basis = basisValue(x, inp.hlPctBasis);
      var nbb = x.netBeforeBackend;
      var base = x.netTicketRevenue + inp.otherIncome - x.fixedCostsTotal;
      var vals = {
        n: cell(x.n, "int", "label"),
        online: snap(x.counts.online, "int"), door: snap(x.counts.door, "int"), paid: snap(x.buyersPaid, "money"), ntr: snap(x.netTicketRevenue, "money"),
        hlpay: fx(ref("deal") + "+" + ref("backend"), x.headliner.pay, "money", "label"),
        costs: fx("FixedTotal+(" + ref("deal") + "-GuaranteeAmt)+" + ref("backend"), x.totalCosts, "money", "label"),
        net: fx(ref("nbb") + "-" + ref("backend"), x.net, "money", "label", { bold: true }),
        note: fx('IF(' + ref("n") + '=BreakEven,"Break-even","")&IF(AND(' + ref("n") + '=BreakEven,' + ref("n") + '=ChosenN),", ","")&IF(' + ref("n") + '=ChosenN,"Chosen count","")',
          (be === x.n ? "Break-even" : "") + (be === x.n && n === x.n ? ", " : "") + (n === x.n ? "Chosen count" : ""), "text", "label", { bold: true }),
        gap: null,
        doorCard: snap(x.counts.doorCard, "int"), gross: snap(x.grossFace, "money"), faceNet: snap(x.faceNet, "money"), tax: snap(x.tax, "money"),
        fees: snap(x.eventbrite.total, "money"), passed: snap(x.eventbrite.passed, "money"), absorbed: snap(x.eventbrite.absorbed, "money"),
        doorProc: snap(x.doorProc, "money"), doorCut: snap(x.doorCut, "money"), perHead: snap(x.venue.perHead, "money"),
        paidOn: snap(x.buyersPaidOnline, "money"), paidDoor: snap(x.buyersPaidDoor, "money"),
        base: fx(ref("ntr") + "+OtherIncome-FixedTotal", base, "money", "work"),
        basis: fx('IF(HLPctBasis="' + BASIS_LABEL.grossFace + '",' + ref("gross") + ',IF(HLPctBasis="' + BASIS_LABEL.net + '",' + ref("ntr") + "," + ref("faceNet") + "))", basis, "money", "work"),
        pctPart: fx('IF(AND(HLPctOn="On",' + ref("n") + ">PctThreshold),MAX(0," + ref("basis") + "-PctBasisAtStart)*HLPct,0)", x.headliner.pctPart, "money", "work"),
        ptPart: fx('IF(HLPerTicketOn="On",MAX(0,' + ref("n") + "-PerTicketThreshold)*HLPerTicket,0)", x.headliner.perTicketPart, "money", "work"),
        deal: fx('IF(HLVersus="Yes",MAX(GuaranteeAmt,' + ref("pctPart") + "+" + ref("ptPart") + "),GuaranteeAmt+" + ref("pctPart") + "+" + ref("ptPart") + ")", x.headliner.dealPay, "money", "work"),
        nbb: fx(ref("ntr") + "+OtherIncome-FixedTotal-(" + ref("deal") + "-GuaranteeAmt)", nbb, "money", "work"),
        backend: fx('IF(HLBackendOn="On",MAX(0,' + ref("nbb") + ")*HLBackendPct,0)", x.headliner.backend, "money", "work"),
        baseFlag: fx("IF(" + ref("base") + ">=-" + EPS + ",1,0)", base >= -1e-9 ? 1 : 0, "int", "work"),
        netFlag: fx("IF(" + ref("net") + ">=-" + EPS + ",1,0)", x.net >= -1e-9 ? 1 : 0, "int", "work")
      };
      COLS.forEach(function (c) { row.push(vals[c[0]]); });
      B.add(row);
    });
    var BYT = {
      n: "ByT_Tickets", online: "ByT_Online", door: "ByT_Door", paid: "ByT_BuyersPaid", ntr: "ByT_NTR", hlpay: "ByT_HLPay", costs: "ByT_TotalCosts", net: "ByT_Net",
      doorCard: "ByT_DoorCard", gross: "ByT_GrossFace", faceNet: "ByT_FaceNet", tax: "ByT_Tax", fees: "ByT_Fees", passed: "ByT_FeesPassed", absorbed: "ByT_FeesAbsorbed",
      doorProc: "ByT_DoorProc", doorCut: "ByT_DoorCut", perHead: "ByT_PerHead", paidOn: "ByT_PaidOnline", paidDoor: "ByT_PaidDoor",
      basis: "ByT_HLBasis", pctPart: "ByT_PctPart", ptPart: "ByT_PerTicketPart", deal: "ByT_DealPay", backend: "ByT_Backend", baseFlag: "ByT_BaseFlag", netFlag: "ByT_NetFlag"
    };
    Object.keys(BYT).forEach(function (k) { B.range(BYT[k], C[k], r0, rN); });
    B.signCF("$" + L$("net") + "$" + r0 + ":$" + L$("net") + "$" + rN);
    B.cf.push({ ref: "$A$" + r0 + ":$" + L$("note") + "$" + rN, kind: "rowMark", noteCol: L$("note"), first: r0 });
    void chosenRow; void bandRow;

    // ---------- Costs
    var Co = new Sheet("Costs", [2, 60, 18, 12], LIGHT.s7);
    sheets.costs = Co;
    topBlock(Co, "Costs", ctx);
    heading(Co, "Cost ledger at the chosen count");
    Co.add([null, fx('"At "&ChosenN&" tickets"', "At " + n + " tickets", "text", "muted")]);
    function line(label, f, v, name, extra) { return Co.add([null, txt(label, "label", { indent: 1 }), fx(f, v, "money", "label", Object.assign({ name: name }, extra || {}))]); }
    function sub(label, f, v) { return Co.add([null, txt(label, "subtotal"), fx(f, v, "money", "subtotal")]); }
    function group(title) { Co.add([null, txt(title, "subhead", { span: 2 })]); }
    group("Talent");
    line("Headliner pay", "HLPayAtCount", h.pay);
    line("Headliner travel / hotel and hospitality", "HLTravel+HLHospitality", L.headlinerTravel + L.headlinerHospitality);
    line("Supporting artists (slots x price per slot)", "SupportSlots*SupportPrice", L.support, "SupportAmt");
    line("VJ", 'IF(VJOn="On",VJFee,0)', L.vj, "VJAmt");
    sub("Talent subtotal", "HLPayAtCount+HLTravel+HLHospitality+SupportAmt+VJAmt", talentTotal);
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
      fx("GuaranteeAmt+HLTravel+HLHospitality+SupportAmt+VJAmt+VenueRentalAmt+SoundTechsAmt+StagehandsAmt+SecurityAmt+SoundAmt+GearAmt+PhotoAmt+AdsAmt+PosterAmt+InsuranceAmt+CustomAmt",
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
    [["Talent", "HLPayAtCount+HLTravel+HLHospitality+SupportAmt+VJAmt", talentTotal],
     ["Venue rental", "VenueRentalAmt", L.venueRental],
     ["Labor", "SoundTechsAmt+StagehandsAmt", laborAmt],
     ["Production", "SecurityAmt+SoundAmt+GearAmt+PhotoAmt", L.security + L.sound + L.gear + L.photo],
     ["Marketing", "AdsAmt+PosterAmt", L.ads + L.poster],
     ["Insurance", "InsuranceAmt", L.insurance],
     ["Custom", "CustomAmt", L.custom],
     ["Contingency", "Contingency", r.contingency]].forEach(function (c) { Co.add([null, txt(c[0], "label"), fx(c[1], c[2], "money", "label")]); });
    Co.add([null, txt("Total costs", "total"), fx("TotalCostsAtCount", r.totalCosts, "money", "total")]);

    // ---------- Talent
    var T = new Sheet("Talent", [2, 62, 18, 40], LIGHT.s4);
    sheets.talent = T;
    topBlock(T, "Talent", ctx);
    heading(T, "Headliner payout at the chosen count");
    T.add([null, txt("Deal as exported: " + X.hlDescription(inp) + ". Change the deal on Inputs.", "muted", { span: 3, wrap: true })]);
    function trow(label, f, v, extra, s) { return T.add([null, txt(label, s || "label", { indent: s ? undefined : 1 }), fx(f, v, "money", s || "label", extra)]); }
    trow("Guarantee", 'IF(HLGuaranteeOn="On",HLGuarantee,0)', guaranteeAmt, { name: "GuaranteeAmt" });
    trow("% of ticket sales part", idx("ByT_PctPart"), h.pctPart);
    trow("$ per ticket part", idx("ByT_PerTicketPart"), h.perTicketPart);
    trow("Deal pay (versus takes the greater of the guarantee or the parts above)", idx("ByT_DealPay"), h.dealPay);
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
    trow("VJ", "VJAmt", L.vj);
    trow("Total talent cost", "HLAllIn+SupportAmt+VJAmt", talentTotal, null, "total");
    T.add([]);
    heading(T, "Working values");
    T.add([null, txt("Used by the formulas. " + NEVER.toLocaleString("en-US") + " stands for never.", "muted", { span: 3 })]);
    function startF(startName, nName) {
      return 'IF(' + startName + '="' + START_LABEL.first + '",0,IF(' + startName + '="' + START_LABEL.afterN + '",MAX(0,' + nName + '),IF(ISNUMBER(HLBreakEven),HLBreakEven,' + NEVER + ')))';
    }
    T.add([null, txt("% part threshold (tickets)", "label"), fx(startF("HLPctStart", "HLPctStartN"), pctThr, "int", "work", { name: "PctThreshold" })]);
    T.add([null, txt("$ per ticket part threshold (tickets)", "label"), fx(startF("HLPerTicketStart", "HLPerTicketStartN"), ptThr, "int", "work", { name: "PerTicketThreshold" })]);
    T.add([null, txt("% basis at the threshold", "label"), fx("IF(PctThreshold>0,INDEX(ByT_HLBasis,MIN(PctThreshold,Sellable)+1),0)", pctBasisAtStart, "money", "work", { name: "PctBasisAtStart" })]);

    // ---------- Tickets & fees
    var Tk = new Sheet("Tickets & fees", [2, 56, 18, 10], LIGHT.s1);
    sheets.tickets = Tk;
    topBlock(Tk, "Tickets & fees", ctx);
    heading(Tk, "Per ticket (from the calculator)");
    Tk.add([null, txt(X.fmt$(inp.price, { cents: true }) + " face price" + (inp.doorPriceOn ? ", " + X.fmt$(inp.doorPrice, { cents: true }) + " at the door" : ""), "muted")]);
    X.perTicketRows(r, inp).forEach(function (rw, i, all) {
      var st = rw.cls === "total" ? "total" : "label";
      if (i === all.length - 1) {
        Tk.add([null, txt(rw.label, "total", { wrap: true }), fx('IF(ChosenN>0,NTRAtCount/ChosenN,"n/a")', r.n ? r.netTicketRevenue / r.n : "n/a", "auto", "total", { fmt: FMT.money })]);
        return;
      }
      Tk.add([null, txt(rw.label, st, { indent: rw.cls === "sub" ? 1 : undefined }), rw.t === "text" ? snap(String(rw.v), "text", { align: "right" }) : snap(rw.v, "money", { bold: st === "total" })]);
    });
    Tk.add([]);
    heading(Tk, "Ticket money at the chosen count");
    Tk.add([null, fx('ChosenN&" sold + "&Comps&" comps = "&(ChosenN+Comps)&" attending"', n + " sold + " + inp.comps + " comps = " + (n + inp.comps) + " attending", "text", "muted")]);
    function tm(label, f, v, t, s) { Tk.add([null, txt(label, s || "label", { indent: s === "sub" ? 1 : undefined }), fx(f, v, t || "money", s === "sub" ? "label" : (s || "label"))]); }
    tm("Online tickets (" + pn + ")", idx("ByT_Online"), r.counts.online, "int");
    tm("Door tickets", idx("ByT_Door"), r.counts.door, "int");
    tm("Door tickets paid by card", idx("ByT_DoorCard"), r.counts.doorCard, "int", "sub");
    tm("Buyers paid online", idx("ByT_PaidOnline"), r.buyersPaidOnline, "money", "sub");
    tm("Buyers paid at the door", idx("ByT_PaidDoor"), r.buyersPaidDoor, "money", "sub");
    tm("Everything buyers paid", idx("ByT_BuyersPaid"), r.buyersPaid, "money", "total");
    tm("Sales tax collected (to the state)", "-" + idx("ByT_Tax"), -r.tax);
    tm(pn + " fees paid by buyers", "-" + idx("ByT_FeesPassed"), -r.eventbrite.passed);
    tm("Ticket sales after tax", idx("ByT_FaceNet"), r.faceNet, "money", "total");
    tm(pn + " fees we absorb", "-" + idx("ByT_FeesAbsorbed"), -r.eventbrite.absorbed);
    tm("Door card processing", "-" + idx("ByT_DoorProc"), -r.doorProc);
    tm("Venue % of door", "-" + idx("ByT_DoorCut"), -r.venue.doorCut);
    tm("Venue per-head fee", "-" + idx("ByT_PerHead"), -r.venue.perHead);
    tm("Net ticket revenue (ours)", "NTRAtCount", r.netTicketRevenue, "money", "total");

    // ---------- Venue
    var V = new Sheet("Venue", [2, 50, 18, 18], LIGHT.s3);
    sheets.venue = V;
    topBlock(V, "Venue", ctx);
    heading(V, "Deal");
    V.add([null, txt("% of door (from the calculator)", "label"), snap(inp.doorCutOn ? inp.doorCutPct / 100 : 0, "pct", { fmt: FMT.pctIn }), txt(inp.doorCutOn ? "of " + X.CUT_SHORT[inp.doorCutBasis] : "off", "muted")]);
    V.add([null, txt("Flat rental / fee", "label"), fx('IF(VenueRentalOn="On",VenueRental,0)', L.venueRental, "money", "label"), txt("Change on Inputs", "muted")]);
    V.add([null, txt("Per-head fee (from the calculator)", "label"), snap(inp.venuePerHeadOn ? inp.venuePerHead : 0, "money"), txt("Everyone in the room, comps included", "muted")]);
    V.add([]);
    heading(V, "What the venue takes");
    var so = rs[S];
    V.add([null, txt("Part", "subhead"), fx('"At "&ChosenN&" tickets"', "At " + n + " tickets", "text", "subhead", { align: "right" }), txt("Sold out (" + S + ")", "subhead", { align: "right" })]);
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
    Su.add([null, txt(ctx.title, "label", { bold: true, span: 6 })]);
    Su.add([null, txt("Exported " + ctx.date + ". " + EDIT_NOTE + " " + SNAP_NOTE, "muted", { span: 7, wrap: true })]);
    Su.add([null, cell(ctx.link, "link", "muted", { text: "Open this scenario in the calculator" })]);
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
    Su.add([null, txt("Buyer pays online", "label"), snap(r.buyerPaysOnline, "money"), txt(pn + " fees " + (inp.ebMode === "pass" ? "passed to the buyer" : "absorbed by us"), "muted", { span: 3 })]);
    Su.add([null, txt("Buyer pays at the door", "label"), snap(r.buyerPaysDoor, "money")]);
    var bp = M.breakEvenPrice(inp, n);
    Su.add([null, txt("Break-even price at " + n + " tickets (snapshot)", "label"), bp === null ? snap("None", "text", { align: "right" }) : snap(bp, "money"),
      txt("From the calculator; doesn't update here.", "muted", { span: 3 })]);
    Su.add([]);

    heading(Su, "Where the money goes", 7);
    Su.add([null, fx('"At "&ChosenN&" tickets: buyers paid, plus other income"', "At " + n + " tickets: buyers paid, plus other income", "text", "muted", { span: 4 })]);
    Su.add([null, txt("Goes to", "subhead"), txt("Amount", "subhead", { align: "right" }), txt("Share", "subhead", { align: "right" }), txt("Per ticket sold", "subhead", { align: "right" })]);
    var MONEY_F = {
      tax: idx("ByT_Tax"), ebFees: idx("ByT_Fees"), doorProc: idx("ByT_DoorProc"),
      venue: idx("ByT_DoorCut") + "+" + idx("ByT_PerHead") + "+VenueRentalAmt",
      headliner: "HLAllIn", supportVj: "SupportAmt+VJAmt",
      production: "SoundAmt+SecurityAmt+GearAmt+SoundTechsAmt+StagehandsAmt",
      marketing: "AdsAmt+PosterAmt", other: "InsuranceAmt+PhotoAmt+CustomAmt+Contingency",
      profit: "MAX(0,NetAtCount)", loss: "MAX(0,-NetAtCount)"
    };
    var whole = inflow + r.money.loss;
    function moneyRow(key, label, hex, v, st, color) {
      var f = MONEY_F[key];
      Su.add([hex ? txt("", "label", { fill: hex }) : null, txt(label, st || "label", { color: color }),
        fx(f, v, "money", st || "label", { name: "Money_" + key, color: color }),
        fx("IF(Inflow+Money_loss>0,Money_" + key + "/(Inflow+Money_loss),0)", whole > 0 ? v / whole : 0, "pct", st || "label", { color: color }),
        fx("IF(ChosenN>0,Money_" + key + "/ChosenN,0)", n > 0 ? v / n : 0, "money", st || "label", { color: color })]);
    }
    X.CATS.forEach(function (c) { moneyRow(c.k, X.catLabel(c, inp), c.hex, r.money[c.k]); });
    moneyRow("loss", "Loss (costs not covered)", null, r.money.loss, "label", LIGHT.critText);
    Su.add([null, txt("Buyers paid + other income", "total"), fx(idx("ByT_BuyersPaid") + "+OtherIncome", inflow, "money", "total", { name: "Inflow" }), txt("", "total"),
      fx("IF(ChosenN>0,Inflow/ChosenN,0)", n > 0 ? inflow / n : 0, "money", "total")]);
    Su.add([]);

    heading(Su, "Scenarios at this price", 7);
    Su.add([null, txt("At " + X.priceText(inp.price) + " a ticket", "muted")]);
    Su.add([null, txt("Sold", "subhead"), txt("Tickets", "subhead", { align: "right" }), txt("Net ticket revenue", "subhead", { align: "right" }),
      txt("Headliner pay", "subhead", { align: "right" }), txt("Total costs", "subhead", { align: "right" }), txt("Net", "subhead", { align: "right" })]);
    var scenFirst = 0, scenLast = 0;
    [25, 50, 75, 90, 100].forEach(function (p) {
      var k2 = Math.round(S * p / 100), x = rs[k2];
      var at = function (col) { return "INDEX(" + col + "," + (k2 + 1) + ")"; };
      var row = Su.add([null, txt(p === 100 ? "Sold out" : p + "%", "label"), cell(k2, "int", "label"),
        fx(at("ByT_NTR"), x.netTicketRevenue, "money", "label", { fmt: FMT.money0 }), fx(at("ByT_HLPay"), x.headliner.pay, "money", "label", { fmt: FMT.money0 }),
        fx(at("ByT_TotalCosts"), x.totalCosts, "money", "label", { fmt: FMT.money0 }), fx(at("ByT_Net"), x.net, "money", "label", { fmt: FMT.signed0, bold: true })]);
      if (!scenFirst) scenFirst = row;
      scenLast = row;
    });
    Su.signCF("$G$" + scenFirst + ":$G$" + scenLast);
    Su.add([]);

    heading(Su, "Net profit by price and attendance (snapshot)", 7);
    Su.add([null, txt("From the calculator at export; doesn't change when you edit this sheet. Blue is profit, red is loss.", "muted", { span: 7 })]);
    var hg = X.heatGrid(inp, M);
    Su.add([null, txt("Sold \\ price", "subhead")].concat(hg.prices.map(function (p) {
      return cell(p, "money", "subhead", { fmt: FMT.money0, align: "center", bold: true });
    })));
    hg.rows.forEach(function (row) {
      var cur = row.n === n;
      Su.add([null, txt(row.p + "% · " + row.n + " tickets", "label", { align: "right", bold: cur })].concat(row.cells.map(function (c) {
        var hc = X.heatColor(c), here = cur && Math.abs(c.price - inp.price) < 0.005;
        return cell(c.net, "money", "label", { fmt: FMT.money0, fill: hc.fill, color: hc.text, bold: true, align: "center", box: here ? LIGHT.ink : undefined });
      })));
    });

    return [sheets.summary, sheets.inputs, sheets.tickets, sheets.venue, sheets.talent, sheets.costs, sheets.byT];
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
          if (c.bold) font.bold = true;
          if (c.color) font.color = { argb: argb(c.color) };
          if (c.fill) fill = c.fill;
          if (c.align) al.horizontal = c.align;
          if (c.indent) al.indent = c.indent;
          if (c.box) { var bb = border(c.box, "medium"); bd = { top: bb, bottom: bb, left: bb, right: bb }; }

          x.font = font;
          if (fill) x.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
          if (Object.keys(bd).length) x.border = bd;
          if (c.dv) x.dataValidation = validation(c.dv);
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
    if (dv.type === "list") return Object.assign(base, { type: "list", allowBlank: false, formulae: ['"' + dv.list.join(",") + '"'], errorTitle: "Pick from the list", error: "Choose one of: " + dv.list.join(", ") });
    if (dv.type === "range") return Object.assign(base, { type: "whole", operator: "between", formulae: [dv.min, dv.max], errorTitle: "Out of range", error: "Enter a whole number from " + dv.min + " to " + dv.max + "." });
    if (dv.type === "int0") return Object.assign(base, { type: "whole", operator: "greaterThanOrEqual", formulae: [0], errorTitle: "Whole number", error: "Enter a whole number, 0 or more." });
    if (dv.type === "pct") return Object.assign(base, { type: "decimal", operator: "between", formulae: [0, 1], errorTitle: "Percent", error: "Enter a percent from 0% to 100%." });
    return Object.assign(base, { type: "decimal", operator: "greaterThanOrEqual", formulae: [0], errorTitle: "Amount", error: "Enter an amount, 0 or more." });
  }

  return { buildSheets: buildSheets, writeWorkbook: writeWorkbook, fileName: X.fileName, START_LABEL: START_LABEL, BASIS_LABEL: BASIS_LABEL };
});
