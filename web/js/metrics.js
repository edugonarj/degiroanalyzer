/**
 * metrics.js — Cálculo de la serie de valor de cartera, rentabilidad
 * ponderada por tiempo (TWR), rentabilidad anualizada (XIRR) y P/G por producto.
 */
"use strict";

(function () {
  const DG = window.DG;

  /** Lista de días naturales entre dos fechas (incluidas). */
  function dayRange(from, to) {
    const out = [];
    const d = new Date(from);
    while (d <= to) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  /**
   * Convierte a EUR los movimientos pendientes en divisa extranjera
   * (dividendos y trades sin leg FX) usando las series FX y los aplica
   * a los agregados por producto y totales. Llamar una sola vez.
   */
  DG.resolvePending = function (state, fxSeries) {
    for (const pend of state.totals.divPending) {
      const fx = DG.seriesAt(fxSeries.get(pend.cur), DG.dayKey(pend.date));
      if (!fx) continue;
      const eur = pend.amount / fx;
      const p = pend.isin ? state.products.get(pend.isin) : null;
      if (pend.kind === "dividend") {
        state.totals.dividendsEUR += eur;
        if (p) p.dividends.push({ date: pend.date, eur });
      } else if (pend.kind === "trade" && p) {
        if (eur < 0) p.investedEUR += -eur; else p.receivedEUR += eur;
      }
    }
    state.totals.divPending = [];
  };

  /**
   * Construye la serie diaria de valor de cartera en EUR.
   * @param state resultado de DG.replay
   * @param priceProviders Map isin -> {kind:'yahoo'|'fallback', map?, meta?, fb?}
   * @param fxSeries Map cur -> Map dayKey->rate (EURxxx=X)
   */
  DG.buildValueSeries = function (state, priceProviders, fxSeries) {
    const days = dayRange(state.firstDate, state.lastDate);
    const snaps = state.snapshots;
    const missingPrices = new Set();

    // snapshot vigente para cada día
    let si = 0;
    const series = []; // {day, value, cash, holdings}
    let lastSnap = { positions: {}, cash: {} };

    for (const day of days) {
      while (si < snaps.length && DG.dayKey(snaps[si].date) <= day) {
        lastSnap = snaps[si]; si++;
      }
      let value = 0, cashEUR = 0;

      for (const [cur, amt] of Object.entries(lastSnap.cash)) {
        if (!amt) continue;
        if (cur === "EUR") { cashEUR += amt; continue; }
        const fx = DG.seriesAt(fxSeries.get(cur), day);
        cashEUR += fx ? amt / fx : 0;
      }

      for (const [isin, qty] of Object.entries(lastSnap.positions)) {
        const pp = priceProviders.get(isin);
        if (!pp) { missingPrices.add(isin); continue; }
        let px = null, cur = "EUR";
        if (pp.kind === "yahoo") {
          px = DG.seriesAt(pp.map, day);
          cur = pp.meta.currency || "EUR";
          if (cur === "GBp") { px = px != null ? px / 100 : null; cur = "GBP"; }
        }
        if (px == null && pp.fb) { px = pp.fb.at(day); cur = pp.fb.cur; }
        if (px == null) { missingPrices.add(isin); continue; }
        let eur = qty * px;
        if (cur !== "EUR") {
          const fx = DG.seriesAt(fxSeries.get(cur), day);
          eur = fx ? eur / fx : 0;
        }
        value += eur;
      }
      series.push({ day, value: value + cashEUR, cash: cashEUR });
    }
    return { series, missingPrices: [...missingPrices] };
  };

  /**
   * TWR diaria encadenada, neutralizando flujos externos.
   * Devuelve [{day, index}] con base 100 en el primer día.
   */
  DG.buildTWR = function (series, flows) {
    const flowByDay = new Map();
    for (const f of flows) {
      const k = DG.dayKey(f.date);
      flowByDay.set(k, (flowByDay.get(k) || 0) + f.amount);
    }
    const out = [];
    let idx = 100;
    let prev = null;
    for (const pt of series) {
      if (prev !== null) {
        const flow = flowByDay.get(pt.day) || 0;
        const base = prev + flow; // flujo al inicio del día
        if (base > 1e-9) idx *= pt.value / base;
      }
      out.push({ day: pt.day, index: idx });
      prev = pt.value;
    }
    return out;
  };

  /** XIRR (rentabilidad anualizada ponderada por dinero) por bisección. */
  DG.xirr = function (flows, finalValue, finalDate) {
    // convención: ingreso = flujo negativo para el inversor
    const cfs = flows.map(f => ({ t: f.date.getTime(), v: -f.amount }));
    cfs.push({ t: finalDate.getTime(), v: finalValue });
    const t0 = cfs[0].t;
    const yrs = t => (t - t0) / (365.25 * 86400e3);
    const npv = r => cfs.reduce((s, c) => s + c.v / Math.pow(1 + r, yrs(c.t)), 0);
    let lo = -0.9999, hi = 10;
    if (npv(lo) * npv(hi) > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };

  /** P/G por producto con valor actual. */
  DG.productPnL = function (state, priceProviders, fxSeries, lastDay) {
    const rows = [];
    for (const p of state.products.values()) {
      const open = Math.abs(p.qty) > 1e-9;
      let curValue = 0;
      if (open) {
        const pp = priceProviders.get(p.isin);
        let px = null, cur = "EUR";
        if (pp) {
          if (pp.kind === "yahoo") {
            px = DG.seriesAt(pp.map, lastDay);
            cur = pp.meta.currency || "EUR";
            if (cur === "GBp") { px = px != null ? px / 100 : null; cur = "GBP"; }
          }
          if (px == null && pp.fb) { px = pp.fb.at(lastDay); cur = pp.fb.cur; }
        }
        if (px != null) {
          curValue = p.qty * px;
          if (cur !== "EUR") {
            const fx = DG.seriesAt(fxSeries.get(cur), lastDay);
            curValue = fx ? curValue / fx : 0;
          }
        }
      }
      const divs = p.dividends.reduce((s, d) => s + d.eur, 0);
      const pnl = p.receivedEUR + curValue + divs + p.feesEUR - p.investedEUR;
      const pct = p.investedEUR > 0 ? pnl / p.investedEUR : null;
      rows.push({
        isin: p.isin, name: p.name, qty: p.qty, open,
        invested: p.investedEUR, received: p.receivedEUR,
        dividends: divs, fees: p.feesEUR, value: curValue, pnl, pct,
      });
    }
    rows.sort((a, b) => b.pnl - a.pnl);
    return rows;
  };

  /** Serie mensual: aportación neta acumulada vs valor de cartera. */
  DG.buildMoneySeries = function (series, flows) {
    const byMonth = new Map(); // 'YYYY-MM' -> {net, value(último día del mes)}
    for (const f of flows) {
      const k = DG.dayKey(f.date).slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, { net: 0, value: null });
      byMonth.get(k).net += f.amount;
    }
    for (const pt of series) {
      const k = pt.day.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, { net: 0, value: null });
      byMonth.get(k).value = pt.value; // se sobreescribe hasta el último día
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    return months.map(m => {
      cum += byMonth.get(m).net;
      const value = byMonth.get(m).value;
      return { month: m, netCum: cum, value, gain: value != null ? value - cum : null };
    });
  };
})();
