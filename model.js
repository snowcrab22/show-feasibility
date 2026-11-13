/*
 * 150-Cap Show Feasibility: pure model (no DOM).
 * Works in the browser (window.ShowModel) and in Node (module.exports).
 *
 * Money is kept unrounded internally; round only for display and asserts.
 * Every break-even scan treats net >= -EPS as break-even so floating-point
 * noise on round-number scenarios never pushes the answer one ticket late.
 *
 * Pinned readings (also listed in the page's Assumptions section):
 *  - Tax off: rate r = 0 in both tax modes.
 *  - Channel split uses whole tickets: online = round(n x online%), door = n - online;
 *    door cash = round(door x cash%), door card = door - door cash.
 *  - Headliner "gross face" = online x ticket price + door x door price. Venue door-cut basis 3
 *    ("gross face value incl. tax") also includes tax added on top.
 *  - Door card fee % applies to what the door buyer is charged (incl. on-top tax).
 *  - Door price (when on) replaces the ticket price for door tickets only; online
 *    tickets and Eventbrite fees use the ticket price. Price sweeps (break-even
 *    price, heatmap) keep the door markup fixed and move both prices together.
 *  - Thresholded % part = pct x (basis(n) - basis(threshold)), so it also works on
 *    the net-revenue basis.
 *  - Contingency base excludes every variable headliner part (% part, $/ticket,
 *    versus overage above the guarantee, backend), matching headlinerBreakEven.
 *  - Versus with guarantee off: the floor is $0.
 *  - headlinerBreakEven null (never breaks even): after-break-even parts pay $0.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShowModel = api;
})(this, function () {
  "use strict";

  var EPS = 1e-9;

  var DEFAULTS = {
    venueName: "New venue",
    // Tickets & sales
    capacity: 150,
    comps: 5,
    price: 25,
    expectedPct: 75,          // default ticket-count slider position, % of sellable
    onlinePct: 100,           // % sold online via Eventbrite
    doorPriceOn: false,       // door tickets sell at a different price
    doorPrice: 30,            // door face price when doorPriceOn
    doorCashPct: 0,           // % of door sales paid in cash
    doorCardPct: 2.6,         // door card processing %
    doorCardFixed: 0.15,      // door card processing $ per ticket
    // Sales tax
    taxOn: true,
    taxRate: 10,
    taxMode: "ontop",         // "included" | "ontop"
    // Eventbrite
    ebServicePct: 3.7,
    ebServiceFixed: 1.79,
    ebProcPct: 2.9,
    ebMode: "pass",           // "pass" | "absorb"
    // Venue deal
    doorCutPct: 15,
    doorCutBasis: "afterTaxFees", // "afterTax" | "afterTaxFees" | "gross"
    venueRental: 0,
    // Headliner deal
    hlPreset: "flatBonus",
    hlGuaranteeOn: true,
    hlGuarantee: 250,
    hlPctOn: false,
    hlPct: 20,
    hlPctBasis: "faceNet",    // "grossFace" | "faceNet" | "net"
    hlPctStart: "first",      // "first" | "breakEven" | "afterN"
    hlPctStartN: 75,
    hlPerTicketOn: true,
    hlPerTicket: 10,
    hlPerTicketStart: "breakEven",
    hlPerTicketStartN: 75,
    hlBackendOn: false,
    hlBackendPct: 20,
    hlVersus: false,
    hlTravel: 100,
    hlHospitality: 50,
    // Lineup
    supportSlots: 4,
    supportPrice: 80,
    vjOn: false,
    vj: 300,
    // Production
    securityOn: true,
    security: 100,
    soundOn: true,
    sound: 400,
    gearOn: false,
    gear: 50,
    photo: 0,
    // Marketing
    ads: 60,
    poster: 75,
    printing: 0,
    // Other
    ascapOn: false,
    ascap: 429,
    bmiOn: false,
    bmi: 449,
    insuranceOn: false,
    insurance: 357,
    contingencyPct: 5,
    custom: [],               // [{ name, amount }]
    otherIncome: 0
  };

  var ENUMS = {
    taxMode: ["included", "ontop"],
    ebMode: ["pass", "absorb"],
    doorCutBasis: ["afterTax", "afterTaxFees", "gross"],
    hlPctBasis: ["grossFace", "faceNet", "net"],
    hlPctStart: ["first", "breakEven", "afterN"],
    hlPerTicketStart: ["first", "breakEven", "afterN"],
    hlPreset: ["flat", "pct", "perTicket", "flatBackend", "flatBonus", "versus", "custom"]
  };

  // Toggle sets each preset applies. Presets only flip toggles/start points, never amounts.
  var PRESETS = {
    flat:        { hlGuaranteeOn: true,  hlPctOn: false, hlPerTicketOn: false, hlBackendOn: false, hlVersus: false },
    pct:         { hlGuaranteeOn: false, hlPctOn: true,  hlPerTicketOn: false, hlBackendOn: false, hlVersus: false, hlPctStart: "first" },
    perTicket:   { hlGuaranteeOn: false, hlPctOn: false, hlPerTicketOn: true,  hlBackendOn: false, hlVersus: false, hlPerTicketStart: "first" },
    flatBackend: { hlGuaranteeOn: true,  hlPctOn: false, hlPerTicketOn: false, hlBackendOn: true,  hlVersus: false },
    flatBonus:   { hlGuaranteeOn: true,  hlPctOn: false, hlPerTicketOn: true,  hlBackendOn: false, hlVersus: false, hlPerTicketStart: "breakEven" },
    versus:      { hlGuaranteeOn: true,  hlPctOn: true,  hlPerTicketOn: false, hlBackendOn: false, hlVersus: true,  hlPctStart: "first" }
  };

  function num(v, d) {
    var x = typeof v === "number" ? v : parseFloat(v);
    return isFinite(x) ? x : d;
  }

  // Merge any partial/untrusted object onto DEFAULTS, coercing types and whitelisting enums.
  function sanitize(raw) {
    var out = {};
    var src = raw && typeof raw === "object" ? raw : {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var d = DEFAULTS[k];
      var v = src[k];
      if (k === "custom") {
        out.custom = Array.isArray(v)
          ? v.slice(0, 50).map(function (r) {
              r = r && typeof r === "object" ? r : {};
              return { name: String(r.name == null ? "" : r.name).slice(0, 80), amount: Math.max(0, num(r.amount, 0)) };
            })
          : [];
      } else if (ENUMS[k]) {
        out[k] = ENUMS[k].indexOf(v) >= 0 ? v : d;
      } else if (typeof d === "boolean") {
        out[k] = typeof v === "boolean" ? v : d;
      } else if (typeof d === "number") {
        out[k] = v === undefined || v === null || v === "" ? d : Math.max(0, num(v, d));
      } else {
        out[k] = v == null ? d : String(v).slice(0, 80);
      }
    });
    out.capacity = Math.max(1, Math.round(out.capacity));
    out.comps = Math.min(out.capacity, Math.round(out.comps));
    out.supportSlots = Math.round(out.supportSlots);
    out.hlPctStartN = Math.round(out.hlPctStartN);
    out.hlPerTicketStartN = Math.round(out.hlPerTicketStartN);
    ["onlinePct", "doorCashPct", "expectedPct"].forEach(function (k) { out[k] = Math.min(100, out[k]); });
    out.ebProcPct = Math.min(50, out.ebProcPct);
    return out;
  }

  function sellable(inp) { return Math.max(0, inp.capacity - inp.comps); }

  function expectedTickets(inp) { return Math.round(sellable(inp) * inp.expectedPct / 100); }

  // Which preset (if any) the current toggles match.
  function detectPreset(inp) {
    var keys = Object.keys(PRESETS);
    for (var i = 0; i < keys.length; i++) {
      var p = PRESETS[keys[i]];
      var ok = Object.keys(p).every(function (k) { return inp[k] === p[k]; });
      if (ok) return keys[i];
    }
    return "custom";
  }

  // ---------------------------------------------------------------------------
  // Ticket side: everything that depends only on n and the ticket/fee/venue inputs.
  function ticketSide(inp, n) {
    var r = inp.taxOn ? inp.taxRate / 100 : 0;
    var included = inp.taxMode === "included";

    // Face, tax and buyer-facing gross for one ticket at face price P.
    function face(P) {
      var faceNet = included ? P / (1 + r) : P;            // our share of the face, tax removed
      var tax = included ? P - faceNet : P * r;             // tax collected per ticket
      return { P: P, faceNet: faceNet, tax: tax, gross: P + (included ? 0 : tax) };
    }
    var on = face(inp.price);                                // online (advance) ticket
    var dr = face(inp.doorPriceOn ? inp.doorPrice : inp.price); // door ticket

    // Eventbrite (online only)
    var P = on.P;
    var ebProc = inp.ebProcPct / 100;
    var ebService = inp.ebServicePct / 100 * P + inp.ebServiceFixed;
    var onlineBuyerPer, ebProcPer;
    if (inp.ebMode === "pass") {
      onlineBuyerPer = (on.gross + ebService) / (1 - ebProc);
      ebProcPer = onlineBuyerPer * ebProc;
    } else {
      onlineBuyerPer = on.gross;
      ebProcPer = on.gross * ebProc;
    }
    var ebFeePer = ebService + ebProcPer;
    var ebAbsorbedPer = inp.ebMode === "absorb" ? ebFeePer : 0;
    var ebPassedPer = inp.ebMode === "pass" ? ebFeePer : 0;

    // Door
    var doorBuyerPer = dr.gross;
    var doorCardProcPer = inp.doorCardPct / 100 * doorBuyerPer + inp.doorCardFixed;

    // Counts (whole tickets)
    n = Math.max(0, Math.round(n));
    var online = Math.round(n * inp.onlinePct / 100);
    var door = n - online;
    var doorCash = Math.round(door * inp.doorCashPct / 100);
    var doorCard = door - doorCash;

    var faceNet = online * on.faceNet + door * dr.faceNet;
    var tax = online * on.tax + door * dr.tax;
    var grossFace = online * on.P + door * dr.P;
    var ebPassed = online * ebPassedPer;
    var ebAbsorbed = online * ebAbsorbedPer;
    var ebService_t = online * ebService;
    var ebProc_t = online * ebProcPer;
    var doorProc = doorCard * doorCardProcPer;

    var cutBasis;
    if (inp.doorCutBasis === "afterTax") cutBasis = faceNet;
    else if (inp.doorCutBasis === "afterTaxFees") cutBasis = faceNet - ebAbsorbed - doorProc;
    else cutBasis = online * on.gross + door * dr.gross;
    var doorCut = Math.max(0, cutBasis) * inp.doorCutPct / 100;

    var buyersPaid = online * onlineBuyerPer + door * doorBuyerPer;
    var netTicketRevenue = faceNet - ebAbsorbed - doorProc - doorCut;

    return {
      n: n,
      counts: { online: online, door: door, doorCash: doorCash, doorCard: doorCard },
      perTicket: {
        faceNet: on.faceNet, tax: on.tax, gross: on.gross,
        ebService: ebService, ebProc: ebProcPer, ebFee: ebFeePer,
        ebAbsorbed: ebAbsorbedPer, ebPassed: ebPassedPer,
        onlineBuyer: onlineBuyerPer,
        doorPrice: dr.P, doorFaceNet: dr.faceNet, doorTax: dr.tax, doorGross: dr.gross,
        doorBuyer: doorBuyerPer, doorCardProc: doorCardProcPer
      },
      grossFace: grossFace,
      faceNet: faceNet,
      tax: tax,
      ebService: ebService_t,
      ebProc: ebProc_t,
      ebPassed: ebPassed,
      ebAbsorbed: ebAbsorbed,
      ebTotal: ebPassed + ebAbsorbed,
      doorProc: doorProc,
      doorCutBasis: cutBasis,
      doorCut: doorCut,
      buyersPaid: buyersPaid,
      buyersPaidOnline: online * onlineBuyerPer,
      buyersPaidDoor: door * doorBuyerPer,
      netTicketRevenue: netTicketRevenue
    };
  }

  // Same scenario at a different ticket price. A separate door price keeps its
  // markup over the ticket price, so price sweeps move both together.
  function withPrice(inp, price) {
    var x = Object.assign({}, inp, { price: price });
    if (inp.doorPriceOn) x.doorPrice = Math.max(0, inp.doorPrice + price - inp.price);
    return x;
  }

  // Fixed (non-variable) cost lines. Guarantee is included; variable headliner parts are not.
  function fixedCosts(inp) {
    var lines = {
      headlinerGuarantee: inp.hlGuaranteeOn ? inp.hlGuarantee : 0,
      headlinerTravel: inp.hlTravel,
      headlinerHospitality: inp.hlHospitality,
      support: inp.supportSlots * inp.supportPrice,
      vj: inp.vjOn ? inp.vj : 0,
      security: inp.securityOn ? inp.security : 0,
      sound: inp.soundOn ? inp.sound : 0,
      gear: inp.gearOn ? inp.gear : 0,
      photo: inp.photo,
      venueRental: inp.venueRental,
      ads: inp.ads,
      poster: inp.poster,
      printing: inp.printing,
      ascap: inp.ascapOn ? inp.ascap : 0,
      bmi: inp.bmiOn ? inp.bmi : 0,
      insurance: inp.insuranceOn ? inp.insurance : 0,
      custom: inp.custom.reduce(function (s, r) { return s + (r.amount || 0); }, 0)
    };
    var base = 0;
    Object.keys(lines).forEach(function (k) { base += lines[k]; });
    var contingency = base * inp.contingencyPct / 100;
    return { lines: lines, base: base, contingency: contingency, total: base + contingency };
  }

  function basisValue(ts, basis) {
    if (basis === "grossFace") return ts.grossFace;
    if (basis === "net") return ts.netTicketRevenue;
    return ts.faceNet;
  }

  function thresholdFor(start, startN, hlBE) {
    if (start === "first") return 0;
    if (start === "afterN") return Math.max(0, startN);
    return hlBE === null ? Infinity : hlBE; // after break-even
  }

  // Net with the guarantee and every other cost, but no variable headliner parts.
  function baseNet(inp, n) {
    var ts = ticketSide(inp, n);
    return ts.netTicketRevenue + inp.otherIncome - fixedCosts(inp).total;
  }

  // First n where net >= 0 counting the guarantee and all other costs, but no
  // headliner %/per-ticket/backend parts. Scanned, never solved algebraically.
  function headlinerBreakEven(inp) {
    inp = sanitize(inp);
    var max = sellable(inp);
    for (var n = 0; n <= max; n++) if (baseNet(inp, n) >= -EPS) return n;
    return null;
  }

  function computeCore(inp, n, hlBE) {
    var ts = ticketSide(inp, n);
    var fc = fixedCosts(inp);
    n = ts.n;

    // Headliner variable parts
    var pctPart = 0, perTicketPart = 0, pctThreshold = 0, perTicketThreshold = 0;
    if (inp.hlPctOn) {
      pctThreshold = thresholdFor(inp.hlPctStart, inp.hlPctStartN, hlBE);
      if (n > pctThreshold) {
        var full = basisValue(ts, inp.hlPctBasis);
        var atT = pctThreshold > 0 ? basisValue(ticketSide(inp, pctThreshold), inp.hlPctBasis) : 0;
        pctPart = Math.max(0, full - atT) * inp.hlPct / 100;
      }
    }
    if (inp.hlPerTicketOn) {
      perTicketThreshold = thresholdFor(inp.hlPerTicketStart, inp.hlPerTicketStartN, hlBE);
      perTicketPart = Math.max(0, n - perTicketThreshold) * inp.hlPerTicket;
    }
    var guarantee = fc.lines.headlinerGuarantee;
    var variable = pctPart + perTicketPart;
    var dealPay, versusOverage = 0;
    if (inp.hlVersus) {
      dealPay = Math.max(guarantee, variable);
      versusOverage = dealPay - guarantee;
    } else {
      dealPay = guarantee + variable;
    }
    // Everything except the guarantee (already in fixed costs) that the deal adds
    var variableExtra = dealPay - guarantee;

    var netBeforeBackend = ts.netTicketRevenue + inp.otherIncome - fc.total - variableExtra;
    var backend = inp.hlBackendOn ? Math.max(0, netBeforeBackend) * inp.hlBackendPct / 100 : 0;
    var net = netBeforeBackend - backend;

    var headlinerPay = dealPay + backend;
    var headlinerTotal = headlinerPay + fc.lines.headlinerTravel + fc.lines.headlinerHospitality;
    var totalCosts = fc.total + variableExtra + backend;

    // "Where the money goes": everything buyers paid plus other income.
    var L = fc.lines;
    var money = {
      tax: ts.tax,
      ebFees: ts.ebTotal,
      doorProc: ts.doorProc,
      doorCut: ts.doorCut,
      headliner: headlinerTotal,
      supportVj: L.support + L.vj,
      production: L.sound + L.security + L.gear,
      marketing: L.ads + L.poster + L.printing,
      other: L.venueRental + L.ascap + L.bmi + L.insurance + L.photo + L.custom + fc.contingency,
      profit: Math.max(0, net),
      loss: Math.max(0, -net)
    };
    var inflow = ts.buyersPaid + inp.otherIncome;
    var perTicket = {}, perDollar = {};
    Object.keys(money).forEach(function (k) {
      perTicket[k] = n > 0 ? money[k] / n : 0;
      perDollar[k] = inflow > 0 ? money[k] / inflow : 0;
    });

    return {
      n: n,
      sellable: sellable(inp),
      counts: ts.counts,
      perTicketPrices: ts.perTicket,
      buyerPaysOnline: ts.perTicket.onlineBuyer,
      buyerPaysDoor: ts.perTicket.doorBuyer,
      grossFace: ts.grossFace,
      faceNet: ts.faceNet,
      tax: ts.tax,
      eventbrite: {
        service: ts.ebService, processing: ts.ebProc,
        passed: ts.ebPassed, absorbed: ts.ebAbsorbed, total: ts.ebTotal
      },
      doorProc: ts.doorProc,
      doorCutBasis: ts.doorCutBasis,
      doorCut: ts.doorCut,
      buyersPaid: ts.buyersPaid,
      buyersPaidOnline: ts.buyersPaidOnline,
      buyersPaidDoor: ts.buyersPaidDoor,
      netTicketRevenue: ts.netTicketRevenue,
      otherIncome: inp.otherIncome,
      costs: L,
      contingency: fc.contingency,
      contingencyBase: fc.base,
      fixedCostsTotal: fc.total,
      headliner: {
        guarantee: guarantee,
        pctPart: pctPart,
        perTicketPart: perTicketPart,
        versus: inp.hlVersus,
        versusOverage: versusOverage,
        dealPay: dealPay,
        backend: backend,
        pay: headlinerPay,
        travel: L.headlinerTravel,
        hospitality: L.headlinerHospitality,
        total: headlinerTotal,
        pctThreshold: pctThreshold,
        perTicketThreshold: perTicketThreshold,
        breakEven: hlBE
      },
      netBeforeBackend: netBeforeBackend,
      totalCosts: totalCosts,
      net: net,
      inflow: inflow,
      money: money,
      perTicket: perTicket,
      perDollar: perDollar
    };
  }

  function compute(inputs, ticketsSold, opts) {
    var inp = sanitize(inputs);
    var hlBE = opts && opts.hlBE !== undefined ? opts.hlBE : headlinerBreakEven(inp);
    var n = Math.min(sellable(inp), Math.max(0, Math.round(num(ticketsSold, 0))));
    return computeCore(inp, n, hlBE);
  }

  function sweep(inputs) {
    var inp = sanitize(inputs);
    var hlBE = headlinerBreakEven(inp);
    var out = [];
    for (var n = 0; n <= sellable(inp); n++) out.push({ n: n, net: computeCore(inp, n, hlBE).net });
    return out;
  }

  function breakEven(inputs) {
    var inp = sanitize(inputs);
    var hlBE = headlinerBreakEven(inp);
    for (var n = 0; n <= sellable(inp); n++) if (computeCore(inp, n, hlBE).net >= -EPS) return n;
    return null;
  }

  var PRICE_CAP_CENTS = 100000; // $1,000 search ceiling

  // Lowest ticket price (to the cent) at which net >= 0 with ticketsSold tickets.
  function breakEvenPrice(inputs, ticketsSold) {
    var inp = sanitize(inputs);
    var n = Math.min(sellable(inp), Math.max(0, Math.round(num(ticketsSold, 0))));
    function netAt(cents) {
      var x = withPrice(inp, cents / 100);
      return computeCore(x, n, headlinerBreakEven(x)).net;
    }
    if (netAt(0) >= -EPS) return 0;
    if (n === 0) return null;
    if (netAt(PRICE_CAP_CENTS) < -EPS) return null;
    var lo = 0, hi = PRICE_CAP_CENTS; // lo loses, hi breaks even
    while (hi - lo > 1) {
      var mid = Math.floor((lo + hi) / 2);
      if (netAt(mid) >= -EPS) hi = mid; else lo = mid;
    }
    // Guard against small non-monotonic wiggles: walk down while one cent less still works.
    while (hi > 0 && netAt(hi - 1) >= -EPS) hi--;
    return hi / 100;
  }

  return {
    DEFAULTS: DEFAULTS,
    ENUMS: ENUMS,
    PRESETS: PRESETS,
    sanitize: sanitize,
    sellable: sellable,
    expectedTickets: expectedTickets,
    detectPreset: detectPreset,
    compute: compute,
    sweep: sweep,
    breakEven: breakEven,
    headlinerBreakEven: headlinerBreakEven,
    breakEvenPrice: breakEvenPrice,
    withPrice: withPrice
  };
});
