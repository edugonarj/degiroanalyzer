/**
 * charts.js — Gráficos con Chart.js: rendimiento vs índices y dinero
 * ingresado vs valor/ganancia.
 */
"use strict";

(function () {
  const DG = window.DG;
  let perfChart = null;
  let moneyChart = null;

  const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

  /**
   * @param twr [{day,index}] serie del usuario
   * @param benchSeries Map id -> {label,color,map} (Map dayKey->close)
   * @param visible Set de ids visibles
   * @param range {from,to} dayKeys
   */
  DG.renderPerfChart = function (twr, benchSeries, visible, range) {
    const pts = twr.filter(p => p.day >= range.from && p.day <= range.to);
    if (!pts.length) return;

    // Re-basar el TWR del usuario a 100 al inicio del rango
    const base = pts[0].index;
    const userData = pts.map(p => ({ x: p.day, y: (p.index / base) * 100 }));

    const datasets = [{
      label: "Mi cartera",
      data: userData,
      borderColor: "#009fdf",
      backgroundColor: "rgba(0,159,223,.08)",
      borderWidth: 2.5, pointRadius: 0, fill: true, tension: .1,
    }];

    for (const [id, b] of benchSeries) {
      if (!visible.has(id) || !b.map) continue;
      const start = DG.seriesAt(b.map, pts[0].day);
      if (!start) continue;
      const data = [];
      for (const p of pts) {
        const v = DG.seriesAt(b.map, p.day);
        if (v != null) data.push({ x: p.day, y: (v / start) * 100 });
      }
      datasets.push({
        label: b.label, data, borderColor: b.color,
        borderWidth: 1.6, pointRadius: 0, fill: false, tension: .1,
      });
    }

    const cfg = {
      type: "line",
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { type: "time", time: { unit: "month", tooltipFormat: "dd MMM yyyy" }, grid: { display: false } },
          y: { ticks: { callback: v => v.toFixed(0) }, title: { display: true, text: "Base 100" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} (${(ctx.parsed.y - 100).toFixed(1)}%)`,
            },
          },
          zoom: {
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
            pan: { enabled: true, mode: "x", modifierKey: "shift" },
          },
        },
      },
    };

    const ctx = document.getElementById("perfChart");
    if (perfChart) perfChart.destroy();
    perfChart = new Chart(ctx, cfg);
    ctx.ondblclick = () => perfChart.resetZoom();
  };

  DG.renderMoneyChart = function (moneySeries) {
    const labels = moneySeries.map(m => m.month);
    const cfg = {
      data: {
        labels,
        datasets: [
          {
            type: "bar", label: "Aportación neta acumulada",
            data: moneySeries.map(m => m.netCum),
            backgroundColor: "rgba(0,41,78,.55)", borderRadius: 2, order: 3,
          },
          {
            type: "bar", label: "Ganancia (valor − aportado)",
            data: moneySeries.map(m => m.gain),
            backgroundColor: moneySeries.map(m => (m.gain ?? 0) >= 0 ? "rgba(46,158,91,.65)" : "rgba(214,69,65,.65)"),
            borderRadius: 2, order: 2,
          },
          {
            type: "line", label: "Valor de la cartera",
            data: moneySeries.map(m => m.value),
            borderColor: "#009fdf", borderWidth: 2, pointRadius: 0, tension: .15, order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { stacked: false, grid: { display: false } },
          y: { ticks: { callback: v => EUR.format(v) } },
        },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${EUR.format(ctx.parsed.y ?? 0)}` } },
        },
      },
    };
    const ctx = document.getElementById("moneyChart");
    if (moneyChart) moneyChart.destroy();
    moneyChart = new Chart(ctx, cfg);
  };
})();
