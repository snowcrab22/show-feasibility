/* Show Feasibility: DOM wiring, charts, state, section routing. Depends on window.ShowModel (model.js). */
(function () {
  "use strict";
  var M = window.ShowModel;
  var X = window.ShowExport;
  var WB = window.ShowWorkbook;
  var G = window.ShowGoogle;
  var STORE_KEY = "kcplur-show-feasibility-v1"; // same key and {v, inputs, n} shape as the first version
  var SECTION_KEY = "kcplur-show-feasibility-section";
  var SECTION_NAMES = ["overview", "tickets", "venue", "talent", "costs", "offer", "share"];
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

  // Formatting and wording are shared with the spreadsheet export (export.js).
  var fmt$ = X.fmt$, fmtCompact = X.fmtCompact, fmtPct = X.fmtPct, statusOf = X.statusOf, STATUS_LABEL = X.STATUS_LABEL, priceText = X.priceText;
  var hlDescription = X.hlDescription, venueDescription = X.venueDescription, talentTotal = X.talentTotal;
  function signClass(v) { return v >= 0.5 ? "pos" : v <= -0.5 ? "neg" : ""; }

  // Platform name as typed, or a neutral fallback for sentences.
  function platLabel(inp) { return X.platLabel(inp || state.inputs); }
  function catLabel(c) { return X.catLabel(c, last ? last.inp : state.inputs); }
  // Label text may contain {P}; it becomes a span that recompute keeps set to the platform name.
  function labelNodes(text) {
    var parts = String(text).split("{P}"), out = [];
    parts.forEach(function (p, i) {
      if (i) out.push(el("span", { className: "plat-name" }));
      if (p) out.push(p);
    });
    return out;
  }

  // ---------------------------------------------------------------- input schema (shared with export.js)
  var SECTIONS = X.SECTIONS;
  var LEDGER = X.LEDGER;

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
    if (f.pay) return crewRow(f);
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
  // Labor line: on/off, people, pay each, and the line total.
  function crewRow(f) {
    var tg = makeInput({ k: f.toggle, type: "check" });
    var ppl = makeInput({ k: f.k, type: "int" });
    var pay = makeInput({ k: f.pay, type: "money" });
    var row = lrow("crew", [
      el("label", { className: "check lname", "for": tg.id }, [tg, f.label]),
      el("div", { className: "crew-inputs" }, [
        el("label", { className: "sr-only", "for": ppl.id, text: f.label + ": people" }), unitWrap(ppl, "int"),
        el("span", { className: "crew-x", text: "x", "aria-hidden": "true" }),
        el("label", { className: "sr-only", "for": pay.id, text: f.label + ": pay each for the night" }), unitWrap(pay, "money")
      ]),
      lval("led-" + f.line)
    ]);
    fieldRows.push({ row: row, dependsOn: f.toggle });
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
    ], "led-venue", "Venue rental subtotal"));
    LEDGER.forEach(function (g) {
      host.appendChild(lgroup(g.title, null, g.rows.map(ledgerInputRow), "led-" + g.id));
    });
    host.appendChild(lgroup("Custom cost lines", null, [
      el("div", { className: "custom-list", id: "custom-list" }),
      el("div", {}, [el("button", { type: "button", className: "small", id: "btn-add-custom", text: "Add cost line" })])
    ], "led-custom"));

    var cp = makeInput({ k: "contingencyPct", type: "pct", step: 1 });
    var hint = el("p", { className: "hint", id: "f-contingencyPct-hint", text: X.CONTINGENCY_HINT });
    cp.setAttribute("aria-describedby", hint.id);
    host.appendChild(el("div", { className: "lgroup" }, [
      lrow("contingency", [el("label", { "for": cp.id, className: "lname", text: "Contingency" }), unitWrap(cp, "pct"), lval("led-contingency")]),
      hint,
      lrow("total grand", [el("span", { text: "Total costs" }), lval("led-total")])
    ]));

    var oi = makeInput({ k: "otherIncome", type: "money" });
    $("ledger-summary").appendChild(el("div", { className: "lsummary" }, [
      lrow("", [el("span", {}, [el("a", { href: "#tickets", text: "Net ticket revenue" }), " (after tax, fees and the venue's cut)"]), lval("led-nettix")]),
      lrow("", [el("label", { "for": oi.id, className: "lname", text: "Other income (merch, sponsor)" }), unitWrap(oi, "money")]),
      lrow("", [el("span", { text: "Minus total costs" }), lval("led-total-2")]),
      lrow("total grand", [el("span", { id: "led-net-label", text: "Net" }), lval("led-net")])
    ]));
  }

  // ---------------------------------------------------------------- offer (padded costs)
  function buildOffer() {
    var host = $("offer-ledger");
    var rows = X.OFFER_ROWS.map(function (o) {
      var id = "offer-" + o.key;
      var inp = el("input", { type: "number", id: id, min: "0", step: "1", inputmode: "decimal", dataset: { ok: o.key } });
      var row = lrow("offer", [
        el("label", { className: "lname", "for": id }, [o.label, el("span", { className: "lreal", id: id + "-real" })]),
        unitWrap(inp, "money"),
        lval(id + "-line")
      ]);
      row.id = id + "-row";
      return row;
    });
    host.appendChild(lgroup("Padded costs", null, rows));
    host.appendChild(lgroup("Offer-only lines", null, [
      el("p", { className: "hint", text: "Costs only the offer shows, like a production manager or backline." }),
      el("div", { className: "custom-list", id: "offer-extra-list" }),
      el("div", {}, [el("button", { type: "button", className: "small", id: "btn-add-offer-line", text: "Add offer-only line" })])
    ], "offer-extra-total", "Offer-only lines subtotal"));
    host.appendChild(el("div", { className: "lgroup" }, [
      lrow("", [el("span", { text: "Contingency on what the offer adds" }), lval("offer-cont")]),
      lrow("total grand", [el("span", { text: "The offer adds to costs" }), lval("offer-delta")])
    ]));
  }
  function renderOfferExtra() {
    var list = $("offer-extra-list");
    list.textContent = "";
    state.inputs.offerExtra.forEach(function (r, i) {
      var nameId = "offer-x-name-" + i, amtId = "offer-x-amount-" + i;
      var name = el("input", { type: "text", id: nameId, placeholder: "e.g. Production manager", autocomplete: "off", dataset: { oi: i, of: "name" } });
      name.value = r.name;
      var amt = el("input", { type: "number", id: amtId, min: "0", step: "1", inputmode: "decimal", dataset: { oi: i, of: "amount" } });
      amt.value = r.amount;
      var rm = el("button", { type: "button", className: "small", id: "offer-x-remove-" + i, dataset: { oremove: i }, "aria-label": "Remove offer-only line " + (i + 1), text: "Remove" });
      list.appendChild(el("div", { className: "custom-row" }, [
        el("label", { className: "sr-only", "for": nameId, text: "Offer-only line " + (i + 1) + " name" }), name,
        el("label", { className: "sr-only", "for": amtId, text: "Offer-only line " + (i + 1) + " amount" }), unitWrap(amt, "money"), rm
      ]));
    });
  }
  function syncOffer() {
    X.OFFER_ROWS.forEach(function (o) {
      var v = state.inputs.offerAmounts[o.key];
      $("offer-" + o.key).value = v === undefined ? "" : v;
    });
    renderOfferExtra();
  }
  function renderOffer(b) {
    var inp = b.inp, r = b.r, C = { cents: true };
    var offer = M.offerInputs(inp);
    var ro = M.compute(offer, r.n), so = M.compute(offer, b.S);
    var beO = M.breakEven(offer);
    X.OFFER_ROWS.forEach(function (o) {
      var on = o.on(inp), mult = o.mult(inp), id = "offer-" + o.key;
      $(id + "-row").hidden = !on;
      $(id).placeholder = String(inp[o.key]);
      $(id + "-real").textContent = "Yours: " + fmt$(inp[o.key], C) + (mult !== 1 ? " x " + mult : "");
      $(id + "-line").textContent = fmt$(offer[o.key] * mult, C);
    });
    var extra = inp.offerExtra.reduce(function (s, x) { return s + x.amount; }, 0);
    $("offer-extra-total").textContent = fmt$(extra, C);
    var added = ro.fixedCostsTotal - r.fixedCostsTotal;
    $("offer-cont").textContent = fmt$(ro.contingency - r.contingency, C);
    $("offer-delta").textContent = (added >= 0.005 ? "+" : "") + fmt$(added, C);
    $("offer-delta").previousSibling.textContent = added < -0.005 ? "The offer takes off costs" : "The offer adds to costs";
    $("offer-sub").textContent = "At " + r.n + " tickets and sold out";
    function beText(v) { return v === null ? "Not possible" : v + " tickets"; }
    var rows = [
      ["Total costs at " + r.n + " tickets", fmt$(r.totalCosts), fmt$(ro.totalCosts)],
      ["Net at " + r.n + " tickets", fmt$(r.net, { plus: true }), fmt$(ro.net, { plus: true })],
      ["Break-even", beText(b.be), beText(beO)],
      ["Headliner pay, sold out", fmt$(b.soldOut.headliner.pay), fmt$(so.headliner.pay)],
      ["Our net, sold out", fmt$(b.soldOut.net, { plus: true }), fmt$(so.net, { plus: true })]
    ];
    var tb = $("offer-table").tBodies[0];
    tb.textContent = "";
    rows.forEach(function (x) {
      tb.appendChild(el("tr", {}, [el("th", { scope: "row", text: x[0] }), el("td", { className: "num", text: x[1] }), el("td", { className: "num", text: x[2] })]));
    });
    var same = Math.abs(added) < 0.005;
    $("sum-offer").textContent = same ? "The offer uses your real costs. Pad any cost below to build the version you send." :
      "The offer " + (added > 0 ? "adds " + fmt$(added) + " to" : "takes " + fmt$(-added) + " off") + " costs: net " + fmt$(ro.net, { plus: true }) + " at " + r.n + " tickets (yours " + fmt$(r.net, { plus: true }) + ").";
    setNav("offer", same ? "same" : (added > 0 ? "+" : MINUS) + fmt$(Math.abs(added)));
  }
  function offerLink() { return X.encodeLink(M.offerInputs(state.inputs), state.n, M); }

  function buildInputs() {
    SECTIONS.forEach(function (s) {
      var body = el("div", { className: "group-body" });
      if (s.hint) body.appendChild(el("p", { className: "hint", text: s.hint }));
      s.fields.forEach(function (f) { body.appendChild(buildField(f)); });
      $(s.host).appendChild(el("div", { className: "card group-card", id: s.id }, [el("h3", { text: s.title }), body]));
    });
    buildLedger();
    buildOffer();
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
    syncOffer();
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
    if (t.dataset.ok) {
      if (t.value === "") delete state.inputs.offerAmounts[t.dataset.ok];
      else state.inputs.offerAmounts[t.dataset.ok] = Math.max(0, parseNum(t.value));
      recompute();
      return;
    }
    if (t.dataset.oi !== undefined) {
      var oi = +t.dataset.oi;
      if (!state.inputs.offerExtra[oi]) return;
      state.inputs.offerExtra[oi][t.dataset.of] = t.dataset.of === "name" ? t.value : Math.max(0, parseNum(t.value));
      recompute();
      return;
    }
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
    try { localStorage.setItem(SECTION_KEY, name); } catch (e) { /* storage unavailable */ }
    hideTip();
    if (name === "overview" && last) { renderChart(last); renderMoneyBar(last.r); }
    if (name === "share") { preloadExcel(); if (googleReady()) G.preload(); } // fetch libraries before the tap
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
    window.addEventListener("hashchange", function () {
      if (openFromHash()) return;
      showSection(sectionFromHash() || "overview");
    });
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
      var d = e.target.dataset;
      if (d && (d.k || d.ci !== undefined || d.ok || d.oi !== undefined)) onControl(e);
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
    $("offer-ledger").addEventListener("click", function (e) {
      var t = e.target;
      if (t.id === "btn-add-offer-line") {
        state.inputs.offerExtra.push({ name: "", amount: 0 });
        renderOfferExtra();
        $("offer-x-name-" + (state.inputs.offerExtra.length - 1)).focus();
        recompute();
      } else if (t.dataset && t.dataset.oremove !== undefined) {
        var idx = +t.dataset.oremove;
        state.inputs.offerExtra.splice(idx, 1);
        renderOfferExtra();
        var next = $("offer-x-name-" + Math.min(idx, state.inputs.offerExtra.length - 1)) || $("btn-add-offer-line");
        next.focus();
        recompute();
      }
    });
    $("btn-copy-offer-link").addEventListener("click", function () { copyText(offerLink(), "Offer link copied. It opens the padded numbers as their own scenario."); });
    $("btn-copy-summary").addEventListener("click", function () { copyText(summaryText(), "Summary copied. Paste it in Discord or a text."); });
    $("btn-copy-link").addEventListener("click", copyLink);
    $("btn-copy-link-top").addEventListener("click", copyLink);
    $("btn-undo-shared").addEventListener("click", undoShared);
    $("btn-close-banner").addEventListener("click", hideBanner);
    $("btn-gsheet").addEventListener("click", onOpenInSheets);
    $("btn-save").addEventListener("click", function () { onSave(false); });
    $("btn-save-new").addEventListener("click", function () { onSave(true); });
    $("btn-copy-saved").addEventListener("click", function () { if (savedFile) copyText(G.fileLink(savedFile.id), "Saved scenario link copied."); });
    $("btn-list-saved").addEventListener("click", onListSaved);
    $("saved-list").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.open) openSavedFile(b.dataset.open);
      else if (b.dataset.copy) copyText(G.fileLink(b.dataset.copy), "Saved scenario link copied.");
    });
    $("btn-load").addEventListener("click", loadFromBox);
    $("btn-export").addEventListener("click", onExport);
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
      setSavedFile(null);
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
  var toastTimer = null;
  function showMsg(text, kind) {
    var m = $("share-msg");
    m.textContent = text;
    m.className = "msg" + (kind ? " " + kind : "");
    if (current !== "share") toast(text, kind);
  }
  function toast(text, kind) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast" + (kind === "err" ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function touchFirst() { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); }
  function currentLink() { return X.encodeLink(state.inputs, state.n, M); }
  function scenarioTitle(inp) {
    var show = String(inp.showName || "").trim(), venue = String(inp.venueName || "").trim() || "New venue";
    return (show ? show + " at " : "") + venue;
  }
  function copyLink() {
    var url = currentLink();
    if (touchFirst() && navigator.share) {
      navigator.share({ title: scenarioTitle(state.inputs), url: url }).catch(function (err) {
        if (!err || err.name !== "AbortError") copyText(url, "Link copied. Anyone who opens it sees this exact scenario.");
      });
      return;
    }
    copyText(url, "Link copied. Anyone who opens it sees this exact scenario.");
  }
  function copyText(text, okMsg) {
    var fb = $("copy-fallback"), ta = $("copy-fallback-text");
    function fallback() {
      fb.hidden = false;
      ta.value = text;
      ta.focus();
      ta.select();
      if (current !== "share") location.hash = "#share";
      showMsg("Your browser blocked copying. The text is selected below; copy it with Ctrl+C or Cmd+C.", "err");
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { fb.hidden = true; showMsg(okMsg, "ok"); }, fallback);
      } else fallback();
    } catch (err) { fallback(); }
  }
  function applyScenario(obj) {
    if (!obj || typeof obj !== "object" || !obj.inputs || typeof obj.inputs !== "object") throw new Error("shape");
    state.inputs = M.sanitize(obj.inputs);
    var S = M.sellable(state.inputs);
    var n = parseNum(obj.n);
    state.nWant = state.n = clamp(Math.round(isFinite(n) ? n : M.expectedTickets(state.inputs)), 0, S);
  }
  // Opening someone else's scenario keeps yours one click away ("Go back to mine").
  var UNDO_KEY = "kcplur-show-feasibility-undo";
  var undoState = null;
  function setUndo(v) {
    undoState = v;
    try { if (v) localStorage.setItem(UNDO_KEY, JSON.stringify(v)); else localStorage.removeItem(UNDO_KEY); } catch (e) { /* storage unavailable */ }
  }
  function showBanner(text) {
    $("shared-banner-text").textContent = text;
    $("btn-undo-shared").hidden = !undoState;
    $("shared-banner").hidden = false;
  }
  // After a refresh, keep offering the way back until the visitor dismisses it.
  function restoreUndo() {
    try { var raw = localStorage.getItem(UNDO_KEY); if (raw) undoState = JSON.parse(raw); } catch (e) { undoState = null; }
    if (undoState && undoState.inputs) showBanner("You're looking at a scenario someone shared: " + scenarioTitle(state.inputs) + ".");
    else undoState = null;
  }
  function snapshotState() { return { inputs: JSON.parse(JSON.stringify(state.inputs)), n: state.nWant, saved: savedFile }; }
  function openShared(obj, label) {
    var before = snapshotState();
    applyScenario({ inputs: obj.inputs, n: obj.n });
    if (!undoState) setUndo(before); // first open keeps the visitor's own scenario
    setSavedFile(null); // a saved file sets itself again after this
    syncControls();
    recompute();
    showBanner((label || "Opened a shared scenario") + ": " + scenarioTitle(state.inputs) + ".");
  }
  function undoShared() {
    if (!undoState) return hideBanner();
    applyScenario(undoState);
    setSavedFile(undoState.saved || null);
    setUndo(null);
    syncControls();
    recompute();
    hideBanner();
    toast("Back to your own scenario.", "ok");
  }
  function hideBanner() { $("shared-banner").hidden = true; setUndo(null); }
  // Handles #s= (share link), #q= (readable link from the spreadsheet) and #f= (saved file) text. Returns true when it was one of those.
  function openLinkText(h) {
    if (!/^#?(s|f|q)=/.test(h || "")) return false;
    var got = X.decodeShared(h, M);
    if (!got) toast("That link didn't open. Check that you copied all of it.", "err");
    else if (got.fileId) openSavedFile(got.fileId);
    else openShared(got);
    return true;
  }
  // A link pasted into the address bar while the page is open.
  function openFromHash() {
    var h = location.hash || "";
    if (!openLinkText(h)) return false;
    try { history.replaceState(null, "", location.pathname + location.search + "#" + (current || "overview")); } catch (e) { /* old browsers */ }
    return true;
  }
  // ---------------------------------------------------------------- Google: saved scenarios and Sheets
  var SAVED_KEY = "kcplur-show-feasibility-saved";
  var savedFile = null; // { id, name } of the saved scenario this page is showing, if any
  function googleReady() { return !!(G && G.configured()); }
  function setSavedFile(f) {
    savedFile = f && f.id ? { id: f.id, name: f.name } : null;
    try { if (savedFile) localStorage.setItem(SAVED_KEY, JSON.stringify(savedFile)); else localStorage.removeItem(SAVED_KEY); } catch (e) { /* storage unavailable */ }
    renderSavedUI();
  }
  function restoreSavedFile() {
    try { var f = JSON.parse(localStorage.getItem(SAVED_KEY) || "null"); savedFile = f && f.id ? f : null; } catch (e) { savedFile = null; }
  }
  function initGoogleUI() {
    var ready = googleReady();
    document.querySelectorAll(".google-only").forEach(function (e) { e.hidden = !ready; });
    renderSavedUI();
  }
  function renderSavedUI() {
    if (!googleReady()) return;
    var linked = !!savedFile;
    $("saved-current").hidden = !linked;
    $("saved-current").textContent = linked ? "Showing saved scenario: " + savedFile.name : "";
    $("btn-save").textContent = linked ? "Save changes" : "Save";
    $("btn-save-new").hidden = !linked;
    $("saved-link-field").hidden = !linked;
    $("saved-link").value = linked ? G.fileLink(savedFile.id) : "";
    if (linked) $("save-name").value = savedFile.name;
    else if (!$("save-name").value) $("save-name").placeholder = scenarioTitle(state.inputs);
  }
  function savedMsg(text, kind) {
    var m = $("saved-msg");
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }
  function googleErrorText(e) {
    if (e && (e.code === "popup" || e.code === "signin")) return e.message;
    if (e && e.status === 401) return "Your Google sign-in expired. Try again.";
    if (e && e.status === 403) return "Google said no: " + (e.message || "no access") + ".";
    if (e && e.status) return "Google answered with an error (" + e.status + "). Try again.";
    return "Couldn't reach Google. Check your connection and try again.";
  }
  function openSavedFile(fileId) {
    if (!googleReady()) { toast("Saved scenarios aren't set up on this page yet.", "err"); return; }
    toast("Opening the saved scenario…");
    G.loadScenario(fileId).then(function (raw) {
      var p = G.parsePayload(raw, M);
      if (!p) throw new Error("not a scenario");
      openShared({ inputs: p.inputs, n: p.n }, "Opened saved scenario");
      setSavedFile({ id: fileId, name: p.name });
      toast("Opened " + p.name + ".", "ok");
    }).catch(function (e) {
      toast(e && (e.status === 404 || e.status === 403) ? "That saved scenario isn't shared, or it was deleted." :
        e && e.message === "not a scenario" ? "That file isn't a saved scenario." :
        e && e.status ? "Google couldn't open that saved scenario: " + e.message :
        "Couldn't open that saved scenario. Check your connection and try again.", "err");
    });
  }
  function onSave(asNew) {
    var name = $("save-name").value.trim() || scenarioTitle(state.inputs);
    var target = asNew || !savedFile ? null : savedFile.id;
    var payload = G.buildPayload(state.inputs, state.n, name, M);
    savedMsg(G.hasToken() ? "Saving…" : "Sign in to Google in the window that opens…");
    G.ensureToken().then(function () {
      savedMsg("Saving…");
      return G.saveScenario(payload, target);
    }).then(function (res) {
      setSavedFile({ id: res.id, name: name });
      savedMsg(res.copied ? "You can't save over that one, so it was saved as your own copy with a new link." :
        target ? "Saved changes. The link stays the same." : "Saved. Copy the link below to share it.", "ok");
    }).catch(function (e) { savedMsg(googleErrorText(e), "err"); });
  }
  function onListSaved() {
    var list = $("saved-list");
    savedMsg(G.hasToken() ? "Loading…" : "Sign in to Google in the window that opens…");
    G.ensureToken().then(function () { savedMsg("Loading…"); return G.listSaved(); }).then(function (files) {
      list.textContent = "";
      files.forEach(function (f) {
        list.appendChild(el("li", {}, [
          el("span", { className: "saved-name", text: f.name }),
          el("span", { className: "saved-date", text: new Date(f.modifiedTime).toLocaleDateString() }),
          el("button", { type: "button", className: "small", dataset: { open: f.id }, "aria-label": "Open " + f.name, text: "Open" }),
          el("button", { type: "button", className: "small", dataset: { copy: f.id }, "aria-label": "Copy link to " + f.name, text: "Copy link" })
        ]));
      });
      list.hidden = !files.length;
      savedMsg(files.length ? "" : "Nothing saved from this page yet.");
    }).catch(function (e) { savedMsg(googleErrorText(e), "err"); });
  }
  // Build the same workbook as the download, upload it to Drive as a Google Sheet, and open it.
  function onOpenInSheets() {
    if (exporting || !last) return;
    var btn = $("btn-gsheet");
    var inputs = M.sanitize(state.inputs), n = state.n, date = X.localDate(new Date());
    var name = X.fileName(inputs, date);
    // Already signed in: open the tab inside this click so pop-up blockers allow it.
    var win = null;
    if (G.hasToken()) {
      win = window.open("", "_blank");
      if (win) { try { win.opener = null; win.document.title = "Creating your Google Sheet…"; win.document.body.textContent = "Creating your Google Sheet…"; } catch (e) { /* cross-origin */ } }
    }
    exporting = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    $("export-ready").hidden = true;
    exportMsg(G.hasToken() ? "Creating your Google Sheet…" : "Sign in to Google in the window that opens…", "");
    function release() { exporting = false; btn.disabled = false; btn.removeAttribute("aria-busy"); }
    var sheets = null;
    G.ensureToken().then(function () {
      exportMsg("Creating your Google Sheet…", "");
      return loadExcel();
    }).then(function (ExcelJS) {
      sheets = WB.buildSheets(inputs, n, M, { date: date });
      return WB.writeWorkbook(ExcelJS, sheets).xlsx.writeBuffer();
    }).then(function (buf) {
      return G.uploadAsSheet(new Blob([buf], { type: XLSX_MIME }), name);
    }).then(function (res) {
      // Lock (warning only) and chart; the sheet still works without them.
      return G.decorateSheet(res.id, WB.decorations(sheets)).catch(function (e) {
        if (window.console) console.warn("Google Sheets lock and chart:", e);
        res.undecorated = true;
      }).then(function () { return res; });
    }).then(function (res) {
      var box = $("export-ready");
      box.textContent = "";
      box.appendChild(el("a", { href: res.url, target: "_blank", rel: "noopener" }, ["Open your Google Sheet"]));
      box.hidden = false;
      var extra = res.undecorated ? " (The formula lock and the profit chart couldn't be added; the sheet still works.)" : "";
      if (win && !win.closed) { win.location.href = res.url; exportMsg("Your Google Sheet is open in a new tab." + extra, "ok"); }
      else exportMsg("Your Google Sheet is ready in your Drive." + extra, "ok");
    }).catch(function (e) {
      if (win && !win.closed) win.close();
      exportMsg(e && e.message === "ExcelJS failed to load" ? "Couldn't load the spreadsheet library. Check your connection and try again." : googleErrorText(e), "err");
      if (window.console) console.warn("Google Sheets:", e);
    }).then(release);
  }
  function loadFromBox() {
    var raw = $("load-code").value;
    if (!raw.trim()) { showMsg("Paste a link or scenario code into the box first.", "err"); return; }
    var got = X.decodeShared(raw, M);
    if (!got) { showMsg("That didn't open. Check that you copied the whole link or code, with nothing extra.", "err"); return; }
    if (got.fileId) { openSavedFile(got.fileId); return; }
    openShared(got, got.kind === "code" ? "Opened a scenario code" : "Opened a shared scenario");
    $("load-code").value = "";
    showMsg("Opened.", "ok");
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
      (inp.ebCapOn ? ", capped at " + fmt$(inp.ebCap, { cents: true }) + "/ticket" : "") +
      "; " + inp.onlinePct + "% online");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- spreadsheet export
  // ExcelJS is large (~950 KB), so it is injected the first time the Share tab opens, not on page load.
  var EXCELJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
  var XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  var excelPromise = null, exportUrl = null, exporting = false;
  function loadExcel() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (excelPromise) return excelPromise;
    var tag = document.createElement("script");
    excelPromise = new Promise(function (resolve, reject) {
      tag.src = EXCELJS_URL;
      tag.async = true;
      tag.onload = function () { if (window.ExcelJS) resolve(window.ExcelJS); else reject(new Error("ExcelJS missing")); };
      tag.onerror = function () { reject(new Error("ExcelJS failed to load")); };
      document.head.appendChild(tag);
    }).catch(function (err) {
      // Forget the failed attempt so the next tap tries again.
      excelPromise = null;
      if (tag.parentNode) tag.parentNode.removeChild(tag);
      throw err;
    });
    return excelPromise;
  }
  function preloadExcel() { loadExcel().catch(function () { /* reported if the user taps Export */ }); }
  function exportMsg(text, kind) {
    var m = $("export-msg");
    m.hidden = !text;
    m.textContent = text;
    m.className = "msg" + (kind ? " " + kind : "");
  }
  function showReadyLink(blob, name) {
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(blob);
    var box = $("export-ready");
    box.textContent = "";
    box.appendChild(el("a", { href: exportUrl, download: name, id: "export-link" }, ["Spreadsheet ready: " + name + ". Tap here if it didn't save."]));
    box.hidden = false;
  }
  function saveFile(blob, name) {
    var file = null;
    try { file = new File([blob], name, { type: XLSX_MIME }); } catch (e) { file = null; }
    // Share sheet on phones and tablets only: on a desktop a plain download is what people expect.
    var touchFirst = false;
    try { touchFirst = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) { touchFirst = false; }
    var canShareFile = false;
    try { canShareFile = !!(touchFirst && file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { canShareFile = false; }
    if (canShareFile) {
      // The path that works on iPhone. The promise settles only when the share sheet closes.
      exportMsg("Spreadsheet ready. Pick where to save it.", "ok");
      return navigator.share({ files: [file], title: name }).then(function () {
        exportMsg("Spreadsheet ready: " + name + ".", "ok");
      }, function (err) {
        if (err && err.name === "AbortError") exportMsg("Spreadsheet ready. Tap the link below whenever you want to save it.", "");
        else if (err && err.name === "NotAllowedError") exportMsg("Spreadsheet ready. Tap the link below to save it.", "ok");
        else exportMsg("Spreadsheet ready. Sharing didn't open; tap the link below to save it.", "ok");
      });
    }
    var a = el("a", { href: exportUrl, download: name, style: "display:none" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    exportMsg("Spreadsheet ready: " + name + ". If nothing downloaded, tap the link below.", "ok");
    return Promise.resolve();
  }
  function onExport() {
    if (exporting || !last) return;
    exporting = true;
    var btn = $("btn-export");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    exportMsg("Preparing spreadsheet…", "");
    // Snapshot now, so edits made while the library loads don't leak into this file.
    var inputs = M.sanitize(state.inputs), n = state.n, date = X.localDate(new Date());
    var name = X.fileName(inputs, date);
    var stage = "load";
    function release() { exporting = false; btn.disabled = false; btn.removeAttribute("aria-busy"); }
    loadExcel().then(function (ExcelJS) {
      stage = "build";
      return WB.writeWorkbook(ExcelJS, WB.buildSheets(inputs, n, M, { date: date })).xlsx.writeBuffer();
    }).then(function (buf) {
      stage = "save";
      var blob = new Blob([buf], { type: XLSX_MIME });
      showReadyLink(blob, name);
      release(); // the share sheet may stay open a long time; the button and link work meanwhile
      return saveFile(blob, name);
    }).catch(function (err) {
      if (stage === "load") exportMsg("Couldn't load the spreadsheet library. Check your connection and try again.", "err");
      else if (stage === "build") exportMsg("Couldn't build the spreadsheet. Try again.", "err");
      else exportMsg("Spreadsheet ready. Tap the link below to save it.", "ok");
      if (window.console) console.warn("Export:", err);
    }).then(release);
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
    last = X.bundle(inp, state.n, M);
    var r = last.r;

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
    renderOffer(last);
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
    $("sum-share").textContent = "Copy a summary or a link, export a spreadsheet, open a link, or reset.";
  }

  // ---------------------------------------------------------------- tiles
  function tile(h, opts) {
    opts = opts || {};
    var t = el("div", { className: "tile tile-" + h.key + (opts.hero ? " hero" : ""), dataset: opts.status ? { status: opts.status } : null });
    t.appendChild(el("span", { className: "tile-label", text: h.label }));
    if (opts.pill) t.appendChild(el("span", { className: "pill", dataset: { status: opts.status }, text: opts.pill }));
    t.appendChild(el("span", { className: "tile-value" + (opts.valueClass ? " " + opts.valueClass : ""), text: h.display || String(h.v) }));
    if (h.sub) t.appendChild(el("span", { className: "tile-sub", text: h.sub }));
    return t;
  }
  function renderTiles(b) {
    var host = $("tiles");
    host.textContent = "";
    X.headlineRows(b).forEach(function (h) {
      if (h.key === "net") host.appendChild(tile(h, { hero: true, status: h.status, pill: STATUS_LABEL[h.status], valueClass: h.status === "loss" ? "loss" : "" }));
      else host.appendChild(tile(h));
    });
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
  var CATS = X.CATS;
  function renderMoney(r) {
    var inflow = r.inflow, loss = r.money.loss, inp = last.inp;
    $("money-sub").textContent = "At " + r.n + " tickets: buyers paid " + fmt$(r.buyersPaid) + (r.otherIncome ? " plus " + fmt$(r.otherIncome) + " other income" : "");
    renderMoneyBar(r);
    var sf = $("money-shortfall");
    if (loss > 0.005) {
      sf.hidden = false;
      sf.textContent = "Shortfall " + fmt$(loss) + ": costs and pass-throughs exceed the " + fmt$(inflow) + " coming in. The marked line shows where the money runs out.";
    } else sf.hidden = true;

    // The table doubles as the bar's key: each row starts with the segment's colour.
    var tb = $("money-table").tBodies[0], C = { cents: true };
    tb.textContent = "";
    X.moneyRows(r, inp).forEach(function (m) {
      var isLoss = m.cls === "loss", isTotal = m.cls === "total";
      var nameKids = [];
      if (m.cat) nameKids.push(el("span", { className: "sw", style: "background:" + m.cat.color, "aria-hidden": "true" }));
      nameKids.push(m.name);
      var nameCell = el("td", { className: isLoss ? "neg" : "" }, [el("span", { className: "mname" }, nameKids)]);
      if (m.detail) { nameCell.appendChild(document.createTextNode(" ")); nameCell.appendChild(el("span", { className: "mdetail", text: m.detail })); }
      var vc = "n" + (isLoss ? " neg" : "");
      tb.appendChild(el("tr", { className: isTotal ? "total" : "" }, [
        nameCell,
        el("td", { className: vc, text: fmt$(m.v, C) }),
        el("td", { className: vc, text: m.share === null ? "" : fmtPct(m.share, 1).replace("-", MINUS) }),
        el("td", { className: vc + " col-pt", text: fmt$(m.perTicket, C) })
      ]));
    });
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
  function renderHeatmap(inp) {
    var hg = X.heatGrid(inp, M);
    var tbl = $("heatmap");
    var thead = tbl.tHead, tbody = tbl.tBodies[0];
    thead.textContent = ""; tbody.textContent = "";
    var hr = el("tr", {}, [el("th", { scope: "col", className: "heat-corner" }, [el("span", { className: "sr-only", text: "Attendance" })])]);
    hg.prices.forEach(function (p) {
      hr.appendChild(el("th", { scope: "col", className: Math.abs(p - inp.price) < 0.005 ? "here" : "", text: "$" + p }));
    });
    thead.appendChild(hr);
    hg.rows.forEach(function (row) {
      // Label stacks as "75%" over "109 tix" on phones; one line on wider screens.
      var tr = el("tr", {}, [el("th", { scope: "row", className: row.n === state.n ? "here" : "" }, [
        el("span", { className: "hl-pct", text: row.p + "%" }), el("span", { className: "hl-sep", text: " · " }), el("span", { className: "hl-n", text: row.n + " tix" })
      ])]);
      row.cells.forEach(function (c) {
        var pole = c.net >= 0 ? "var(--div-pos)" : "var(--div-neg)";
        var pct = Math.round(c.t * 100);
        var here = Math.abs(c.price - inp.price) < 0.005 && row.n === state.n;
        var td = el("td", {
          tabindex: "0",
          className: (c.t > 0.55 ? "strong" : "weak") + (here ? " here" : ""),
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
    $("heat-min").textContent = fmtCompact(-hg.maxAbs) + " loss";
    $("heat-max").textContent = "+" + fmtCompact(hg.maxAbs).replace(MINUS, "") + " profit";
  }

  // ---------------------------------------------------------------- tables
  // Shared rows from export.js: { label, v, t, cls, off }. Text values may wrap so labels keep their room.
  function rowText(rw) {
    if (rw.off) return "off";
    if (rw.t === "money") return fmt$(rw.v, { cents: true });
    if (rw.t === "pct") return fmtPct(rw.v, 1);
    return String(rw.v);
  }
  function fillRows(tb, rows) {
    tb.textContent = "";
    rows.forEach(function (rw) {
      tb.appendChild(el("tr", { className: rw.cls || "" }, [
        el("td", { text: rw.label }),
        el("td", { className: "n" + (rw.off ? " off" : "") + (rw.t === "text" && !rw.off ? " wrap" : ""), text: rowText(rw) })
      ]));
    });
  }
  function renderScenarios(b) {
    var tb = $("scenarios").tBodies[0];
    tb.textContent = "";
    $("scen-sub").textContent = "At " + priceText(b.inp.price) + " a ticket";
    X.scenarioRows(b).forEach(function (s) {
      tb.appendChild(el("tr", { className: s.n === state.n ? "current" : "" }, [
        el("td", { className: "nowrap", text: s.sold }),
        el("td", { className: "n", text: String(s.n) }),
        el("td", { className: "n col-ntr", text: fmt$(s.netTix) }),
        el("td", { className: "n col-hl", text: fmt$(s.hlPay) }),
        el("td", { className: "n", text: fmt$(s.costs) }),
        el("td", { className: "n " + signClass(s.net), text: fmt$(s.net, { plus: true }) })
      ]));
    });
  }
  function renderHeadliner(b) {
    $("hl-sub").textContent = "At " + b.r.n + " tickets";
    fillRows($("hl-table").tBodies[0], X.headlinerRows(b.r, b.inp, b.hlBE));
  }
  function renderTalent(b) {
    $("talent-sub").textContent = "At " + b.r.n + " tickets";
    fillRows($("talent-table").tBodies[0], X.talentRows(b.r, b.inp));
  }
  function renderVenue(b) {
    var r = b.r, inp = b.inp, tb = $("venue-table").tBodies[0], C = { cents: true };
    tb.textContent = "";
    $("venue-sub").textContent = venueDescription(inp);
    $("venue-col-now").textContent = "At " + r.n + " tickets";
    $("venue-col-out").textContent = "Sold out (" + b.S + ")";
    X.venueRows(r, b.soldOut, inp).forEach(function (v) {
      tb.appendChild(el("tr", { className: v.cls || "" }, [
        el("td", { text: v.label }),
        el("td", { className: "n" + (v.on ? "" : " off"), text: v.on ? fmt$(v.now, C) : "off" }),
        el("td", { className: "n" + (v.on ? "" : " off"), text: v.on ? fmt$(v.out, C) : "off" })
      ]));
    });
  }
  function renderPerTicket(r, inp) {
    var p = r.perTicketPrices, C = { cents: true };
    $("pt-sub").textContent = fmt$(inp.price, C) + " face price" + (inp.doorPriceOn ? ", " + fmt$(p.doorPrice, C) + " at the door" : "");
    fillRows($("pt-table").tBodies[0], X.perTicketRows(r, inp));
  }
  function renderTicketMoney(r, inp) {
    $("tm-sub").textContent = r.n + " sold + " + inp.comps + " comps = " + (r.n + inp.comps) + " attending";
    fillRows($("tm-table").tBodies[0], X.ticketMoneyRows(r, inp));
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
    set("led-soundTechs", L.soundTechs, inp.soundTechsOn);
    set("led-stagehands", L.stagehands, inp.stagehandsOn);
    set("led-labor", L.soundTechs + L.stagehands);
    set("led-production", L.security + L.sound + L.gear + L.photo);
    set("led-marketing", L.ads + L.poster);
    set("led-insurance", L.insurance);
    set("led-custom", L.custom);
    set("led-contingency", r.contingency);
    $("led-contingency").title = inp.contingencyPct + "% of " + fmt$(r.contingencyBase, C);
    set("led-total", r.totalCosts);
    $("led-total-2").textContent = MINUS + fmt$(r.totalCosts, C);
    set("led-nettix", r.netTicketRevenue);
    $("led-net-label").textContent = "Net at " + r.n + " tickets";
    var nv = $("led-net");
    nv.textContent = fmt$(r.net, { cents: true, plus: true });
    nv.className = "lval " + signClass(r.net);
    $("net-sub").textContent = "At " + r.n + " tickets";
    $("cat-sub").textContent = "At " + r.n + " tickets";
    fillRows($("cat-table").tBodies[0], X.costCategoryRows(r));
  }

  // ---------------------------------------------------------------- start
  restore();
  restoreSavedFile();
  buildInputs();
  syncControls();
  wire();
  trackVerdictHeight();
  initGoogleUI();
  var linkHash = /^#(s|f|q)=/.test(location.hash || "") ? location.hash : null;
  initSections(); // replaces a link hash with the section name, so a refresh keeps the visitor's edits
  if (linkHash) openLinkText(linkHash); else restoreUndo();
  recompute();
})();
