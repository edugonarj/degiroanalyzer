/**
 * app.js — Orquestación: carga del archivo, descarga de precios,
 * cálculo de métricas y render del dashboard.
 */
"use strict";

(function () {
  const DG = window.DG;
  const $ = id => document.getElementById(id);

  const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  const EUR0 = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const PCT = v => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");

  const ctx = {
    state: null, twr: null, valueSeries: null,
    benchSeries: new Map(), visibleBench: new Set(),
    priceProviders: new Map(), fxSeries: new Map(),
    productRows: [], range: null, warnings: [],
  };

  // ---------- carga de archivo ----------
  const dz = $("dropZone");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  $("fileInput").addEventListener("change", e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  function log(msg) {
    $("loadStatus").classList.remove("hidden");
    $("loadLog").textContent = msg;
  }

  async function handleFile(file) {
    try {
      log("Leyendo " + file.name + "…");
      const buf = await file.arrayBuffer();
      const { events, warnings } = DG.parseAccountFile(buf);
      ctx.warnings = warnings;
      log(`${events.length} movimientos leídos. Reconstruyendo cartera…`);
      ctx.state = DG.replay(events);

      log("Descargando precios históricos (Yahoo Finance)…");
      await loadAllPrices();

      log("Calculando métricas…");
      compute();
      render();
      $("uploadView").classList.add("hidden");
      $("dashboard").classList.remove("hidden");
    } catch (err) {
      console.error(err);
      log("Error: " + err.message + "\nRevisa que el archivo sea el export de 'Estado de cuenta' de DEGIRO.");
    }
  }

  // ---------- precios ----------
  async function loadAllPrices() {
    const st = ctx.state;
    const from = st.firstDate;

    // divisas necesarias
    const fxJobs = [...st.currencies].filter(c => c !== "EUR").map(async c => {
      try { ctx.fxSeries.set(c, await DG.fetchFxSeries(c, from)); }
      catch { ctx.warnings.push("Sin serie FX para " + c); }
    });

    // benchmarks
    const benchJobs = DG.BENCHMARKS.map(async b => {
      try {
        const { map } = await DG.fetchYahooSeries(b.symbol, from);
        ctx.benchSeries.set(b.id, { label: b.label, color: b.color, map });
        if (b.on) ctx.visibleBench.add(b.id);
      } catch {
        ctx.benchSeries.set(b.id, { label: b.label, color: b.color, map: null });
        ctx.warnings.push("Índice no disponible: " + b.label);
      }
    });

    // productos: los que han tenido posición en algún momento
    const isins = [...st.products.keys()];
    const prodJobs = isins.map(async isin => {
      const fbPoints = st.tradePricePoints.get(isin) || [];
      const fb = fbPoints.length ? DG.tradeFallbackSeries(fbPoints) : null;
      let symbol = DG.ISIN_TO_YAHOO[isin];
      const stillOpen = Math.abs(st.products.get(isin).qty) > 1e-9;
      if (!symbol && stillOpen) symbol = await DG.searchYahooByISIN(isin);
      if (symbol) {
        try {
          const { map, meta } = await DG.fetchYahooSeries(symbol, from);
          ctx.priceProviders.set(isin, { kind: "yahoo", map, meta, fb });
          return;
        } catch { /* fallback below */ }
      }
      if (fb) {
        ctx.priceProviders.set(isin, { kind: "fallback", fb });
        if (stillOpen) ctx.warnings.push("Sin cotización online para " + st.products.get(isin).name + " — usando precios de tus operaciones.");
      }
    });

    await Promise.allSettled([...fxJobs, ...benchJobs, ...prodJobs]);
  }

  // ---------- métricas ----------
  function compute() {
    const st = ctx.state;
    DG.resolvePending(st, ctx.fxSeries);
    const { series, missingPrices } = DG.buildValueSeries(st, ctx.priceProviders, ctx.fxSeries);
    ctx.valueSeries = series;
    for (const isin of missingPrices) {
      const p = st.products.get(isin);
      if (p && Math.abs(p.qty) > 1e-9) ctx.warnings.push("Sin precio en parte del histórico: " + p.name);
    }
    ctx.twr = DG.buildTWR(series, st.flows);
    const lastDay = series[series.length - 1].day;
    ctx.productRows = DG.productPnL(st, ctx.priceProviders, ctx.fxSeries, lastDay);
    ctx.moneySeries = DG.buildMoneySeries(series, st.flows);
    ctx.range = { from: series[0].day, to: lastDay };
  }

  // ---------- render ----------
  function render() {
    const st = ctx.state;
    const series = ctx.valueSeries;
    const last = series[series.length - 1];
    const netDeposits = st.totals.deposits + st.totals.withdrawals;
    const totalGain = last.value - netDeposits;
    const twrTotal = ctx.twr[ctx.twr.length - 1].index / 100 - 1;
    const irr = DG.xirr(st.flows, last.value, st.lastDate);

    $("topbarInfo").textContent =
      `${DG.dayKey(st.firstDate)} → ${DG.dayKey(st.lastDate)} · ${st.products.size} productos`;

    const cards = [
      { label: "Valor de la cartera", value: EUR.format(last.value), sub: "efectivo: " + EUR.format(last.cash) },
      { label: "Aportado neto", value: EUR0.format(netDeposits), sub: `ingresos ${EUR0.format(st.totals.deposits)} · retiradas ${EUR0.format(-st.totals.withdrawals)}` },
      { label: "Ganancia total", value: EUR0.format(totalGain), cls: totalGain >= 0 ? "pos" : "neg", sub: PCT(netDeposits > 0 ? totalGain / netDeposits : null) + " sobre aportado" },
      { label: "Rentabilidad anualizada", value: irr != null ? PCT(irr) : "—", cls: (irr ?? 0) >= 0 ? "pos" : "neg", sub: "XIRR (ponderada por dinero)" },
      { label: "Rentabilidad acumulada", value: PCT(twrTotal), cls: twrTotal >= 0 ? "pos" : "neg", sub: "TWR (comparable con índices)" },
      { label: "Dividendos + préstamo", value: EUR0.format(st.totals.dividendsEUR + st.totals.lendingEUR), sub: "comisiones: " + EUR0.format(st.totals.fees) },
    ];
    $("summaryCards").innerHTML = cards.map(c =>
      `<div class="card"><div class="label">${c.label}</div><div class="value ${c.cls || ""}">${c.value}</div><div class="sub">${c.sub || ""}</div></div>`
    ).join("");

    renderBenchToggles();
    drawPerf();
    DG.renderMoneyChart(ctx.moneySeries);
    renderTable("open");
    renderWarnings();

    $("rangeStart").value = ctx.range.from;
    $("rangeEnd").value = ctx.range.to;
  }

  function renderBenchToggles() {
    const el = $("benchToggles");
    el.innerHTML = "";
    for (const b of DG.BENCHMARKS) {
      const s = ctx.benchSeries.get(b.id);
      const div = document.createElement("div");
      const avail = s && s.map;
      div.className = "toggle" + (avail ? (ctx.visibleBench.has(b.id) ? "" : " off") : " unavailable");
      div.innerHTML = `<span class="dot" style="background:${b.color}"></span>${b.label}`;
      if (avail) {
        div.onclick = () => {
          if (ctx.visibleBench.has(b.id)) ctx.visibleBench.delete(b.id);
          else ctx.visibleBench.add(b.id);
          div.classList.toggle("off");
          drawPerf();
        };
      } else {
        div.title = "No disponible en Yahoo Finance";
      }
      el.appendChild(div);
    }
    // toggle de la propia cartera no: siempre visible
  }

  function drawPerf() {
    DG.renderPerfChart(ctx.twr, ctx.benchSeries, ctx.visibleBench, ctx.range);
  }

  // rangos
  document.querySelectorAll("#presetBtns button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#presetBtns button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const to = ctx.valueSeries[ctx.valueSeries.length - 1].day;
      const toD = new Date(to + "T00:00:00Z");
      let fromD = new Date(toD);
      switch (btn.dataset.range) {
        case "1m": fromD.setUTCMonth(fromD.getUTCMonth() - 1); break;
        case "6m": fromD.setUTCMonth(fromD.getUTCMonth() - 6); break;
        case "ytd": fromD = new Date(Date.UTC(toD.getUTCFullYear(), 0, 1)); break;
        case "1y": fromD.setUTCFullYear(fromD.getUTCFullYear() - 1); break;
        case "3y": fromD.setUTCFullYear(fromD.getUTCFullYear() - 3); break;
        case "5y": fromD.setUTCFullYear(fromD.getUTCFullYear() - 5); break;
        default: fromD = new Date(ctx.valueSeries[0].day + "T00:00:00Z");
      }
      const from = fromD.toISOString().slice(0, 10);
      ctx.range = { from: from < ctx.valueSeries[0].day ? ctx.valueSeries[0].day : from, to };
      $("rangeStart").value = ctx.range.from;
      $("rangeEnd").value = ctx.range.to;
      drawPerf();
    };
  });

  function onCustomRange() {
    const from = $("rangeStart").value, to = $("rangeEnd").value;
    if (!from || !to || from >= to) return;
    document.querySelectorAll("#presetBtns button").forEach(b => b.classList.remove("active"));
    ctx.range = { from, to };
    drawPerf();
  }
  $("rangeStart").addEventListener("change", onCustomRange);
  $("rangeEnd").addEventListener("change", onCustomRange);

  // tabla
  let currentTab = "open";
  function renderTable(tab) {
    currentTab = tab;
    for (const [id, t] of [["tabOpen", "open"], ["tabClosed", "closed"], ["tabAll", "all"]]) {
      $(id).classList.toggle("active", t === tab);
    }
    const rows = ctx.productRows.filter(r =>
      tab === "all" ? true : tab === "open" ? r.open : !r.open
    );
    const tbody = document.querySelector("#productTable tbody");
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="prod" title="${r.isin}">${r.name}</td>
        <td class="num">${r.open ? r.qty.toLocaleString("es-ES", { maximumFractionDigits: 4 }) : "—"}</td>
        <td class="num">${r.open ? EUR.format(r.value) : "—"}</td>
        <td class="num">${EUR.format(r.invested)}</td>
        <td class="num">${EUR.format(r.received)}</td>
        <td class="num">${r.dividends ? EUR.format(r.dividends) : "—"}</td>
        <td class="num ${r.pnl >= 0 ? "pos" : "neg"}"><b>${(r.pnl >= 0 ? "+" : "") + EUR.format(r.pnl)}</b></td>
        <td class="num ${r.pnl >= 0 ? "pos" : "neg"}">${PCT(r.pct)}</td>
      </tr>`).join("");
  }
  $("tabOpen").onclick = () => renderTable("open");
  $("tabClosed").onclick = () => renderTable("closed");
  $("tabAll").onclick = () => renderTable("all");

  function renderWarnings() {
    const uniq = [...new Set(ctx.warnings)];
    if (!uniq.length) return;
    $("warnPanel").classList.remove("hidden");
    $("warnList").innerHTML = uniq.map(w => `<li>${w}</li>`).join("");
  }
})();
