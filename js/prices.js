/**
 * prices.js — Precios históricos desde Yahoo Finance (vía proxy CORS público)
 * con fallback a los precios de tus propias operaciones.
 *
 * Mapeo ISIN -> ticker de Yahoo. Los ISIN que no estén aquí se intentan
 * resolver con la búsqueda de Yahoo; si falla, se usan los precios de
 * las transacciones (escalón entre operaciones).
 */
"use strict";

(function () {
  const DG = window.DG;

  // Proxies CORS: se intentan en orden.
  const PROXIES = [
    u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  ];

  DG.BENCHMARKS = [
    { id: "sp500",  label: "S&P 500",            symbol: "^GSPC",       color: "#e8a33d", on: true },
    { id: "dow",    label: "Dow Jones",          symbol: "^DJI",        color: "#8e6bbf", on: false },
    { id: "russell",label: "Russell 2000",       symbol: "^RUT",        color: "#d64541", on: false },
    { id: "msci",   label: "MSCI World (URTH)",  symbol: "URTH",        color: "#2e9e5b", on: true },
    { id: "numantia", label: "Numantia Patrimonio", symbol: "0P0001BMXA.F", color: "#666f7a", on: false },
  ];

  // ISIN conocidos -> símbolo Yahoo (cartera del usuario). Se amplía dinámicamente.
  DG.ISIN_TO_YAHOO = {
    "US00217D1000": "ASTS",      // AST SpaceMobile
    "US5901061003": "MRLN",      // Merlin Inc
    "CA0074082060": "ACT.TO",    // Aduro Clean Technologies
    "IE00BK5BZX59": "GOO3.L",    // Leverage Shares 3x Alphabet
    "IE00BK5C1B80": "FB3.L",     // Leverage Shares 3x Meta
    "IE00BK5BZV36": "MSF3.L",    // Leverage Shares 3x Microsoft
    "GB00BJYDH287": "BTCW.SW",   // WisdomTree Physical Bitcoin
    "XS2595672036": "TLT5.L",    // Leverage Shares 5x 20+Y Treasury
    "CA11271J1075": "BN",        // Brookfield Corporation
    "FR0000121014": "MC.PA",     // LVMH
    "CA3803551074": "GSY.TO",    // goeasy
    "US4330001060": "HIMS",      // Hims & Hers
    "IE00B4ND3602": "IGLN.L",    // iShares Physical Gold (USD)
    "DE000A3H2200": "NA9.DE",    // Nagarro
    "PLDINPL00011": "DNP.WA",    // Dino Polska
    "US30292L1070": "FRPH",      // FRP Holdings
    "FR0000051807": "TEP.PA",    // Teleperformance
    "CA2674881040": "DND.TO",    // Dye & Durham
    "CA5266821092": "LNF.TO",    // Leon's Furniture
    "CA09173B1076": "BITF",      // Bitfarms
    "CA3615692058": "GDI.TO",    // GDI Integrated
    "US22160K1051": "COST",      // Costco
    "NL0006294274": "ENX.PA",    // Euronext
    "AU0000185993": "IREN",      // IREN
    "NL0015000IY2": "UMG.AS",    // Universal Music Group
    "CA55378N1078": "MTY.TO",    // MTY Food Group
    "AU0000056269": "MAD.AX",    // Mader Group
    "DE000FTG1111": "FTK.DE",    // flatexDEGIRO
    "AU0000048001": "AFL.AX",    // AF Legal
    "IT0005439085": "TISG.MI",   // Italian Sea Group
    "CA21250C1068": "CTS.TO",    // Converge Technology
    "IT0005385213": "NWL.MI",    // NewPrinces (Newlat)
    "CA59162N1096": "MRU.TO",    // Metro
    "CA0679011084": "GOLD",      // Barrick Gold
    "US00287Y1091": "ABBV",      // AbbVie
    "IE00BF4RFH31": "IUSN.DE",   // iShares MSCI World Small Cap
    "IT0003549422": "SL.MI",     // Sanlorenzo
    "ES0183746314": "VID.MC",    // Vidrala
    "US30212P3038": "EXPE",      // Expedia
    "US0463531089": "AZN",       // AstraZeneca ADR
    "US43300A2033": "HLT",       // Hilton
    "US4592001014": "IBM",
    "US9497461015": "WFC",       // Wells Fargo
    "US00206R1023": "T",         // AT&T
    "US2561631068": "DOCU",      // DocuSign
    "US0079031078": "AMD",
    "ES0105025003": "MRL.MC",    // Merlin Properties
    "US0378331005": "AAPL",
    "US88160R1014": "TSLA",
    "US02079K3059": "GOOGL",
    "US0231351067": "AMZN",
    "US30303M1027": "META",
    "US64110L1061": "NFLX",
    "US5949181045": "MSFT",
    "US67066G1040": "NVDA",
  };

  const cache = new Map(); // key -> Promise<Map dayKey->close>

  async function fetchJSON(url) {
    let lastErr;
    for (const p of PROXIES) {
      try {
        const res = await fetch(p(url), { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("fetch failed");
  }

  /**
   * Serie diaria de cierres de Yahoo. Devuelve Map("YYYY-MM-DD" -> close).
   */
  DG.fetchYahooSeries = async function (symbol, fromDate) {
    const key = "y:" + symbol;
    if (cache.has(key)) return cache.get(key);
    const p1 = Math.floor(fromDate.getTime() / 1000) - 86400 * 7;
    const p2 = Math.floor(Date.now() / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`;
    const promise = fetchJSON(url).then(j => {
      const r = j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new Error("sin datos para " + symbol);
      const closes = r.indicators.quote[0].close;
      const adj = r.indicators.adjclose && r.indicators.adjclose[0].adjclose;
      const map = new Map();
      const meta = { currency: (r.meta && r.meta.currency) || "USD" };
      r.timestamp.forEach((t, i) => {
        const c = (adj && adj[i] != null) ? adj[i] : closes[i];
        if (c != null) map.set(new Date(t * 1000).toISOString().slice(0, 10), c);
      });
      return { map, meta };
    });
    cache.set(key, promise);
    promise.catch(() => cache.delete(key));
    return promise;
  };

  /** Buscar símbolo Yahoo por ISIN. */
  DG.searchYahooByISIN = async function (isin) {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=3&newsCount=0`;
      const j = await fetchJSON(url);
      const q = j.quotes && j.quotes[0];
      return q ? q.symbol : null;
    } catch { return null; }
  };

  /** Serie FX: cierres de EURUSD=X etc. Map dayKey -> unidades de divisa por 1 EUR. */
  DG.fetchFxSeries = async function (cur, fromDate) {
    if (cur === "EUR") return null;
    const { map } = await DG.fetchYahooSeries(`EUR${cur}=X`, fromDate);
    return map;
  };

  /** Valor en una serie para un día, retrocediendo hasta 10 días si no cotiza. */
  DG.seriesAt = function (map, dayKey) {
    if (!map) return null;
    if (map.has(dayKey)) return map.get(dayKey);
    const d = new Date(dayKey + "T00:00:00Z");
    for (let i = 1; i <= 10; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const k = d.toISOString().slice(0, 10);
      if (map.has(k)) return map.get(k);
    }
    return null;
  };

  /** Serie escalón a partir de los precios de las propias operaciones. */
  DG.tradeFallbackSeries = function (points) {
    const sorted = [...points].sort((a, b) => a.date - b.date);
    return {
      cur: sorted.length ? sorted[sorted.length - 1].cur : "EUR",
      at(dayKey) {
        let last = null;
        for (const p of sorted) {
          if (DG.dayKey(p.date) <= dayKey) last = p.price; else break;
        }
        return last;
      },
    };
  };
})();
