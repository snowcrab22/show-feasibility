/* Show Feasibility: DOM wiring, charts, state, section routing. Depends on window.ShowModel (model.js). */
(function () {
  "use strict";
  var M = window.ShowModel;
  var STORE_KEY = "kcplur-show-feasibility-v1"; // same key and {v, inputs, n} shape as the first version
  var SECTION_KEY = "kcplur-show-feasibility-section";
  var SECTION_NAMES = ["overview", "tickets", "venue", "talent", "costs", "share"];
  var SVGNS = "http://www.w3.org/2000/svg";
  var MINUS = "−";

  var state = { inputs: M.sanitize(M.DEFAULTS), n: M.DEFAULT_N, nWant: M.DEFAULT_N };
  // nWant is the ticket count the user asked for; n is nWant clamped to the current sellable count.
  var last = null; // last computed bundle, for resize re-render and copy

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") e.textContent = v;
      else if (k === "className") e.className = v;
      else if (k === "dataset") Object.keys(v).forEach(function (d) { e.dataset[d] = v[d]; });
      else e.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function svg(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function parseNum(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }

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
  function signClass(v) { return v >= 0.5 ? "pos" : v <= -0.5 ? "neg" : ""; }
  function statusOf(net) { return Math.abs(net) < 0.5 ? "even" : net > 0 ? "profit" : "loss"; }
  var STATUS_LABEL = { profit: "Profit", loss: "Loss", even: "Break-even" };
  function priceText(v) { return fmt$(v, { cents: v % 1 !== 0 }); }

  // Platform name as typed, or a neutral fallback for sentences.
  function platName(inp) { var s = String((inp || state.inputs).ticketPlatform || "").trim(); return s || "the ticketing platform"; }
  function platLabel(inp) { var s = String((inp || state.inputs).ticketPlatform || "").trim(); return s || "Ticketing platform"; }
  // Label text may contain {P}; it becomes a span that recompute keeps set to the platform name.
  function labelNodes(text) {
    var parts = String(text).split("{P}"), out = [];
    parts.forEach(function (p, i) {
      if (i) out.push(el("span", { className: "plat-name" }));
      if (p) out.push(p);
    });
    return out;
  }

  // ---------------------------------------------------------------- input schema
  var BASIS_HL = [["grossFace", "Gross face (tickets x price)"], ["faceNet", "Face net of sales tax"], ["net", "Our net ticket revenue (after fees and venue's cut)"]];
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
      { k: "ebPreset", label: "Rates preset", type: "select", options: [["eventbrite", "Eventbrite (3.7% + $1.79, 2.9% processing)"], ["custom", "Custom"]],
        hint: "Picking a preset fills in the rates below. Editing a rate switches to Custom." },
      { k: "ticketPlatform", label: "Platform name", type: "text" },
      { k: "ebMode", label: "{P} fees", type: "select", options: [["pass", "Pass fees to buyer"], ["absorb", "Absorb fees (included in price)"]] },
      { pair: [
        { k: "ebServicePct", label: "Service fee", type: "pct", step: 0.1 },
        { k: "ebServiceFixed", label: "Plus per ticket", type: "money", step: 0.01 }
      ] },
      { k: "ebProcPct", label: "Payment processing", type: "pct", step: 0.1,
        note: "The Eventbrite preset uses its US rates as of Nov 2026. Rates change; check the platform's pricing page." }
    ] },
    { id: "g-venue", host: "in-venue", title: "Venue deal", hint: "Turn on each part the venue charges. The parts add up.", fields: [
      { k: "doorCutPct", toggle: "doorCutOn", label: "% of door (ticket sales)", type: "pct", step: 0.5 },
      { k: "doorCutBasis", label: "% of door is taken from", type: "select", dependsOn: "doorCutOn", options: [
        ["afterTax", "Ticket sales after sales tax, before ticketing fees"],
        ["afterTaxFees", "Ticket sales after tax and ticketing fees"],
        ["gross", "Gross face value incl. tax"]
      ], note: "Confirm with the venue what the percentage is taken from. Applies to online and door tickets." },
      { k: "venueRental", toggle: "venueRentalOn", label: "Flat rental / fee", type: "money" },
      { k: "venuePerHead", toggle: "venuePerHeadOn", label: "Per-head fee", type: "money", step: 0.25,
        hint: "Charged for each person in the room, comps included." }
    ] },
    { id: "g-hl", host: "in-talent", title: "Headliner deal", fields: [
      { k: "hlPreset", label: "Deal preset", type: "select", options: [
        ["flat", "Flat guarantee"], ["pct", "% of ticket sales"], ["perTicket", "$ per ticket"],
        ["flatBackend", "Flat + backend (% of profit after break-even)"],
        ["flatBonus", "Flat + bonus $/ticket after break-even"],
        ["versus", "Versus (greater of guarantee or %)"], ["custom", "Custom"]
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

  // Cost ledger groups (Costs section). Each row is an editable input; subtotals are filled by renderCosts.
  var LEDGER = [
    { id: "production", title: "Production", rows: [
      { k: "security", toggle: "securityOn", label: "Contracted security (flat)" },
      { k: "sound", toggle: "soundOn", label: "Sound rental" },
      { k: "gear", toggle: "gearOn", label: "Additional deck / gear" },
      { k: "photo", label: "Photo / video" }
    ] },
    { id: "marketing", title: "Marketing", rows: [
      { k: "ads", label: "Advertising budget" },
      { k: "poster", label: "Poster design" },
      { k: "printing", label: "Printing" }
    ] },
    { id: "licensing", title: "Licensing & insurance", rows: [
      { k: "ascap", toggle: "ascapOn", label: "PRO licensing: ASCAP" },
      { k: "bmi", toggle: "bmiOn", label: "PRO licensing: BMI", note: "Usually the venue's license; turn on if the venue requires promoter coverage." },
      { k: "insurance", toggle: "insuranceOn", label: "Event insurance", note: "Typical one-night event policy quote." }
    ] }
  ];

  var controls = {}; // key -> primary input element (mirrors share the key via data-k)
  var fieldRows = []; // { row, dependsOn, showIf }

  function unitWrap(input, type) {
    if (type === "money") return el("div", { className: "input-wrap pre" }, [el("span", { className: "unit", text: "$", "aria-hidden": "true" }), input]);
    if (type === "pct") return el("div", { className: "input-wrap post" }, [input, el("span", { className: "unit", text: "%", "aria-hidden": "true" })]);
    return el("div", { className: "input-wrap" }, [input]);
  }
  function makeInput(f) {
    var id = f.id || "f-" + f.k;
    var input;
    if (f.type === "select") {
      input = el("select", { id: id, dataset: { k: f.k } });
      f.options.forEach(function (o) { input.appendChild(el("option", { value: o[0], text: o[1] })); });
    } else if (f.type === "check") {
      input = el("input", { type: "checkbox", id: id, dataset: { k: f.k } });
    } else if (f.type === "text") {
      input = el("input", { type: "text", id: id, dataset: { k: f.k, kind: "text" }, autocomplete: "off", spellcheck: "false" });
    } else {
      input = el("input", {
        type: "number", id: id, dataset: { k: f.k }, min: "0",
        step: f.step || (f.type === "int" ? 1 : f.type === "pct" ? 0.1 : 1),
        inputmode: f.type === "int" ? "numeric" : "decimal"
      });
    }
    if (!f.mirror) controls[f.k] = input;
    return input;
  }
  function describe(input, f, row) {
    var ids = [], base = input.id;
    if (f.hint) { var h = el("p", { className: "hint", id: base + "-hint", text: f.hint }); row.appendChild(h); ids.push(h.id); }
    if (f.note) { var n = el("p", { className: "note", id: base + "-note", text: f.note }); row.appendChild(n); ids.push(n.id); }
    if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  }
  function buildField(f) {
    if (f.pair) {
      var wrap = el("div", { className: "field" });
      var grid = el("div", { className: "pair" });
      f.pair.forEach(function (p) {
        var inp = makeInput(p);
        grid.appendChild(el("div", { className: "field" }, [el("label", { "for": inp.id }, labelNodes(p.label)), unitWrap(inp, p.type)]));
      });
      wrap.appendChild(grid);
      if (f.hint) wrap.appendChild(el("p", { className: "hint", text: f.hint }));
      return wrap;
    }
    if (f.group) {
      var g = el("div", { className: "subgroup" });
      f.fields.forEach(function (sf) { g.appendChild(buildField(sf)); });
      return g;
    }
    if (f.type === "readout") {
      return el("div", { className: "field" }, [
        el("span", { className: "flabel", text: f.label }),
        el("span", { className: "num", id: f.id, style: "font-weight:600" })
      ]);
    }

    var row;
    if (f.type === "check") {
      var cb = makeInput(f);
      row = el("div", { className: "field" }, [el("label", { className: "check", "for": cb.id }, [cb].concat(labelNodes(f.label)))]);
      describe(cb, f, row);
    } else if (f.toggle) {
      var tg = makeInput({ k: f.toggle, type: "check" });
      var amt = makeInput(f);
      var amtLabel = el("label", { className: "sr-only", "for": amt.id, text: f.label + " amount" });
      row = el("div", { className: "field" }, [
        el("div", { className: "toggle-row" }, [
          el("label", { className: "check", "for": tg.id }, [tg].concat(labelNodes(f.label))),
          el("div", { className: "row-amount" }, [amtLabel, unitWrap(amt, f.type)])
        ])
      ]);
      describe(amt, f, row);
      fieldRows.push({ row: row, dependsOn: f.toggle });
    } else {
      var inp = makeInput(f);
      row = el("div", { className: "field" }, [el("label", { "for": inp.id }, labelNodes(f.label)), f.type === "select" ? inp : unitWrap(inp, f.type)]);
      describe(inp, f, row);
    }
    if (f.dependsOn || f.showIf) fieldRows.push({ row: row, dependsOn: f.dependsOn, showIf: f.showIf });
    return row;
  }

  function renderCustomRows() {
    var list = $("custom-list");
    list.textContent = "";
    state.inputs.custom.forEach(function (r, i) {
      var nameId = "custom-name-" + i, amtId = "custom-amount-" + i;
      var name = el("input", { type: "text", id: nameId, placeholder: "e.g. Fog machine", autocomplete: "off", dataset: { ci: i, cf: "name" } });
      name.value = r.name;
      var amt = el("input", { type: "number", id: amtId, min: "0", step: "1", inputmode: "decimal", dataset: { ci: i, cf: "amount" } });
      amt.value = r.amount;
      var rm = el("button", { type: "button", className: "small", id: "custom-remove-" + i, dataset: { remove: i }, "aria-label": "Remove cost line " + (i + 1), text: "Remove" });
      list.appendChild(el("div", { className: "custom-row" }, [
        el("label", { className: "sr-only", "for": nameId, text: "Cost line " + (i + 1) + " name" }), name,
        el("label", { className: "sr-only", "for": amtId, text: "Cost line " + (i + 1) + " amount" }), unitWrap(amt, "money"), rm
      ]));
    });
    // keep grid columns: the sr-only labels are absolutely positioned and take no cell
  }

  // ---------------------------------------------------------------- cost ledger
  function lrow(cls, kids) { return el("div", { className: "lrow" + (cls ? " " + cls : "") }, kids); }
  function lval(id, text) { return el("span", { className: "lval", id: id, text: text || "" }); }
  function lgroup(title, link, kids, subId, subLabel) {
    var head = el("div", { className: "lgroup-head" }, [el("h4", { text: title })]);
    if (link) head.appendChild(el("a", { href: "#" + link, text: "Edit in " + link.charAt(0).toUpperCase() + link.slice(1) }));
    var g = el("div", { className: "lgroup" }, [head].concat(kids));
    if (subId) g.appendChild(lrow("subtotal", [el("span", { text: subLabel || title + " subtotal" }), lval(subId)]));
    return g;
  }
  function ledgerInputRow(f) {
    var amt = makeInput({ k: f.k, type: "money" });
    var row;
    if (f.toggle) {
      var tg = makeInput({ k: f.toggle, type: "check" });
      row = lrow("", [
        el("label", { className: "check lname", "for": tg.id }, [tg, f.label]),
        el("div", {}, [el("label", { className: "sr-only", "for": amt.id, text: f.label + " amount" }), unitWrap(amt, "money")])
      ]);
      fieldRows.push({ row: row, dependsOn: f.toggle });
    } else {
      row = lrow("", [el("label", { className: "lname", "for": amt.id, text: f.label }), unitWrap(amt, "money")]);
    }
    if (f.note) {
      var n = el("p", { className: "note", id: amt.id + "-note", text: f.note });
      amt.setAttribute("aria-describedby", n.id);
      return el("div", { style: "display:grid;gap:4px" }, [row, n]);
    }
    return row;
  }
  function buildLedger() {
    var host = $("ledger");
    host.appendChild(lgroup("Talent", "talent", [
      lrow("sub", [el("span", { text: "Headliner pay" }), lval("led-hl-pay")]),
      lrow("sub", [el("span", { text: "Headliner travel / hotel and hospitality" }), lval("led-hl-extra")]),
      lrow("sub", [el("span", { id: "led-support-label", text: "Supporting artists" }), lval("led-support")]),
      lrow("sub", [el("span", { text: "VJ" }), lval("led-vj")])
    ], "led-talent"));
    host.appendChild(lgroup("Venue", "venue", [
      lrow("sub", [el("span", { text: "Flat rental / fee" }), lval("led-venue-rental")]),
      lrow("sub", [el("span", { id: "led-venue-taken-label", text: "% of door and per-head fee (already out of ticket revenue, not counted again)" }), lval("led-venue-taken")])
    ], "led-venue", "Venue: counted in total costs (rental)"));
    LEDGER.forEach(function (g) {
      host.appendChild(lgroup(g.title, null, g.rows.map(ledgerInputRow), "led-" + g.id));
    });
    host.appendChild(lgroup("Custom cost lines", null, [
      el("div", { className: "custom-list", id: "custom-list" }),
      el("div", {}, [el("button", { type: "button", className: "small", id: "btn-add-custom", text: "Add cost line" })])
    ], "led-custom"));

    var cp = makeInput({ k: "contingencyPct", type: "pct", step: 1 });
    var hint = el("p", { className: "hint", id: "f-contingencyPct-hint", text: "% of all other costs, not counting headliner %, per-ticket, versus or backend pay, the venue's % of door or the per-head fee." });
    cp.setAttribute("aria-describedby", hint.id);
    host.appendChild(el("div", { className: "lgroup" }, [
      lrow("contingency", [el("label", { "for": cp.id, className: "lname", text: "Contingency" }), unitWrap(cp, "pct"), lval("led-contingency")]),
      hint,
      lrow("total grand", [el("span", { text: "Total costs" }), lval("led-total")])
    ]));

    var oi = makeInput({ k: "otherIncome", type: "money" });
    host.appendChild(el("div", { className: "lsummary" }, [
      lrow("", [el("span", {}, [el("a", { href: "#tickets", text: "Net ticket revenue" }), " (after tax, fees and the venue's cut)"]), lval("led-nettix")]),
      lrow("", [el("label", { "for": oi.id, className: "lname", text: "Other income (merch, sponsor)" }), unitWrap(oi, "money")]),
      lrow("", [el("span", { text: "Minus total costs" }), lval("led-total-2")]),
      lrow("total grand", [el("span", { id: "led-net-label", text: "Net" }), lval("led-net")])
    ]));
  }

  function buildInputs() {
    SECTIONS.forEach(function (s) {
      var body = el("div", { className: "group-body" });
      if (s.hint) body.appendChild(el("p", { className: "hint", text: s.hint }));
      s.fields.forEach(function (f) { body.appendChild(buildField(f)); });
      $(s.host).appendChild(el("div", { className: "card group-card", id: s.id }, [el("h3", { text: s.title }), body]));
    });
    buildLedger();
    controls.price = $("f-price");
    controls.venueName = $("f-venueName");
    controls.showName = $("f-showName");
  }

  // Write state into every control, mirrors included (load, reset, preset). Never called on plain typing.
  function syncControls(skip) {
    document.querySelectorAll("[data-k]").forEach(function (c) {
      if (c === skip) return;
      var v = state.inputs[c.dataset.k];
      if (c.type === "checkbox") c.checked = !!v;
      else c.value = v;
    });
    renderCustomRows();
  }

  function applyVisibility() {
    var s = state.inputs;
    fieldRows.forEach(function (fr) {
      if (fr.dependsOn) fr.row.classList.toggle("is-off", !s[fr.dependsOn]);
      if (fr.showIf) fr.row.hidden = !fr.showIf(s);
    });
  }

  // ---------------------------------------------------------------- events
  var HL_TOGGLES = ["hlGuaranteeOn", "hlPctOn", "hlPerTicketOn", "hlBackendOn", "hlVersus", "hlPctStart", "hlPerTicketStart"];
  var PLATFORM_RATES = ["ebServicePct", "ebServiceFixed", "ebProcPct"];

  function onControl(e) {
    var t = e.target;
    if (t.dataset.ci !== undefined) {
      var i = +t.dataset.ci;
      if (!state.inputs.custom[i]) return;
      state.inputs.custom[i][t.dataset.cf] = t.dataset.cf === "name" ? t.value : Math.max(0, parseNum(t.value));
      recompute();
      return;
    }
    var k = t.dataset.k;
    if (!k) return;
    if (t.type === "checkbox") state.inputs[k] = t.checked;
    else if (t.tagName === "SELECT" || t.dataset.kind === "text") state.inputs[k] = t.value;
    else state.inputs[k] = Math.max(0, parseNum(t.value));
    // Keep any mirror of this key (ticket price lives in the bar and in Tickets & fees) in step.
    document.querySelectorAll('[data-k="' + k + '"]').forEach(function (c) {
      if (c === t) return;
      if (c.type === "checkbox") c.checked = t.checked; else c.value = t.value;
    });

    if (k === "hlPreset" && M.PRESETS[t.value]) {
      Object.assign(state.inputs, M.PRESETS[t.value]);
      syncControls(t);
    } else if (HL_TOGGLES.indexOf(k) >= 0) {
      state.inputs.hlPreset = M.detectPreset(state.inputs);
      controls.hlPreset.value = state.inputs.hlPreset;
    } else if (k === "ebPreset" && M.PLATFORM_PRESETS[t.value]) {
      Object.assign(state.inputs, M.PLATFORM_PRESETS[t.value]);
      syncControls(t);
    } else if (PLATFORM_RATES.indexOf(k) >= 0) {
      state.inputs.ebPreset = M.detectPlatform(state.inputs);
      controls.ebPreset.value = state.inputs.ebPreset;
    }
    recompute();
  }

  function setN(n) {
    var S = M.sellable(M.sanitize(state.inputs));
    state.nWant = clamp(Math.round(n), 0, S);
    recompute();
  }

  // ---------------------------------------------------------------- sections (plain location.hash names)
  var current = null;
  function sectionFromHash() {
    var h = (location.hash || "").replace(/^#/, "");
    return SECTION_NAMES.indexOf(h) >= 0 ? h : null;
  }
  function showSection(name, opts) {
    opts = opts || {};
    if (SECTION_NAMES.indexOf(name) < 0) name = "overview";
    var changed = current !== name;
    current = name;
    SECTION_NAMES.forEach(function (s) { $("sec-" + s).hidden = s !== name; });
    document.querySelectorAll(".secnav a").forEach(function (a) {
      if (a.dataset.sec === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    var navA = document.querySelector('.secnav a[data-sec="' + name + '"]');
    if (navA && navA.scrollIntoView && window.matchMedia("(max-width: 900px)").matches) {
      try { navA.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* old browsers */ }
    }
    try { localStorage.setItem(SECTION_KEY, name); } catch (e) { /* storage unavailable */ }
    hideTip();
    if (name === "overview" && last) { renderChart(last); renderMoneyBar(last.r); }
    // If the page is scrolled past the nav, bring the top of the new section under the sticky bar.
    if (changed && !opts.initial) {
      var nav = $("secnav"), covered = $("verdict").offsetHeight;
      if (getComputedStyle(nav).position === "sticky") covered += nav.offsetHeight;
      var target = $("sec-" + name).getBoundingClientRect().top + window.scrollY - covered - 12;
      if (window.scrollY > target) window.scrollTo(0, Math.max(0, target));
    }
  }
  function initSections() {
    var name = sectionFromHash();
    if (!name) {
      try { name = localStorage.getItem(SECTION_KEY); } catch (e) { name = null; }
      if (SECTION_NAMES.indexOf(name) < 0) name = "overview";
      try { history.replaceState(null, "", "#" + name); } catch (e) { /* file:// or old browsers */ }
    }
    showSection(name, { initial: true });
    window.addEventListener("hashchange", function () { showSection(sectionFromHash() || "overview"); });
  }
  // The secnav sits under the verdict bar on desktop; keep its sticky offset equal to the bar's height.
  function trackVerdictHeight() {
    function set() { document.documentElement.style.setProperty("--verdict-h", $("verdict").offsetHeight + "px"); }
    set();
    if (window.ResizeObserver) new ResizeObserver(set).observe($("verdict"));
    else window.addEventListener("resize", set);
  }

  function wire() {
    document.addEventListener("input", function (e) {
      if (e.target.id === "n-slider" || e.target.id === "n-input") {
        state.nWant = Math.round(parseNum(e.target.value));
        recompute(e.target);
        return;
      }
      if (e.target.dataset && (e.target.dataset.k || e.target.dataset.ci !== undefined)) onControl(e);
    });
    document.addEventListener("change", function (e) {
      if (e.target.tagName === "SELECT" || e.target.type === "checkbox") return; // handled on input
      if (e.target.id === "n-input") { state.nWant = state.n; recompute(); } // normalize the typed value on commit
    });
    document.querySelectorAll(".quick button").forEach(function (b) {
      b.addEventListener("click", function () {
        var S = M.sellable(M.sanitize(state.inputs));
        setN(S * (+b.dataset.q) / 100);
      });
    });
    $("ledger").addEventListener("click", function (e) {
      var t = e.target;
      if (t.id === "btn-add-custom") {
        state.inputs.custom.push({ name: "", amount: 0 });
        renderCustomRows();
        var i = state.inputs.custom.length - 1;
        $("custom-name-" + i).focus();
        recompute();
      } else if (t.dataset && t.dataset.remove !== undefined) {
        var idx = +t.dataset.remove;
        state.inputs.custom.splice(idx, 1);
        renderCustomRows();
        var next = $("custom-name-" + Math.min(idx, state.inputs.custom.length - 1)) || $("btn-add-custom");
        next.focus();
        recompute();
      }
    });
    $("btn-copy-summary").addEventListener("click", function () { copyText(summaryText(), "Summary copied. Paste it in Discord or a text."); });
    $("btn-copy-code").addEventListener("click", function () { copyText(encodeScenario(), "Scenario code copied. Whoever loads it sees this exact scenario."); });
    $("btn-load").addEventListener("click", loadFromBox);
    var armed = null;
    $("btn-reset").addEventListener("click", function () {
      var b = $("btn-reset");
      if (!armed) {
        b.textContent = "Click again to reset everything";
        b.classList.add("danger-armed");
        armed = setTimeout(function () { armed = null; b.textContent = "Reset to defaults"; b.classList.remove("danger-armed"); }, 4000);
        return;
      }
      clearTimeout(armed); armed = null;
      b.textContent = "Reset to defaults"; b.classList.remove("danger-armed");
      state.inputs = M.sanitize(M.DEFAULTS);
      state.nWant = state.n = Math.min(M.DEFAULT_N, M.sellable(state.inputs));
      syncControls();
      recompute();
      showMsg("Reset to the default scenario.", "ok");
    });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { if (last && current === "overview") { renderChart(last); renderMoneyBar(last.r); } });
      ro.observe($("chart-wrap"));
    } else {
      window.addEventListener("resize", function () { if (last && current === "overview") { renderChart(last); renderMoneyBar(last.r); } });
    }
    window.addEventListener("scroll", hideTip, { passive: true });
  }

  // ---------------------------------------------------------------- share
  function showMsg(text, kind) {
    var m = $("share-msg");
    m.textContent = text;
    m.className = "msg" + (kind ? " " + kind : "");
  }
  function copyText(text, okMsg) {
    var fb = $("copy-fallback"), ta = $("copy-fallback-text");
    function fallback() {
      fb.hidden = false;
      ta.value = text;
      ta.focus();
      ta.select();
      showMsg("Your browser blocked copying. The text is selected below; copy it with Ctrl+C or Cmd+C.", "err");
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { fb.hidden = true; showMsg(okMsg, "ok"); }, fallback);
      } else fallback();
    } catch (err) { fallback(); }
  }
  function b64encodeUtf8(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // Same {v: 1, inputs, n} shape as the first version, so old and new codes load in both directions
  // (an older page simply ignores the keys it does not know).
  function encodeScenario() {
    return b64encodeUtf8(JSON.stringify({ v: 1, inputs: M.sanitize(state.inputs), n: state.n }));
  }
  function applyScenario(obj) {
    if (!obj || typeof obj !== "object" || !obj.inputs || typeof obj.inputs !== "object") throw new Error("shape");
    state.inputs = M.sanitize(obj.inputs);
    var S = M.sellable(state.inputs);
    var n = parseNum(obj.n);
    state.nWant = state.n = clamp(Math.round(isFinite(n) ? n : M.expectedTickets(state.inputs)), 0, S);
  }
  function loadFromBox() {
    var raw = $("load-code").value.replace(/\s+/g, "");
    if (!raw) { showMsg("Paste a scenario code into the box first.", "err"); return; }
    try {
      applyScenario(JSON.parse(b64decodeUtf8(raw)));
    } catch (err) {
      showMsg("That code didn't load. Check that you copied the whole code, with nothing extra.", "err");
      return;
    }
    syncControls();
    recompute();
    showMsg("Scenario loaded.", "ok");
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, inputs: state.inputs, n: state.nWant })); } catch (e) { /* storage unavailable */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) applyScenario(JSON.parse(raw));
    } catch (e) { /* ignore bad or missing storage */ }
  }

  function venueDescription(inp, ascii) {
    var parts = [];
    if (inp.doorCutOn) parts.push(inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis]);
    if (inp.venueRentalOn) parts.push(fmt$(inp.venueRental, { ascii: ascii }) + " rental");
    if (inp.venuePerHeadOn) parts.push(fmt$(inp.venuePerHead, { cents: inp.venuePerHead % 1 !== 0 }) + " per head");
    return parts.join(" + ") || "nothing";
  }
  function summaryText() {
    if (!last) return "";
    var b = last, inp = b.inp, r = b.r, S = r.sellable;
    var A = { ascii: true };
    var lines = [];
    var show = String(inp.showName || "").trim(), venue = String(inp.venueName || "").trim() || "New venue";
    lines.push("Show Feasibility - " + (show ? show + " at " : "") + venue);
    lines.push(r.n + " of " + S + " sellable tickets at " + priceText(inp.price) +
      (inp.doorPriceOn ? " (" + priceText(inp.doorPrice) + " at the door)" : "") +
      " (" + inp.comps + " comps, cap " + inp.capacity + ")");
    lines.push("Net: " + fmt$(r.net, A) + " (" + STATUS_LABEL[statusOf(r.net)].toLowerCase() + ")");
    lines.push("Break-even: " + (b.be === null ? "can't break even at this price, even sold out" : b.be + " tickets (" + fmtPct(b.be / Math.max(1, S)) + " of sellable)"));
    lines.push("Break-even price at " + r.n + " sold: " + (b.bePrice === null ? "none" : fmt$(b.bePrice, { cents: true })));
    lines.push("Headliner: " + fmt$(r.headliner.pay, A) + " (" + hlDescription(inp) + ")");
    lines.push("Venue takes: " + fmt$(r.venue.total, A) + " (" + venueDescription(inp, true) + ")");
    lines.push("Buyer pays: " + fmt$(r.buyerPaysOnline, { cents: true }) + " online, " + fmt$(r.buyerPaysDoor, { cents: true }) + " at the door");
    lines.push("Net ticket revenue " + fmt$(r.netTicketRevenue, A) + " | Total costs " + fmt$(r.totalCosts, A) + (r.otherIncome ? " | Other income " + fmt$(r.otherIncome, A) : ""));
    lines.push("At this price: " + b.scen.map(function (s) { return s.pct + "% (" + s.r.n + ") " + fmt$(s.r.net, A); }).join(" | "));
    lines.push("Assumes: " + (inp.taxOn ? "sales tax " + inp.taxRate + "% " + (inp.taxMode === "included" ? "included" : "on top") : "no sales tax") +
      "; " + platLabel(inp) + " fees " + (inp.ebMode === "pass" ? "passed to buyer" : "absorbed") +
      "; " + inp.onlinePct + "% online");
    return lines.join("\n");
  }
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

  // ---------------------------------------------------------------- tooltip
  var tip = null;
  function showTip(rows, x, y) {
    tip = tip || $("tip");
    tip.textContent = "";
    rows.forEach(function (r) {
      var row = el("div", { className: "row" });
      if (r.key) row.appendChild(el("span", { className: "key", style: "background:" + r.key }));
      row.appendChild(el("span", { className: r.strong ? "tv" : "tl", text: r.text }));
      tip.appendChild(row);
    });
    tip.style.display = "block";
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 14, top = y - h - 12;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 16;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = top + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; }
  function tipAtElement(elm, rows) {
    var rc = elm.getBoundingClientRect();
    showTip(rows, rc.left + rc.width / 2, rc.top);
  }

  // ---------------------------------------------------------------- recompute
  function recompute(fromLever) {
    var inp = M.sanitize(state.inputs);
    var S = M.sellable(inp);
    state.n = clamp(Math.round(state.nWant) || 0, 0, S);
    var hlBE = M.headlinerBreakEven(inp);
    var r = M.compute(inp, state.n, { hlBE: hlBE });
    var be = M.breakEven(inp);
    var bePrice = M.breakEvenPrice(inp, state.n);
    var sw = M.sweep(inp);
    var scen = [25, 50, 75, 90, 100].map(function (p) {
      return { pct: p, r: M.compute(inp, Math.round(S * p / 100), { hlBE: hlBE }) };
    });
    var soldOut = M.compute(inp, S, { hlBE: hlBE });
    last = { inp: inp, r: r, be: be, hlBE: hlBE, bePrice: bePrice, sw: sw, scen: scen, S: S, soldOut: soldOut };

    var slider = $("n-slider"), nIn = $("n-input");
    slider.max = S;
    if (fromLever !== slider) slider.value = state.n;
    if (fromLever !== nIn) nIn.value = state.n;
    nIn.max = S;
    slider.setAttribute("aria-valuetext", state.n + " tickets, " + fmtPct(state.n / Math.max(1, S)) + " of sellable");
    $("n-context").textContent = state.n + " tickets: " + fmtPct(state.n / Math.max(1, S)) + " of " + S + " sellable, " + (state.n + inp.comps) + " in the room with comps";
    $("sellable-readout").textContent = S + " (capacity " + inp.capacity + " minus " + inp.comps + " comps)";
    document.querySelectorAll(".quick button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(Math.round(S * (+b.dataset.q) / 100) === state.n));
    });
    var pn = platLabel(inp);
    document.querySelectorAll(".plat-name").forEach(function (s) { s.textContent = pn; });

    applyVisibility();
    renderVerdict(last);
    renderTiles(last);
    if (current === "overview" || !current) { renderChart(last); }
    renderMoney(r);
    renderHeatmap(inp);
    renderScenarios(last);
    renderHeadliner(last);
    renderTalent(last);
    renderVenue(last);
    renderPerTicket(r, inp);
    renderTicketMoney(r, inp);
    renderCosts(r, inp);
    renderNotes(inp, last);
    renderSummaries(last);
    save();
  }

  // ---------------------------------------------------------------- verdict bar and section summaries
  function renderVerdict(b) {
    var r = b.r, st = statusOf(r.net);
    var v = $("v-net");
    v.textContent = fmt$(r.net, { plus: true });
    v.className = "v-value num" + (st === "loss" ? " loss" : "");
    var nl = $("v-net-label");
    nl.textContent = "Net";
    nl.appendChild(el("span", { className: "v-wide", text: " at " + r.n }));
    var p = $("v-pill");
    p.dataset.status = st;
    p.textContent = STATUS_LABEL[st];
    var bev = $("v-be");
    bev.textContent = b.be === null ? "None" : String(b.be);
    if (b.be !== null) bev.appendChild(el("span", { className: "v-wide", text: " tickets" }));
    bev.title = b.be === null ? "Can't break even at this price, even sold out" : b.be + " tickets";
  }
  function talentTotal(r) { return r.headliner.total + r.costs.support + r.costs.vj; }
  function setNav(name, text, cls) {
    var n = $("nav-num-" + name);
    n.textContent = text;
    n.className = "nav-num" + (cls ? " " + cls : "");
  }
  function renderSummaries(b) {
    var r = b.r, inp = b.inp, n = r.n;
    $("sum-overview").textContent = "Net " + fmt$(r.net, { plus: true }) + " at " + n + " tickets; " +
      (b.be === null ? "can't break even at this price, even sold out." : "break-even at " + b.be + " of " + b.S + " tickets.");
    setNav("overview", fmt$(r.net, { plus: true }), r.net <= -0.5 ? "neg" : "");
    $("sum-tickets").textContent = n + " of " + b.S + " sellable at " + priceText(inp.price) + "; buyer pays " +
      fmt$(r.buyerPaysOnline, { cents: true }) + " online, " + fmt$(r.buyerPaysDoor, { cents: true }) + " at the door; we keep " + fmt$(r.netTicketRevenue) + ".";
    setNav("tickets", fmt$(r.netTicketRevenue) + " kept");
    $("sum-venue").textContent = "Venue takes " + fmt$(r.venue.total) + " at " + n + " tickets (" + fmt$(b.soldOut.venue.total) + " sold out): " + venueDescription(inp) + ".";
    setNav("venue", fmt$(r.venue.total));
    $("sum-talent").textContent = "Talent costs " + fmt$(talentTotal(r)) + " at " + n + " tickets; headliner pay " + fmt$(r.headliner.pay) + ".";
    setNav("talent", fmt$(talentTotal(r)));
    $("sum-costs").textContent = "Total costs " + fmt$(r.totalCosts) + " at " + n + " tickets; net " + fmt$(r.net, { plus: true }) + ".";
    setNav("costs", fmt$(r.totalCosts));
    $("sum-share").textContent = "Copy a plain-text summary or a scenario code, load a code, or reset.";
  }

  // ---------------------------------------------------------------- tiles
  function tile(label, value, sub, opts) {
    opts = opts || {};
    var t = el("div", { className: "tile" + (opts.hero ? " hero" : ""), dataset: opts.status ? { status: opts.status } : null });
    t.appendChild(el("span", { className: "tile-label", text: label }));
    if (opts.pill) t.appendChild(el("span", { className: "pill", dataset: { status: opts.status }, text: opts.pill }));
    t.appendChild(el("span", { className: "tile-value" + (opts.valueClass ? " " + opts.valueClass : ""), text: value }));
    if (sub) t.appendChild(el("span", { className: "tile-sub", text: sub }));
    return t;
  }
  function renderTiles(b) {
    var r = b.r, S = b.S, host = $("tiles");
    host.textContent = "";
    var st = statusOf(r.net);
    host.appendChild(tile("Net at " + r.n + " tickets", fmt$(r.net), "Net ticket revenue " + fmt$(r.netTicketRevenue) + " minus costs " + fmt$(r.totalCosts) + (r.otherIncome ? " plus other income " + fmt$(r.otherIncome) : ""),
      { hero: true, status: st, pill: STATUS_LABEL[st], valueClass: st === "loss" ? "loss" : "" }));
    if (b.be === null) host.appendChild(tile("Show break-even", "Not possible", "Can't break even at this price, even sold out"));
    else host.appendChild(tile("Show break-even", b.be + " tickets", fmtPct(b.be / Math.max(1, S)) + " of " + S + " sellable" + (b.be > r.n ? ", " + (b.be - r.n) + " more than now" : "")));
    var bp = b.bePrice;
    host.appendChild(tile("Break-even price at " + r.n + " sold", bp === null ? "None" : fmt$(bp, { cents: true }),
      bp === null ? (r.n === 0 ? "No price works with 0 tickets sold" : "Even $1,000 a ticket loses") : (bp <= b.inp.price ? "At or under your " + priceText(b.inp.price) + " price" : fmt$(bp - b.inp.price, { cents: true }) + " above your price")));
    var h = r.headliner;
    var hsub = [];
    if (h.versus) {
      hsub.push("greater of guarantee " + fmt$(h.guarantee) + " or " + fmt$(h.pctPart + h.perTicketPart) + " in % and per-ticket");
    } else {
      if (h.guarantee) hsub.push("guarantee " + fmt$(h.guarantee));
      if (h.pctPart) hsub.push("% part " + fmt$(h.pctPart));
      if (h.perTicketPart) hsub.push("per ticket " + fmt$(h.perTicketPart));
    }
    if (h.backend) hsub.push("backend " + fmt$(h.backend));
    host.appendChild(tile("Headliner payout", fmt$(h.pay), (h.versus ? "Versus: " : "") + (hsub.join(", ") || "nothing owed at this count")));
    host.appendChild(tile("Buyer pays at checkout (online)", fmt$(r.buyerPaysOnline, { cents: true }), "Door " + fmt$(r.buyerPaysDoor, { cents: true }) + "; " + platLabel(b.inp) + " fees " + (b.inp.ebMode === "pass" ? "passed to buyer" : "absorbed by us")));
  }

  // ---------------------------------------------------------------- line chart
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function yTickLabel(v, maxAbs) {
    if (Math.abs(v) < 0.5) return "$0";
    return maxAbs >= 10000 ? fmtCompact(v) : fmt$(v);
  }
  var chartHover = null;
  function renderChart(b) {
    var wrap = $("chart-wrap");
    var W = Math.max(280, wrap.clientWidth || 640), H = W < 480 ? 240 : 290;
    var m = { l: W < 480 ? 52 : 64, r: 16, t: 30, b: 44 };
    var S = Math.max(1, b.S), sw = b.sw;
    var nets = sw.map(function (p) { return p.net; });
    var lo = Math.min(0, Math.min.apply(null, nets)), hi = Math.max(0, Math.max.apply(null, nets));
    if (hi - lo < 1) { hi += 50; lo -= 50; }
    var step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var maxAbs = Math.max(Math.abs(lo), Math.abs(hi));
    function X(n) { return m.l + n / S * (W - m.l - m.r); }
    function Y(v) { return m.t + (hi - v) / (hi - lo) * (H - m.t - m.b); }

    var root = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, tabindex: "0", role: "img",
      "aria-label": "Line chart of net profit for every ticket count from 0 to " + b.S + ". " +
        (b.be === null ? "The show does not break even at this price." : "Break-even at " + b.be + " tickets.") +
        " At " + b.r.n + " tickets, net is " + fmt$(b.r.net) + ". Use arrow keys to inspect." });
    var ax = svg("g", { "class": "ax" });
    for (var v = lo; v <= hi + step / 2; v += step) {
      var y = Y(v);
      if (Math.abs(v) > step / 1000) ax.appendChild(svg("line", { "class": "gridline", x1: m.l, x2: W - m.r, y1: y, y2: y }));
      ax.appendChild(svg("text", { x: m.l - 8, y: y + 4, "text-anchor": "end" }, yTickLabel(v, maxAbs)));
    }
    var xs = niceStep(S / (W < 480 ? 4 : 7));
    for (var n = 0; n <= S; n += xs) {
      ax.appendChild(svg("text", { x: X(n), y: H - m.b + 18, "text-anchor": "middle" }, String(Math.round(n))));
    }
    if (S % xs !== 0 && X(S) - X(Math.floor(S / xs) * xs) > 28) ax.appendChild(svg("text", { x: X(S), y: H - m.b + 18, "text-anchor": "middle" }, String(S)));
    ax.appendChild(svg("text", { x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle" }, "Tickets sold"));
    ax.appendChild(svg("text", { x: m.l - (W < 480 ? 46 : 58), y: 14, "text-anchor": "start" }, "Net profit"));
    root.appendChild(ax);
    root.appendChild(svg("line", { "class": "zeroline", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }));

    var d = sw.map(function (p, i) { return (i ? "L" : "M") + X(p.n).toFixed(1) + " " + Y(p.net).toFixed(1); }).join(" ");
    root.appendChild(svg("path", { "class": "series", d: d }));

    if (b.be !== null) {
      var bx = X(b.be);
      root.appendChild(svg("line", { "class": "be-line", x1: bx, x2: bx, y1: m.t - 6, y2: H - m.b }));
      var anchor = bx > W - 120 ? "end" : bx < m.l + 60 ? "start" : "middle";
      root.appendChild(svg("text", { "class": "chart-label", x: bx + (anchor === "end" ? -4 : anchor === "start" ? 4 : 0), y: m.t - 10, "text-anchor": anchor }, "Break-even " + b.be));
    }
    var cn = b.r.n, cx = X(cn), cy = Y(b.r.net);
    root.appendChild(svg("circle", { "class": "marker", cx: cx, cy: cy, r: 5 }));
    var lab = cn + " sold: " + fmt$(b.r.net);
    var la = cx > W - 140 ? "end" : "start";
    var ly = cy + (b.r.net >= 0 ? 20 : -12);
    if (ly < m.t + 10) ly = cy + 20;
    if (ly > H - m.b - 4) ly = cy - 12;
    root.appendChild(svg("text", { "class": "chart-label strong", x: cx + (la === "end" ? -10 : 10), y: ly, "text-anchor": la }, lab));

    var cross = svg("g", { style: "display:none" });
    var cl = svg("line", { "class": "cross", y1: m.t, y2: H - m.b });
    var cd = svg("circle", { "class": "marker", r: 4.5 });
    cross.appendChild(cl); cross.appendChild(cd);
    root.appendChild(cross);
    var hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent", style: "cursor:crosshair" });
    root.appendChild(hit);

    function showAt(n, clientX, clientY) {
      n = clamp(n, 0, b.S);
      chartHover = n;
      var p = sw[n];
      cross.style.display = "";
      cl.setAttribute("x1", X(n)); cl.setAttribute("x2", X(n));
      cd.setAttribute("cx", X(n)); cd.setAttribute("cy", Y(p.net));
      var rows = [
        { text: fmt$(p.net), strong: true, key: "var(--s1)" },
        { text: n + " tickets (" + fmtPct(n / S) + " of sellable)" }
      ];
      if (clientX === undefined) {
        var rc = root.getBoundingClientRect(), sc = rc.width / W;
        clientX = rc.left + X(n) * sc; clientY = rc.top + Y(p.net) * sc;
      }
      showTip(rows, clientX, clientY);
    }
    function nFromEvent(e) {
      var rc = root.getBoundingClientRect();
      var x = (e.clientX - rc.left) * (W / rc.width);
      return Math.round((x - m.l) / (W - m.l - m.r) * S);
    }
    hit.addEventListener("pointermove", function (e) { showAt(nFromEvent(e), e.clientX, e.clientY); });
    hit.addEventListener("pointerleave", function () { cross.style.display = "none"; hideTip(); chartHover = null; });
    hit.addEventListener("click", function (e) { setN(clamp(nFromEvent(e), 0, b.S)); });
    root.addEventListener("keydown", function (e) {
      var cur = chartHover === null ? b.r.n : chartHover;
      var stepK = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); showAt(cur + stepK); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); showAt(cur - stepK); }
      else if (e.key === "Home") { e.preventDefault(); showAt(0); }
      else if (e.key === "End") { e.preventDefault(); showAt(b.S); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); var keep = cur; setN(keep); var s2 = wrap.querySelector("svg"); if (s2) s2.focus(); }
      else if (e.key === "Escape") { cross.style.display = "none"; hideTip(); chartHover = null; }
    });
    root.addEventListener("blur", function () { cross.style.display = "none"; hideTip(); chartHover = null; });

    var hadFocus = document.activeElement && wrap.contains(document.activeElement);
    wrap.textContent = "";
    wrap.appendChild(root);
    if (hadFocus) root.focus({ preventScroll: true });
    $("chart-sub").textContent = b.be === null ? "Can't break even at this price, even sold out" : "Break-even at " + b.be + " of " + b.S + " tickets";
  }

  // ---------------------------------------------------------------- money
  var CATS = [
    { k: "tax", label: "Sales tax (to the state)", color: "var(--seg-tax)", text: "var(--seg-tax-text)" },
    { k: "ebFees", label: "Ticketing platform fees", platform: true, color: "var(--s1)" },
    { k: "doorProc", label: "Door card processing", color: "var(--s2)" },
    { k: "venue", label: "Venue (% of door, rental, per-head)", color: "var(--s3)" },
    { k: "headliner", label: "Headliner (pay, travel, rider)", color: "var(--s4)", text: "#0b0b0b" },
    { k: "supportVj", label: "Support + VJ", color: "var(--s5)" },
    { k: "production", label: "Production (sound, security, gear)", color: "var(--s6)" },
    { k: "marketing", label: "Marketing", color: "var(--s7)" },
    { k: "other", label: "Other costs and contingency", color: "var(--s8)" },
    { k: "profit", label: "Profit (ours)", color: "var(--seg-profit)", text: "var(--seg-profit-text)" }
  ];
  function catLabel(c) { return c.platform ? platLabel() + " fees" : c.label; }
  function renderMoney(r) {
    var inflow = r.inflow, loss = r.money.loss;
    $("money-sub").textContent = "At " + r.n + " tickets: buyers paid " + fmt$(r.buyersPaid) + (r.otherIncome ? " plus " + fmt$(r.otherIncome) + " other income" : "");
    renderMoneyBar(r);
    var lg = $("money-legend");
    lg.textContent = "";
    CATS.forEach(function (c) {
      if (c.k === "profit" && loss > 0) return;
      lg.appendChild(el("span", {}, [el("i", { style: "background:" + c.color }), catLabel(c)]));
    });
    var sf = $("money-shortfall");
    if (loss > 0.005) {
      sf.hidden = false;
      sf.textContent = "Shortfall " + fmt$(loss) + ": costs and pass-throughs exceed the " + fmt$(inflow) + " coming in. The marked line shows where the money runs out.";
    } else sf.hidden = true;

    var tb = $("money-table").tBodies[0];
    tb.textContent = "";
    var whole = inflow + loss;
    CATS.forEach(function (c) {
      if (c.k === "profit" && loss > 0) return;
      var v = r.money[c.k];
      tb.appendChild(el("tr", {}, [
        el("td", {}, [el("span", { className: "sw", style: "background:" + c.color, "aria-hidden": "true" }), catLabel(c)]),
        el("td", { className: "n", text: fmt$(v, { cents: true }) }),
        el("td", { className: "n", text: whole > 0 ? fmtPct(v / whole, 1) : "0%" }),
        el("td", { className: "n", text: fmt$(r.perTicket[c.k], { cents: true }) })
      ]));
    });
    if (loss > 0.005) {
      tb.appendChild(el("tr", {}, [
        el("td", { className: "neg", text: "Loss (costs not covered)" }),
        el("td", { className: "n neg", text: MINUS + fmt$(loss, { cents: true }) }),
        el("td", { className: "n neg", text: whole > 0 ? fmtPct(loss / whole, 1) : "0%" }),
        el("td", { className: "n neg", text: MINUS + fmt$(r.perTicket.loss, { cents: true }) })
      ]));
    }
    tb.appendChild(el("tr", { className: "total" }, [
      el("td", { text: "Buyers paid" + (r.otherIncome ? " + other income" : "") }),
      el("td", { className: "n", text: fmt$(inflow, { cents: true }) }),
      el("td", { className: "n", text: "" }),
      el("td", { className: "n", text: r.n ? fmt$(inflow / r.n, { cents: true }) : fmt$(0, { cents: true }) })
    ]));
  }
  function renderMoneyBar(r) {
    var wrapEl = $("money-bar-wrap");
    wrapEl.textContent = "";
    var loss = r.money.loss, inflow = r.inflow;
    var parts = CATS.filter(function (c) { return !(c.k === "profit" && loss > 0); })
      .map(function (c) { return { c: c, v: r.money[c.k] }; })
      .filter(function (p) { return p.v > 0.005; });
    var whole = parts.reduce(function (s, p) { return s + p.v; }, 0);
    var bar = el("div", { className: "segbar", role: "group", "aria-label": "Where the money goes at " + r.n + " tickets" });
    wrapEl.appendChild(bar);
    if (whole <= 0) {
      bar.appendChild(el("div", { className: "seg", style: "flex:1;background:var(--grid)", text: "" }));
      return;
    }
    var W = bar.clientWidth || 600;
    var gaps = Math.max(0, parts.length - 1) * 2;
    var markPos = loss > 0.005 ? inflow / whole : -1, cum = 0;
    parts.forEach(function (p) {
      var share = p.v / whole;
      var underMark = markPos > cum && markPos < cum + share;
      cum += share;
      var px = share * (W - gaps);
      var lbl = fmtPct(p.v / whole);
      var fits = !underMark && px >= lbl.length * 7.5 + 12;
      var seg = el("div", {
        className: "seg", tabindex: "0", role: "img",
        "aria-label": catLabel(p.c) + ": " + fmt$(p.v, { cents: true }) + ", " + fmtPct(share, 1),
        style: "flex:" + share + " 1 0;background:" + p.c.color + ";color:" + (p.c.text || "#ffffff"),
        text: fits ? lbl : ""
      });
      var rows = [{ text: fmt$(p.v, { cents: true }), strong: true }, { text: catLabel(p.c) + ", " + fmtPct(share, 1) }];
      seg.addEventListener("pointermove", function (e) { showTip(rows, e.clientX, e.clientY); });
      seg.addEventListener("pointerleave", hideTip);
      seg.addEventListener("focus", function () { tipAtElement(seg, rows); });
      seg.addEventListener("blur", hideTip);
      bar.appendChild(seg);
    });
    if (loss > 0.005) {
      var pos = inflow / whole;
      var mark = el("div", { className: "inflow-mark" + (pos > 0.6 ? " flip" : ""), style: "left:" + (pos * 100).toFixed(2) + "%", "aria-hidden": "true" },
        [el("span", { text: "Money in " + fmt$(inflow) })]);
      wrapEl.appendChild(mark);
    }
  }

  // ---------------------------------------------------------------- heatmap
  var HEAT_PRICES = [15, 20, 25, 30, 35, 40];
  var HEAT_PCTS = [25, 50, 75, 90, 100];
  function renderHeatmap(inp) {
    var S = M.sellable(inp);
    var grid = HEAT_PCTS.map(function (p) {
      var n = Math.round(S * p / 100);
      return { p: p, n: n, cells: HEAT_PRICES.map(function (price) {
        return { price: price, net: M.compute(M.withPrice(inp, price), n).net };
      }) };
    });
    var maxAbs = 1;
    grid.forEach(function (row) { row.cells.forEach(function (c) { maxAbs = Math.max(maxAbs, Math.abs(c.net)); }); });
    var tbl = $("heatmap");
    var thead = tbl.tHead, tbody = tbl.tBodies[0];
    thead.textContent = ""; tbody.textContent = "";
    var hr = el("tr", {}, [el("th", { scope: "col", text: "" }, [el("span", { className: "sr-only", text: "Attendance" })])]);
    HEAT_PRICES.forEach(function (p) {
      hr.appendChild(el("th", { scope: "col", className: Math.abs(p - inp.price) < 0.005 ? "here" : "", text: "$" + p }));
    });
    thead.appendChild(hr);
    grid.forEach(function (row) {
      var tr = el("tr", {}, [el("th", { scope: "row", className: row.n === state.n ? "here" : "", text: row.p + "% · " + row.n })]);
      row.cells.forEach(function (c) {
        var t = Math.min(1, Math.abs(c.net) / maxAbs);
        var pole = c.net >= 0 ? "var(--div-pos)" : "var(--div-neg)";
        var pct = Math.round(t * 100);
        var here = Math.abs(c.price - inp.price) < 0.005 && row.n === state.n;
        var td = el("td", {
          tabindex: "0",
          className: (t > 0.55 ? "strong" : "weak") + (here ? " here" : ""),
          style: "background:color-mix(in oklab, var(--div-mid), " + pole + " " + pct + "%)",
          "aria-label": "$" + c.price + " tickets, " + row.n + " sold (" + row.p + "%): net " + fmt$(c.net),
          text: fmtCompact(c.net)
        });
        var rows = [{ text: fmt$(c.net), strong: true }, { text: "$" + c.price + " ticket, " + row.n + " sold (" + row.p + "% of sellable)" }];
        td.addEventListener("pointermove", function (e) { showTip(rows, e.clientX, e.clientY); });
        td.addEventListener("pointerleave", hideTip);
        td.addEventListener("focus", function () { tipAtElement(td, rows); });
        td.addEventListener("blur", hideTip);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    $("heat-min").textContent = fmtCompact(-maxAbs) + " loss";
    $("heat-max").textContent = "+" + fmtCompact(maxAbs).replace(MINUS, "") + " profit";
  }

  // ---------------------------------------------------------------- tables
  function addRow(tb, label, value, opts) {
    opts = opts || {};
    var tr = el("tr", { className: opts.cls || "" }, [
      el("td", { text: label }),
      el("td", { className: "n " + (opts.vcls || ""), text: value })
    ]);
    tb.appendChild(tr);
    return tr;
  }
  function renderScenarios(b) {
    var tb = $("scenarios").tBodies[0];
    tb.textContent = "";
    $("scen-sub").textContent = "At " + priceText(b.inp.price) + " a ticket";
    b.scen.forEach(function (s) {
      var r = s.r;
      tb.appendChild(el("tr", { className: r.n === state.n ? "current" : "" }, [
        el("td", { text: s.pct === 100 ? "Sold out" : s.pct + "%" }),
        el("td", { className: "n", text: String(r.n) }),
        el("td", { className: "n", text: fmt$(r.netTicketRevenue) }),
        el("td", { className: "n", text: fmt$(r.headliner.pay) }),
        el("td", { className: "n", text: fmt$(r.totalCosts) }),
        el("td", { className: "n " + signClass(r.net), text: fmt$(r.net, { plus: true }) })
      ]));
    });
  }
  function renderHeadliner(b) {
    var h = b.r.headliner, inp = b.inp, tb = $("hl-table").tBodies[0];
    tb.textContent = "";
    $("hl-sub").textContent = "At " + b.r.n + " tickets";
    var C = { cents: true };
    addRow(tb, "Deal", hlDescription(inp), { vcls: "wrap" });
    addRow(tb, "Guarantee", inp.hlGuaranteeOn ? fmt$(h.guarantee, C) : "off", { vcls: inp.hlGuaranteeOn ? "" : "off" });
    if (inp.hlPctOn) addRow(tb, inp.hlPct + "% of " + HL_BASIS_SHORT[inp.hlPctBasis] + (h.pctThreshold > 0 ? " beyond " + (isFinite(h.pctThreshold) ? h.pctThreshold : "break-even") + " tickets" : ""), fmt$(h.pctPart, C));
    if (inp.hlPerTicketOn) addRow(tb, fmt$(inp.hlPerTicket, C) + " per ticket" + (h.perTicketThreshold > 0 ? " beyond " + (isFinite(h.perTicketThreshold) ? h.perTicketThreshold : "break-even") + " tickets" : ""), fmt$(h.perTicketPart, C));
    if (inp.hlVersus) addRow(tb, "Versus: greater of guarantee or the parts above", fmt$(h.dealPay, C), { cls: "sub" });
    if (inp.hlBackendOn) addRow(tb, inp.hlBackendPct + "% backend of " + fmt$(Math.max(0, b.r.netBeforeBackend)) + " profit", fmt$(h.backend, C));
    addRow(tb, "Headliner pay", fmt$(h.pay, C), { cls: "total" });
    addRow(tb, "Travel / hotel", fmt$(h.travel, C), { cls: "sub" });
    addRow(tb, "Hospitality / rider", fmt$(h.hospitality, C), { cls: "sub" });
    addRow(tb, "Headliner all-in", fmt$(h.total, C), { cls: "total" });
    addRow(tb, "Headliner break-even (guarantee and all other costs, no bonus parts)", b.hlBE === null ? "never" : b.hlBE + " tickets");
  }
  function renderTalent(b) {
    var r = b.r, inp = b.inp, L = r.costs, tb = $("talent-table").tBodies[0], C = { cents: true };
    tb.textContent = "";
    $("talent-sub").textContent = "At " + r.n + " tickets";
    addRow(tb, "Headliner all-in (pay, travel, rider)", fmt$(r.headliner.total, C));
    addRow(tb, "Supporting artists (" + inp.supportSlots + " x " + fmt$(inp.supportPrice) + ")", fmt$(L.support, C));
    if (inp.vjOn) addRow(tb, "VJ", fmt$(L.vj, C)); else addRow(tb, "VJ", "off", { vcls: "off" });
    addRow(tb, "Total talent cost", fmt$(talentTotal(r), C), { cls: "total" });
  }
  function renderVenue(b) {
    var r = b.r, so = b.soldOut, inp = b.inp, tb = $("venue-table").tBodies[0], C = { cents: true };
    tb.textContent = "";
    $("venue-sub").textContent = venueDescription(inp);
    $("venue-col-now").textContent = "At " + r.n + " tickets";
    $("venue-col-out").textContent = "Sold out (" + b.S + ")";
    function row(label, on, a, c, cls) {
      tb.appendChild(el("tr", { className: cls || "" }, [
        el("td", { text: label }),
        el("td", { className: "n" + (on ? "" : " off"), text: on ? fmt$(a, C) : "off" }),
        el("td", { className: "n" + (on ? "" : " off"), text: on ? fmt$(c, C) : "off" })
      ]));
    }
    row(inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis], inp.doorCutOn, r.venue.doorCut, so.venue.doorCut);
    row("Flat rental / fee", inp.venueRentalOn, r.venue.rental, so.venue.rental);
    row(fmt$(inp.venuePerHead, C) + " per head (" + r.attending + " / " + so.attending + " in the room)", inp.venuePerHeadOn, r.venue.perHead, so.venue.perHead);
    row("Venue takes", true, r.venue.total, so.venue.total, "total");
  }
  function renderPerTicket(r, inp) {
    var p = r.perTicketPrices, tb = $("pt-table").tBodies[0], C = { cents: true }, pn = platLabel(inp);
    tb.textContent = "";
    $("pt-sub").textContent = fmt$(inp.price, C) + " face price" + (inp.doorPriceOn ? ", " + fmt$(p.doorPrice, C) + " at the door" : "");
    addRow(tb, "Ours after sales tax", fmt$(p.faceNet, C));
    addRow(tb, "Sales tax " + (inp.taxOn ? (inp.taxMode === "included" ? "(inside the price)" : "(added on top)") : "(off)"), fmt$(p.tax, C));
    addRow(tb, pn + " service fee", fmt$(p.ebService, C), { cls: "sub" });
    addRow(tb, pn + " processing", fmt$(p.ebProc, C), { cls: "sub" });
    addRow(tb, pn + " fees " + (inp.ebMode === "pass" ? "paid by the buyer" : "absorbed by us"), fmt$(p.ebFee, C));
    addRow(tb, "Buyer pays online", fmt$(p.onlineBuyer, C), { cls: "total" });
    if (inp.doorPriceOn) {
      addRow(tb, "Door face price", fmt$(p.doorPrice, C));
      addRow(tb, "Door: ours after sales tax", fmt$(p.doorFaceNet, C), { cls: "sub" });
      addRow(tb, "Door: sales tax", fmt$(p.doorTax, C), { cls: "sub" });
    }
    addRow(tb, "Door card fee (card buyers)", fmt$(p.doorCardProc, C));
    addRow(tb, "Buyer pays at the door", fmt$(p.doorBuyer, C), { cls: "total" });
    var keep = r.n ? r.netTicketRevenue / r.n : 0;
    addRow(tb, "We keep per ticket sold, after fees and the venue's cut", r.n ? fmt$(keep, C) : "n/a");
  }
  function renderTicketMoney(r, inp) {
    var tb = $("tm-table").tBodies[0], C = { cents: true }, c = r.counts, pn = platLabel(inp);
    tb.textContent = "";
    $("tm-sub").textContent = r.n + " sold + " + inp.comps + " comps = " + (r.n + inp.comps) + " attending";
    addRow(tb, "Online (" + pn + ")", c.online + " tickets");
    addRow(tb, "Door", c.door + " tickets (" + c.doorCash + " cash, " + c.doorCard + " card)");
    addRow(tb, "Buyers paid online", fmt$(r.buyersPaidOnline, C), { cls: "sub" });
    addRow(tb, "Buyers paid at the door", fmt$(r.buyersPaidDoor, C), { cls: "sub" });
    addRow(tb, "Everything buyers paid", fmt$(r.buyersPaid, C), { cls: "total" });
    addRow(tb, "Sales tax collected (to the state)", MINUS + fmt$(r.tax, C));
    addRow(tb, pn + " fees paid by buyers", MINUS + fmt$(r.eventbrite.passed, C));
    addRow(tb, "Ticket sales after tax", fmt$(r.faceNet, C), { cls: "total" });
    addRow(tb, pn + " fees we absorb", MINUS + fmt$(r.eventbrite.absorbed, C));
    addRow(tb, "Door card processing", MINUS + fmt$(r.doorProc, C));
    if (inp.doorCutOn) addRow(tb, "Venue " + inp.doorCutPct + "% of door (of " + fmt$(r.doorCutBasis) + ")", MINUS + fmt$(r.venue.doorCut, C));
    if (inp.venuePerHeadOn) addRow(tb, "Venue per-head fee (" + r.attending + " in the room)", MINUS + fmt$(r.venue.perHead, C));
    addRow(tb, "Net ticket revenue (ours)", fmt$(r.netTicketRevenue, C), { cls: "total" });
  }
  // Cost ledger values: every editable row is a control; here we fill the read-only numbers.
  function renderCosts(r, inp) {
    var C = { cents: true }, L = r.costs, h = r.headliner;
    function set(id, v, on) {
      var e = $(id);
      e.textContent = on === false ? "off" : fmt$(v, C);
      e.classList.toggle("off", on === false);
    }
    $("cost-sub").textContent = "At " + r.n + " tickets";
    set("led-hl-pay", h.pay);
    set("led-hl-extra", L.headlinerTravel + L.headlinerHospitality);
    $("led-support-label").textContent = "Supporting artists (" + inp.supportSlots + " x " + fmt$(inp.supportPrice) + ")";
    set("led-support", L.support);
    set("led-vj", L.vj, inp.vjOn);
    set("led-talent", talentTotal(r));
    set("led-venue-rental", L.venueRental, inp.venueRentalOn);
    var taken = r.venue.doorCut + r.venue.perHead;
    set("led-venue-taken", taken, inp.doorCutOn || inp.venuePerHeadOn);
    set("led-venue", L.venueRental);
    set("led-production", L.security + L.sound + L.gear + L.photo);
    set("led-marketing", L.ads + L.poster + L.printing);
    set("led-licensing", L.ascap + L.bmi + L.insurance);
    set("led-custom", L.custom);
    set("led-contingency", r.contingency);
    $("led-contingency").title = inp.contingencyPct + "% of " + fmt$(r.contingencyBase, C);
    set("led-total", r.totalCosts);
    $("led-total-2").textContent = MINUS + fmt$(r.totalCosts, C);
    set("led-nettix", r.netTicketRevenue);
    $("led-net-label").textContent = "Net at " + r.n + " tickets";
    var nv = $("led-net");
    nv.textContent = fmt$(r.net, C);
    nv.className = "lval " + signClass(r.net);
  }

  function renderNotes(inp, b) {
    var cl = $("confirm-list"), al = $("assume-list");
    cl.textContent = ""; al.textContent = "";
    function li(host, strong, rest) { host.appendChild(el("li", {}, [el("strong", { text: strong }), " " + rest])); }
    function confirm(strong, rest, sec, linkText) {
      cl.appendChild(el("li", {}, [el("strong", { text: strong }), " " + rest + " ", el("a", { href: "#" + sec, text: linkText })]));
    }
    var pn = platLabel(inp);
    confirm("Venue deal.", "The venue takes " + venueDescription(inp) + ". Confirm each part with the venue" +
      (inp.doorCutOn ? ", including what the " + inp.doorCutPct + "% is taken from; switching to gross face moves the numbers." : "."), "venue", "Open Venue");
    confirm("Sales tax rate.", (inp.taxOn ? inp.taxRate + "% " + (inp.taxMode === "included" ? "included in the price" : "added on top") : "Sales tax is off") + ". Look up the combined rate for the venue's address.", "tickets", "Open Tickets & fees");
    confirm(pn + " rates.", inp.ebServicePct + "% + " + fmt$(inp.ebServiceFixed, { cents: true }) + " service and " + inp.ebProcPct + "% processing, " + (inp.ebMode === "pass" ? "passed to the buyer" : "absorbed by us") + ". Check the platform's pricing page.", "tickets", "Open Tickets & fees");
    confirm("PRO licensing.", "ASCAP and BMI are " + (inp.ascapOn || inp.bmiOn ? "partly on" : "off") + ": usually the venue's license. Turn them on if the venue requires promoter coverage.", "costs", "Open Costs");
    confirm("Insurance.", "Event insurance is " + (inp.insuranceOn ? "on" : "off") + " (a recent one-night quote was $357). Check whether the venue requires it.", "costs", "Open Costs");
    confirm("Sound.", "Sound rental is " + (inp.soundOn ? "on" : "off") + ". Confirm the house system covers the lineup.", "costs", "Open Costs");

    li(al, "Tickets.", "Capacity " + inp.capacity + " minus " + inp.comps + " comps leaves " + b.S + " sellable. Comps count toward attendance, not revenue. Online and door splits use whole tickets.");
    li(al, "Our money.", "Net ticket revenue is ticket sales after sales tax, minus " + pn + " fees we absorb, door card processing, the venue's % of door and any per-head fee. Sales tax and fees passed to buyers are never ours.");
    li(al, "Venue deal.", "The parts add up. The % of door and the per-head fee come out of ticket revenue; the per-head fee counts everyone in the room, comps included, so it is owed even at 0 tickets. The flat rental is a cost line and counts toward contingency.");
    li(al, "Passed fees.", "When fees go to the buyer, the platform's processing applies to the whole checkout, so the buyer total is (face + on-top tax + service fee) / (1 - processing %).");
    li(al, "Door price.", inp.doorPriceOn
      ? "Door tickets sell at " + priceText(inp.doorPrice) + " and online tickets at " + priceText(inp.price) + ". The heatmap and break-even price move both prices together, keeping the door markup."
      : "Door tickets sell at the same price as online tickets.");
    li(al, "Door card fee.", "The % applies to what the door buyer is charged, including any on-top tax. Cash has no fee.");
    li(al, "Headliner break-even.", "The first ticket count where net reaches $0 counting the guarantee and all other costs but no headliner bonus, % or backend. After-break-even parts pay only on tickets past it, and pay nothing if the show never gets there.");
    li(al, "Headliner % basis.", "Gross face is tickets x listed price (door price for door tickets). Face net removes included sales tax. A % that starts later pays on the difference between the basis at the current count and at the start point.");
    li(al, "Versus.", "Pays the greater of the guarantee and the % plus per-ticket parts; with the guarantee off the floor is $0. Backend is added after.");
    li(al, "Contingency.", inp.contingencyPct + "% of every other cost including the guarantee and the venue rental, but not the headliner %, per-ticket, versus overage or backend, and not the venue's % of door or per-head fee.");
    li(al, "Break-even price.", "The lowest price, to the cent, where the chosen ticket count reaches $0 net, searched up to $1,000.");
  }

  // ---------------------------------------------------------------- start
  restore();
  buildInputs();
  syncControls();
  wire();
  trackVerdictHeight();
  initSections();
  recompute();
})();
