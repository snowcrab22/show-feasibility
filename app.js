/* 150-Cap Show Feasibility: DOM wiring, charts, state. Depends on window.ShowModel (model.js). */
(function () {
  "use strict";
  var M = window.ShowModel;
  var STORE_KEY = "kcplur-show-feasibility-v1";
  var SVGNS = "http://www.w3.org/2000/svg";
  var MINUS = "−";

  var state = { inputs: M.sanitize(M.DEFAULTS), n: M.expectedTickets(M.DEFAULTS), nWant: M.expectedTickets(M.DEFAULTS) };
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

  // ---------------------------------------------------------------- input schema
  var BASIS_HL = [["grossFace", "Gross face (tickets x price)"], ["faceNet", "Face net of sales tax"], ["net", "Our net ticket revenue (after fees and door cut)"]];
  var START = [["first", "From ticket 1"], ["breakEven", "After break-even"], ["afterN", "After N tickets"]];

  var SECTIONS = [
    { id: "g-tickets", title: "Tickets & sales", fields: [
      { k: "capacity", label: "Venue capacity", type: "int" },
      { k: "comps", label: "Comps / guest list", type: "int", hint: "Count toward attendance, not revenue." },
      { type: "readout", id: "sellable-readout", label: "Sellable tickets" },
      { k: "onlinePct", label: "Sold online via Eventbrite", type: "pct", hint: "The rest sell at the door." },
      { k: "doorCashPct", label: "Door sales paid in cash", type: "pct", hint: "Cash has no processing fee." },
      { pair: [
        { k: "doorCardPct", label: "Door card processing", type: "pct", step: 0.1 },
        { k: "doorCardFixed", label: "Plus per card ticket", type: "money", step: 0.01 }
      ], hint: "Square-style rate on what the door buyer is charged." }
    ] },
    { id: "g-tax", title: "Taxes & fees", fields: [
      { k: "taxOn", label: "Collect sales tax", type: "check" },
      { k: "taxRate", label: "Sales tax rate", type: "pct", step: 0.001, dependsOn: "taxOn",
        note: "Kansas City (Westport) combined rate. Look up the new venue's address on the Missouri DOR lookup." },
      { k: "taxMode", label: "Sales tax is", type: "select", dependsOn: "taxOn", options: [["included", "Included in price"], ["ontop", "Added on top (buyer pays extra)"]] },
      { k: "ebMode", label: "Eventbrite fees", type: "select", options: [["pass", "Pass fees to buyer"], ["absorb", "Absorb fees (included in price)"]] },
      { pair: [
        { k: "ebServicePct", label: "Service fee", type: "pct", step: 0.1 },
        { k: "ebServiceFixed", label: "Plus per ticket", type: "money", step: 0.01 }
      ] },
      { k: "ebProcPct", label: "Payment processing", type: "pct", step: 0.1,
        note: "US rates as of Nov 2026: 3.7% + $1.79 per ticket service fee, 2.9% payment processing per order — check Eventbrite's pricing page." }
    ] },
    { id: "g-venue", title: "Venue deal", fields: [
      { k: "doorCutPct", label: "Venue door cut", type: "pct", step: 0.5 },
      { k: "doorCutBasis", label: "Door cut is taken from", type: "select", options: [
        ["afterTax", "Ticket sales after sales tax, before ticketing fees"],
        ["afterTaxFees", "Ticket sales after tax and ticketing fees"],
        ["gross", "Gross face value incl. tax"]
      ], note: "Confirm with the venue what the 15% is taken from. Applies to online and door tickets." },
      { k: "venueRental", label: "Venue rental / fee", type: "money", hint: "$0 on a door-cut deal." }
    ] },
    { id: "g-hl", title: "Headliner deal", fields: [
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
        hint: "Backend is still added on top. Starting points apply only to tickets beyond them." },
      { pair: [
        { k: "hlTravel", label: "Travel / hotel", type: "money" },
        { k: "hlHospitality", label: "Hospitality / rider", type: "money" }
      ] }
    ] },
    { id: "g-lineup", title: "Lineup", fields: [
      { pair: [
        { k: "supportSlots", label: "Supporting slots", type: "int" },
        { k: "supportPrice", label: "Price per slot", type: "money" }
      ] },
      { k: "vj", toggle: "vjOn", label: "VJ", type: "money" }
    ] },
    { id: "g-prod", title: "Production", fields: [
      { k: "security", toggle: "securityOn", label: "Contracted security (flat)", type: "money" },
      { k: "sound", toggle: "soundOn", label: "Sound rental", type: "money" },
      { k: "gear", toggle: "gearOn", label: "Additional deck / gear", type: "money" },
      { k: "photo", label: "Photo / video", type: "money" }
    ] },
    { id: "g-mkt", title: "Marketing", fields: [
      { k: "ads", label: "Advertising budget", type: "money" },
      { pair: [
        { k: "poster", label: "Poster design", type: "money" },
        { k: "printing", label: "Printing", type: "money" }
      ] }
    ] },
    { id: "g-other", title: "Other", fields: [
      { k: "ascap", toggle: "ascapOn", label: "PRO licensing: ASCAP", type: "money" },
      { k: "bmi", toggle: "bmiOn", label: "PRO licensing: BMI", type: "money",
        note: "Usually the venue's license; turn on if the venue requires promoter coverage." },
      { k: "insurance", toggle: "insuranceOn", label: "Event insurance", type: "money", note: "Typical one-night event policy quote." },
      { k: "contingencyPct", label: "Contingency", type: "pct", step: 1, hint: "% of all other costs, not counting headliner %, per-ticket, versus or backend pay." },
      { type: "custom" },
      { k: "otherIncome", label: "Other income (merch, sponsor)", type: "money" }
    ] }
  ];

  var controls = {}; // key -> input element
  var fieldRows = []; // { row, dependsOn, showIf }

  function unitWrap(input, type) {
    if (type === "money") return el("div", { className: "input-wrap pre" }, [el("span", { className: "unit", text: "$", "aria-hidden": "true" }), input]);
    if (type === "pct") return el("div", { className: "input-wrap post" }, [input, el("span", { className: "unit", text: "%", "aria-hidden": "true" })]);
    return el("div", { className: "input-wrap" }, [input]);
  }
  function makeInput(f) {
    var id = "f-" + f.k;
    var input;
    if (f.type === "select") {
      input = el("select", { id: id, dataset: { k: f.k } });
      f.options.forEach(function (o) { input.appendChild(el("option", { value: o[0], text: o[1] })); });
    } else if (f.type === "check") {
      input = el("input", { type: "checkbox", id: id, dataset: { k: f.k } });
    } else {
      input = el("input", {
        type: "number", id: id, dataset: { k: f.k }, min: "0",
        step: f.step || (f.type === "int" ? 1 : f.type === "pct" ? 0.1 : 1),
        inputmode: f.type === "int" ? "numeric" : "decimal"
      });
    }
    controls[f.k] = input;
    return input;
  }
  function describe(input, f, row) {
    var ids = [];
    if (f.hint) { var h = el("p", { className: "hint", id: "f-" + f.k + "-hint", text: f.hint }); row.appendChild(h); ids.push(h.id); }
    if (f.note) { var n = el("p", { className: "note", id: "f-" + f.k + "-note", text: f.note }); row.appendChild(n); ids.push(n.id); }
    if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  }
  function buildField(f) {
    if (f.pair) {
      var wrap = el("div", { className: "field" });
      var grid = el("div", { className: "pair" });
      f.pair.forEach(function (p) {
        var inp = makeInput(p);
        grid.appendChild(el("div", { className: "field" }, [el("label", { "for": inp.id, text: p.label }), unitWrap(inp, p.type)]));
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
    if (f.type === "custom") return buildCustomBlock();

    var row;
    if (f.type === "check") {
      var cb = makeInput(f);
      row = el("div", { className: "field" }, [el("label", { className: "check", "for": cb.id }, [cb, f.label])]);
      describe(cb, f, row);
    } else if (f.toggle) {
      var tg = makeInput({ k: f.toggle, type: "check" });
      var amt = makeInput(f);
      var amtLabel = el("label", { className: "sr-only", "for": amt.id, text: f.label + " amount" });
      row = el("div", { className: "field" }, [
        el("div", { className: "toggle-row" }, [
          el("label", { className: "check", "for": tg.id }, [tg, f.label]),
          el("div", { className: "row-amount" }, [amtLabel, unitWrap(amt, f.type)])
        ])
      ]);
      describe(amt, f, row);
      fieldRows.push({ row: row, dependsOn: f.toggle });
    } else {
      var inp = makeInput(f);
      row = el("div", { className: "field" }, [el("label", { "for": inp.id, text: f.label }), f.type === "select" ? inp : unitWrap(inp, f.type)]);
      describe(inp, f, row);
    }
    if (f.dependsOn || f.showIf) fieldRows.push({ row: row, dependsOn: f.dependsOn, showIf: f.showIf });
    return row;
  }

  function buildCustomBlock() {
    var box = el("div", { className: "field" }, [
      el("span", { className: "flabel", text: "Custom cost lines" }),
      el("div", { className: "custom-list", id: "custom-list" }),
      el("div", {}, [el("button", { type: "button", className: "small", id: "btn-add-custom", text: "Add cost line" })])
    ]);
    return box;
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

  function buildInputs() {
    var host = $("inputs");
    SECTIONS.forEach(function (s) {
      var body = el("div", { className: "group-body" });
      s.fields.forEach(function (f) { body.appendChild(buildField(f)); });
      host.appendChild(el("details", { className: "group", id: s.id, open: true }, [el("summary", { text: s.title }), body]));
    });
    controls.price = $("f-price");
    controls.venueName = $("f-venueName");
  }

  // Write state into every control (load, reset, preset). Never called on plain typing.
  function syncControls(skip) {
    Object.keys(controls).forEach(function (k) {
      var c = controls[k];
      if (c === skip) return;
      var v = state.inputs[k];
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

    if (k === "hlPreset" && M.PRESETS[t.value]) {
      Object.assign(state.inputs, M.PRESETS[t.value]);
      syncControls(t);
    } else if (HL_TOGGLES.indexOf(k) >= 0) {
      state.inputs.hlPreset = M.detectPreset(state.inputs);
      controls.hlPreset.value = state.inputs.hlPreset;
    }
    recompute();
  }

  function setN(n) {
    var S = M.sellable(M.sanitize(state.inputs));
    state.nWant = clamp(Math.round(n), 0, S);
    recompute();
  }

  function wire() {
    document.addEventListener("input", function (e) {
      if (e.target.id === "n-slider" || e.target.id === "n-input") {
        state.nWant = Math.round(parseNum(e.target.value));
        recompute(e.target);
        return;
      }
      if (e.target.closest("#inputs, .lever-price, .venue-field")) onControl(e);
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
    $("inputs").addEventListener("click", function (e) {
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
    ["btn-copy-summary", "btn-copy-summary-top"].forEach(function (id) {
      $(id).addEventListener("click", function () { copyText(summaryText(), "Summary copied. Paste it in Discord or a text."); });
    });
    ["btn-copy-code", "btn-copy-code-top"].forEach(function (id) {
      $(id).addEventListener("click", function () { copyText(encodeScenario(), "Scenario code copied. Whoever loads it sees this exact scenario."); });
    });
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
      state.nWant = state.n = M.expectedTickets(state.inputs);
      syncControls();
      recompute();
      showMsg("Reset to the default scenario.", "ok");
    });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { if (last) { renderChart(last); renderMoneyBar(last.r); } });
      ro.observe($("chart-wrap"));
    } else {
      window.addEventListener("resize", function () { if (last) { renderChart(last); renderMoneyBar(last.r); } });
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

  function summaryText() {
    if (!last) return "";
    var b = last, inp = b.inp, r = b.r, S = r.sellable;
    var A = { ascii: true };
    var lines = [];
    lines.push("150-Cap Show Feasibility - " + (inp.venueName || "New venue"));
    lines.push(r.n + " of " + S + " sellable tickets at " + fmt$(inp.price, { cents: inp.price % 1 !== 0 }) + " (" + inp.comps + " comps, cap " + inp.capacity + ")");
    lines.push("Net: " + fmt$(r.net, A) + " (" + STATUS_LABEL[statusOf(r.net)].toLowerCase() + ")");
    lines.push("Break-even: " + (b.be === null ? "can't break even at this price, even sold out" : b.be + " tickets (" + fmtPct(b.be / Math.max(1, S)) + " of sellable)"));
    lines.push("Break-even price at " + r.n + " sold: " + (b.bePrice === null ? "none" : fmt$(b.bePrice, { cents: true })));
    lines.push("Headliner: " + fmt$(r.headliner.pay, A) + " (" + hlDescription(inp) + ")");
    lines.push("Buyer pays: " + fmt$(r.buyerPaysOnline, { cents: true }) + " online, " + fmt$(r.buyerPaysDoor, { cents: true }) + " at the door");
    lines.push("Net ticket revenue " + fmt$(r.netTicketRevenue, A) + " | Total costs " + fmt$(r.totalCosts, A) + (r.otherIncome ? " | Other income " + fmt$(r.otherIncome, A) : ""));
    lines.push("At this price: " + b.scen.map(function (s) { return s.pct + "% (" + s.r.n + ") " + fmt$(s.r.net, A); }).join(" | "));
    lines.push("Assumes: " + (inp.taxOn ? "sales tax " + inp.taxRate + "% " + (inp.taxMode === "included" ? "included" : "on top") : "no sales tax") +
      "; Eventbrite fees " + (inp.ebMode === "pass" ? "passed to buyer" : "absorbed") +
      "; venue " + inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis] + "; " + inp.onlinePct + "% online");
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
    last = { inp: inp, r: r, be: be, hlBE: hlBE, bePrice: bePrice, sw: sw, scen: scen, S: S };

    var slider = $("n-slider"), nIn = $("n-input");
    slider.max = S;
    if (fromLever !== slider) slider.value = state.n;
    if (fromLever !== nIn) nIn.value = state.n;
    nIn.max = S;
    slider.setAttribute("aria-valuetext", state.n + " tickets, " + fmtPct(state.n / Math.max(1, S)) + " of sellable");
    $("n-context").textContent = fmtPct(state.n / Math.max(1, S)) + " of " + S + " sellable, " + (state.n + inp.comps) + " in the room with comps";
    $("sellable-readout").textContent = S + " (capacity " + inp.capacity + " minus " + inp.comps + " comps)";
    $("price-hint").textContent = "Buyer pays " + fmt$(r.buyerPaysOnline, { cents: true }) + " online, " + fmt$(r.buyerPaysDoor, { cents: true }) + " at the door";
    document.querySelectorAll(".quick button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(Math.round(S * (+b.dataset.q) / 100) === state.n));
    });

    applyVisibility();
    renderTiles(last);
    renderChart(last);
    renderMoney(r);
    renderHeatmap(inp);
    renderScenarios(last);
    renderHeadliner(last);
    renderPerTicket(r, inp);
    renderTicketMoney(r, inp);
    renderCosts(r, inp);
    renderNotes(inp, last);
    save();
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
      bp === null ? (r.n === 0 ? "No price works with 0 tickets sold" : "Even $1,000 a ticket loses") : (bp <= b.inp.price ? "At or under your " + fmt$(b.inp.price, { cents: b.inp.price % 1 !== 0 }) + " price" : fmt$(bp - b.inp.price, { cents: true }) + " above your price")));
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
    host.appendChild(tile("Buyer pays at checkout (online)", fmt$(r.buyerPaysOnline, { cents: true }), "Door " + fmt$(r.buyerPaysDoor, { cents: true }) + "; fees " + (b.inp.ebMode === "pass" ? "passed to buyer" : "absorbed by us")));
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
    { k: "ebFees", label: "Eventbrite fees", color: "var(--s1)" },
    { k: "doorProc", label: "Door card processing", color: "var(--s2)" },
    { k: "doorCut", label: "Venue door cut", color: "var(--s3)" },
    { k: "headliner", label: "Headliner (pay, travel, rider)", color: "var(--s4)", text: "#0b0b0b" },
    { k: "supportVj", label: "Support + VJ", color: "var(--s5)" },
    { k: "production", label: "Production (sound, security, gear)", color: "var(--s6)" },
    { k: "marketing", label: "Marketing", color: "var(--s7)" },
    { k: "other", label: "Other costs and contingency", color: "var(--s8)" },
    { k: "profit", label: "Profit (ours)", color: "var(--seg-profit)", text: "var(--seg-profit-text)" }
  ];
  function renderMoney(r) {
    var inflow = r.inflow, loss = r.money.loss;
    $("money-sub").textContent = "At " + r.n + " tickets: buyers paid " + fmt$(r.buyersPaid) + (r.otherIncome ? " plus " + fmt$(r.otherIncome) + " other income" : "");
    renderMoneyBar(r);
    var lg = $("money-legend");
    lg.textContent = "";
    CATS.forEach(function (c) {
      if (c.k === "profit" && loss > 0) return;
      lg.appendChild(el("span", {}, [el("i", { style: "background:" + c.color }), c.label]));
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
        el("td", {}, [el("span", { className: "sw", style: "background:" + c.color, "aria-hidden": "true" }), c.label]),
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
        "aria-label": p.c.label + ": " + fmt$(p.v, { cents: true }) + ", " + fmtPct(share, 1),
        style: "flex:" + share + " 1 0;background:" + p.c.color + ";color:" + (p.c.text || "#ffffff"),
        text: fits ? lbl : ""
      });
      var rows = [{ text: fmt$(p.v, { cents: true }), strong: true }, { text: p.c.label + ", " + fmtPct(share, 1) }];
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
        return { price: price, net: M.compute(Object.assign({}, inp, { price: price }), n).net };
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
    $("scen-sub").textContent = "At " + fmt$(b.inp.price, { cents: b.inp.price % 1 !== 0 }) + " a ticket";
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
    addRow(tb, "Deal", hlDescription(inp));
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
  function renderPerTicket(r, inp) {
    var p = r.perTicketPrices, tb = $("pt-table").tBodies[0], C = { cents: true };
    tb.textContent = "";
    $("pt-sub").textContent = fmt$(inp.price, C) + " face price";
    addRow(tb, "Ours after sales tax", fmt$(p.faceNet, C));
    addRow(tb, "Sales tax " + (inp.taxOn ? (inp.taxMode === "included" ? "(inside the price)" : "(added on top)") : "(off)"), fmt$(p.tax, C));
    addRow(tb, "Eventbrite service fee", fmt$(p.ebService, C), { cls: "sub" });
    addRow(tb, "Eventbrite processing", fmt$(p.ebProc, C), { cls: "sub" });
    addRow(tb, "Eventbrite fees " + (inp.ebMode === "pass" ? "paid by the buyer" : "absorbed by us"), fmt$(p.ebFee, C));
    addRow(tb, "Buyer pays online", fmt$(p.onlineBuyer, C), { cls: "total" });
    addRow(tb, "Door card fee (card buyers)", fmt$(p.doorCardProc, C));
    addRow(tb, "Buyer pays at the door", fmt$(p.doorBuyer, C), { cls: "total" });
    var keep = r.n ? r.netTicketRevenue / r.n : 0;
    addRow(tb, "We keep per ticket sold, after fees and door cut", r.n ? fmt$(keep, C) : "n/a");
  }
  function renderTicketMoney(r, inp) {
    var tb = $("tm-table").tBodies[0], C = { cents: true }, c = r.counts;
    tb.textContent = "";
    $("tm-sub").textContent = r.n + " sold + " + inp.comps + " comps = " + (r.n + inp.comps) + " attending";
    addRow(tb, "Online (Eventbrite)", c.online + " tickets");
    addRow(tb, "Door", c.door + " tickets (" + c.doorCash + " cash, " + c.doorCard + " card)");
    addRow(tb, "Buyers paid online", fmt$(r.buyersPaidOnline, C), { cls: "sub" });
    addRow(tb, "Buyers paid at the door", fmt$(r.buyersPaidDoor, C), { cls: "sub" });
    addRow(tb, "Everything buyers paid", fmt$(r.buyersPaid, C), { cls: "total" });
    addRow(tb, "Sales tax collected (to the state)", MINUS + fmt$(r.tax, C));
    addRow(tb, "Eventbrite fees paid by buyers", MINUS + fmt$(r.eventbrite.passed, C));
    addRow(tb, "Ticket sales after tax", fmt$(r.faceNet, C), { cls: "total" });
    addRow(tb, "Eventbrite fees we absorb", MINUS + fmt$(r.eventbrite.absorbed, C));
    addRow(tb, "Door card processing", MINUS + fmt$(r.doorProc, C));
    addRow(tb, "Venue door cut (" + inp.doorCutPct + "% of " + fmt$(r.doorCutBasis) + ")", MINUS + fmt$(r.doorCut, C));
    addRow(tb, "Net ticket revenue (ours)", fmt$(r.netTicketRevenue, C), { cls: "total" });
  }
  function renderCosts(r, inp) {
    var tb = $("cost-table").tBodies[0], C = { cents: true }, L = r.costs, h = r.headliner;
    tb.textContent = "";
    $("cost-sub").textContent = "At " + r.n + " tickets";
    function line(label, v, on) {
      if (on === false) addRow(tb, label, "off", { vcls: "off" });
      else addRow(tb, label, fmt$(v, C));
    }
    line("Headliner pay", h.pay);
    line("Headliner travel / hotel", L.headlinerTravel);
    line("Hospitality / rider", L.headlinerHospitality);
    line("Supporting artists (" + inp.supportSlots + " x " + fmt$(inp.supportPrice) + ")", L.support);
    line("VJ", L.vj, inp.vjOn);
    line("Contracted security", L.security, inp.securityOn);
    line("Sound rental", L.sound, inp.soundOn);
    line("Additional deck / gear", L.gear, inp.gearOn);
    line("Photo / video", L.photo);
    line("Venue rental / fee", L.venueRental);
    line("Advertising", L.ads);
    line("Poster design", L.poster);
    line("Printing", L.printing);
    line("ASCAP", L.ascap, inp.ascapOn);
    line("BMI", L.bmi, inp.bmiOn);
    line("Event insurance", L.insurance, inp.insuranceOn);
    inp.custom.forEach(function (row, i) { line(row.name || "Custom line " + (i + 1), row.amount); });
    line("Contingency (" + inp.contingencyPct + "% of " + fmt$(r.contingencyBase) + ")", r.contingency);
    addRow(tb, "Total costs", fmt$(r.totalCosts, C), { cls: "total" });
    if (r.otherIncome) addRow(tb, "Other income", "+" + fmt$(r.otherIncome, C));
    addRow(tb, "Net", fmt$(r.net, C), { cls: "total", vcls: signClass(r.net) });
  }

  function renderNotes(inp, b) {
    var cl = $("confirm-list"), al = $("assume-list");
    cl.textContent = ""; al.textContent = "";
    function li(host, strong, rest) { host.appendChild(el("li", {}, [el("strong", { text: strong }), " " + rest])); }
    li(cl, "Door-cut basis.", "The venue takes " + inp.doorCutPct + "% of " + CUT_SHORT[inp.doorCutBasis] + ". Confirm with the venue what the 15% is taken from; switching to gross face moves the numbers.");
    li(cl, "Sales tax rate.", (inp.taxOn ? inp.taxRate + "% " + (inp.taxMode === "included" ? "included in the price" : "added on top") : "Sales tax is off") + ". 10.975% is a Kansas City (Westport) combined rate; look up the new venue's address on the Missouri DOR lookup.");
    li(cl, "Eventbrite rates.", inp.ebServicePct + "% + " + fmt$(inp.ebServiceFixed, { cents: true }) + " service and " + inp.ebProcPct + "% processing, " + (inp.ebMode === "pass" ? "passed to the buyer" : "absorbed by us") + ". US rates as of Nov 2026; check Eventbrite's pricing page.");
    li(cl, "PRO licensing.", "ASCAP and BMI are " + (inp.ascapOn || inp.bmiOn ? "partly on" : "off") + ": usually the venue's license. Turn them on if the venue requires promoter coverage.");
    li(cl, "Insurance.", "Event insurance is " + (inp.insuranceOn ? "on" : "off") + " (a recent one-night quote was $357). Check whether the new venue requires it.");
    li(cl, "Sound.", "Sound rental is " + (inp.soundOn ? "on" : "off") + ". Confirm the house system covers the lineup.");

    li(al, "Tickets.", "Capacity " + inp.capacity + " minus " + inp.comps + " comps leaves " + b.S + " sellable. Comps count toward attendance, not revenue. Online and door splits use whole tickets.");
    li(al, "Our money.", "Net ticket revenue is ticket sales after sales tax, minus Eventbrite fees we absorb, door card processing and the venue door cut. Sales tax and fees passed to buyers are never ours.");
    li(al, "Passed fees.", "When fees go to the buyer, Eventbrite processing applies to the whole checkout, so the buyer total is (face + on-top tax + service fee) / (1 - processing %).");
    li(al, "Door card fee.", "The % applies to what the door buyer is charged, including any on-top tax. Cash has no fee.");
    li(al, "Headliner break-even.", "The first ticket count where net reaches $0 counting the guarantee and all other costs but no headliner bonus, % or backend. After-break-even parts pay only on tickets past it, and pay nothing if the show never gets there.");
    li(al, "Headliner % basis.", "Gross face is tickets x listed price. Face net removes included sales tax. A % that starts later pays on the difference between the basis at the current count and at the start point.");
    li(al, "Versus.", "Pays the greater of the guarantee and the % plus per-ticket parts; with the guarantee off the floor is $0. Backend is added after.");
    li(al, "Contingency.", inp.contingencyPct + "% of every other cost including the guarantee, but not the headliner %, per-ticket, versus overage or backend.");
    li(al, "Break-even price.", "The lowest price, to the cent, where the chosen ticket count reaches $0 net, searched up to $1,000.");
  }

  // ---------------------------------------------------------------- start
  restore();
  buildInputs();
  syncControls();
  wire();
  recompute();
})();
