# DEGIRO Tracker

Web estática para analizar tu rentabilidad en DEGIRO comparada con índices de referencia. Todo se procesa en tu navegador: el Excel nunca sale de tu ordenador.

## Qué hace

- Sube tu `Account.xlsx` (DEGIRO → Actividad → Estado de cuenta → Exportar, con el rango completo desde que empezaste)
- Resumen tipo DEGIRO: valor de cartera, aportado neto, ganancia total, rentabilidad anualizada (XIRR) y acumulada (TWR)
- Gráfico de rentabilidad vs S&P 500, Dow Jones, Russell 2000, MSCI World y Numantia Patrimonio, con toggles para activar/desactivar cada índice, presets (1M, 6M, YTD, 1A, 3A, 5A, MAX), fechas personalizadas y zoom con la rueda del ratón
- Gráfico de dinero ingresado (aportación neta acumulada) vs valor de cartera y ganancia, mes a mes
- Tabla de resultado por inversión (abiertas, cerradas o todas) con invertido, recibido, dividendos y P/G

## Cómo publicarlo en GitHub Pages

1. Crea un repo nuevo en GitHub (por ejemplo `degiro-tracker`)
2. Sube el contenido de esta carpeta (`index.html`, `css/`, `js/`)
3. En el repo: Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `/ (root)` → Save
4. En un par de minutos tendrás la web en `https://<tu-usuario>.github.io/degiro-tracker/`

## Notas técnicas

- Los precios históricos y las series FX vienen de Yahoo Finance a través de un proxy CORS público (corsproxy.io con fallback a allorigins.win). Si un producto no cotiza en Yahoo (p. ej. certificados SG/BNP), se usan los precios de tus propias operaciones como aproximación en escalón.
- La rentabilidad del gráfico comparativo es TWR (time-weighted), que neutraliza tus ingresos y retiradas y por eso es comparable con un índice. La anualizada de la tarjeta es XIRR (money-weighted), que refleja tu experiencia real con el dinero.
- El coste en EUR de las compras en USD/CAD/etc. se calcula con el leg de cambio de divisa de tu propio extracto (mismo ID de orden), no con un FX aproximado.
- Splits, fusiones, deslistamientos y ajustes están soportados (Apple, FRP, QXO, Total Produce→Dole...).

## Estructura

```
index.html      Página única
css/styles.css  Estilo tipo DEGIRO
js/parser.js    Lectura del Excel y tipado de movimientos
js/replay.js    Reconstrucción cronológica de cartera y flujos
js/prices.js    Yahoo Finance + FX + fallback de precios
js/metrics.js   Serie de valor, TWR, XIRR, P/G por producto
js/charts.js    Gráficos (Chart.js + zoom)
js/app.js       Orquestación y UI
```
