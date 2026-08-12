/**
 * replay.js — Reproduce los eventos cronológicamente y construye:
 *  - historial diario de posiciones y efectivo por divisa
 *  - flujos externos (ingresos/retiradas) en EUR
 *  - agregados por producto (invertido, recibido, dividendos, comisiones)
 *  - serie de precios de respaldo por ISIN a partir de las propias operaciones
 */
"use strict";

(function () {
  const DG = window.DG;

  DG.replay = function (events) {
    const state = {
      firstDate: null,
      lastDate: null,
      flows: [],                 // {date, amount} EUR: + ingreso, - retirada
      products: new Map(),       // isin -> agregados
      tradePricePoints: new Map(), // isin -> [{date, price, cur}]
      snapshots: [],             // {date, positions:{isin:qty}, cash:{cur:amt}}
      totals: { deposits: 0, withdrawals: 0, fees: 0, dividendsEUR: 0, lendingEUR: 0, divPending: [] },
      currencies: new Set(["EUR"]),
    };

    const positions = new Map(); // isin -> qty
    const cash = new Map();      // cur -> amount

    // Vincular legs FX en EUR por ID de orden para saber el coste real en EUR
    const fxEurByOrder = new Map(); // orderId -> suma EUR (negativa en compras)
    for (const ev of events) {
      if (ev.type === "fx" && ev.orderId && ev.cur === "EUR" && ev.amount !== null) {
        fxEurByOrder.set(ev.orderId, (fxEurByOrder.get(ev.orderId) || 0) + ev.amount);
      }
    }

    function prod(isin, name) {
      let p = state.products.get(isin);
      if (!p) {
        p = { isin, name: name || isin, qty: 0, investedEUR: 0, receivedEUR: 0,
              feesEUR: 0, dividends: [], firstTrade: null, lastTrade: null };
        state.products.set(isin, p);
      }
      if (name) p.name = name;
      return p;
    }

    function addCash(cur, amt) {
      if (cur == null || amt == null) return;
      cash.set(cur, (cash.get(cur) || 0) + amt);
      state.currencies.add(cur);
    }

    let curDay = null;
    function snapshot(date) {
      state.snapshots.push({
        date,
        positions: Object.fromEntries([...positions].filter(([, q]) => Math.abs(q) > 1e-9)),
        cash: Object.fromEntries(cash),
      });
    }

    for (const ev of events) {
      if (!ev.date) continue;
      const dk = DG.dayKey(ev.date);
      if (curDay !== null && dk !== curDay.key) snapshot(curDay.date);
      curDay = { key: dk, date: ev.date };
      if (!state.firstDate) state.firstDate = ev.date;
      state.lastDate = ev.date;

      switch (ev.type) {
        case "sweep":
          break; // el efectivo en flatex bank sigue siendo nuestro: ignorar

        case "deposit":
          addCash(ev.cur, ev.amount);
          state.totals.deposits += ev.amount;
          state.flows.push({ date: ev.date, amount: ev.amount });
          break;

        case "withdrawal":
          addCash(ev.cur, ev.amount);
          state.totals.withdrawals += ev.amount; // amount ya es negativo
          state.flows.push({ date: ev.date, amount: ev.amount });
          break;

        case "reservation":
        case "wprocessed":
          // Pares +X/−X que mueven el cash en días distintos: son flujo
          // (para no distorsionar la TWR) pero suman cero en los totales.
          addCash(ev.cur, ev.amount);
          state.flows.push({ date: ev.date, amount: ev.amount });
          break;

        case "trade": {
          const p = prod(ev.isin, ev.product);
          p.qty += ev.qty;
          positions.set(ev.isin, (positions.get(ev.isin) || 0) + ev.qty);
          if (!p.firstTrade) p.firstTrade = ev.date;
          p.lastTrade = ev.date;
          addCash(ev.cur, ev.amount);

          // coste/ingreso en EUR
          let eur = null;
          if (ev.cur === "EUR" || ev.tradeCur === "EUR") {
            eur = ev.amount !== null ? ev.amount : -(ev.qty * ev.price);
          } else if (ev.orderId && fxEurByOrder.has(ev.orderId)) {
            eur = fxEurByOrder.get(ev.orderId);
          } else if (ev.fxRate && ev.amount !== null) {
            eur = ev.amount / ev.fxRate;
          }
          if (eur !== null) {
            if (eur < 0) p.investedEUR += -eur; else p.receivedEUR += eur;
          } else if (ev.amount !== null) {
            // divisa extranjera sin leg FX: se convierte después con la serie FX
            state.totals.divPending.push({ isin: ev.isin, date: ev.date, cur: ev.cur, amount: ev.amount, kind: "trade" });
          }
          if (ev.price > 0) {
            if (!state.tradePricePoints.has(ev.isin)) state.tradePricePoints.set(ev.isin, []);
            state.tradePricePoints.get(ev.isin).push({ date: ev.date, price: ev.price, cur: ev.tradeCur });
          }
          break;
        }

        case "split": {
          const p = prod(ev.isin, ev.product);
          p.qty += ev.qty;
          positions.set(ev.isin, (positions.get(ev.isin) || 0) + ev.qty);
          if (ev.price > 0) {
            if (!state.tradePricePoints.has(ev.isin)) state.tradePricePoints.set(ev.isin, []);
            state.tradePricePoints.get(ev.isin).push({ date: ev.date, price: ev.price, cur: ev.tradeCur });
          }
          break;
        }

        case "dividend":
        case "divtax": {
          addCash(ev.cur, ev.amount);
          const p = ev.isin ? prod(ev.isin, ev.product) : null;
          if (ev.cur === "EUR") {
            if (p) p.dividends.push({ date: ev.date, eur: ev.amount });
            state.totals.dividendsEUR += ev.amount;
          } else {
            state.totals.divPending.push({ isin: ev.isin, date: ev.date, cur: ev.cur, amount: ev.amount, kind: "dividend" });
          }
          break;
        }

        case "lending":
          addCash(ev.cur, ev.amount);
          if (ev.cur === "EUR") state.totals.lendingEUR += ev.amount;
          break;

        case "fee": {
          addCash(ev.cur, ev.amount);
          if (ev.cur === "EUR" && ev.amount !== null) {
            state.totals.fees += ev.amount;
            // comisión de una orden concreta -> asignar al producto
            if (ev.isin && state.products.has(ev.isin) && /transacci/i.test(ev.desc)) {
              state.products.get(ev.isin).feesEUR += ev.amount;
            }
          }
          break;
        }

        case "fx":
        case "other":
        default:
          addCash(ev.cur, ev.amount);
          break;
      }
    }
    if (curDay) snapshot(curDay.date);

    return state;
  };
})();
