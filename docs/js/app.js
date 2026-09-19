import * as P from './pricing.js?v=13';
import * as D from './data.js?v=13';

const $ = (id) => document.getElementById(id);
const state = { premAuto: false, type: 'call', side: 'long', style: 'american', chain: null, chainExpiry: null, ticker: '', tab: 'overview', lsmc: null, basis: 'market', iv: NaN, surf: null };
const COLORS = ['#f5b13d', '#a9cf3f', '#3fae78', '#60a5fa', '#c4a1ff'];
const GRID = 'rgba(255,255,255,0.07)', ZERO = 'rgba(255,255,255,0.22)', TXT = '#cbd5e6';
const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (x, d = 4) => (Number.isFinite(x) ? (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'); // no '-0.0000'
const pct = (x, d = 2) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
const sgn = () => (state.side === 'long' ? 1 : -1);

// Two volatilities live side by side:
//   raw.sigma / p.sigmaModel = the σ in the input box (the "model σ": the script fills it with the 30-day implied vol, you may overwrite it); it sets the model fair value.
//   p.sigma                  = the analysis σ: the σ implied by the premium when the switch says "My premium's σ", else the same as the model σ.
function readRaw() {
  const v = (id) => parseFloat($(id).value);
  return { S: v('S'), K: v('K'), T: v('days') / 365, r: v('r') / 100, sigma: v('sigma') / 100, q: v('q') / 100, steps: parseInt($('steps').value, 10), kind: state.type, style: state.style };
}
const effectiveSigma = (sigma) => (state.basis === 'market' && Number.isFinite(state.iv) && state.iv > 0 ? state.iv : sigma);
function readInputs() { const raw = readRaw(); return { ...raw, sigmaModel: raw.sigma, sigma: effectiveSigma(raw.sigma) }; }
function validate(p) {
  if (![p.S, p.K, p.T, p.r, p.sigma, p.q].every(Number.isFinite)) return 'Fill in all inputs with numbers.';
  if (p.S <= 0 || p.K <= 0) return 'Spot and strike must be positive.';
  if (p.T <= 0) return 'Days to expiry must be positive.';
  if (p.sigma <= 0) return 'Volatility must be positive.';
  return '';
}
function showError(msg) { const e = $('error'); e.hidden = !msg; e.textContent = msg || ''; }

// ---------------------------------------------------------------- plotting helpers
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function baseLayout(extra = {}) {
  return Object.assign({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: TXT, size: 12, family: FONT }, margin: { l: 56, r: 16, t: 34, b: 44 },
    xaxis: { gridcolor: GRID, zerolinecolor: ZERO, linecolor: GRID }, yaxis: { gridcolor: GRID, zerolinecolor: ZERO, linecolor: GRID },
    legend: { orientation: 'h', y: -0.22 },
    hoverlabel: { bgcolor: 'rgba(9,14,27,0.96)', bordercolor: 'rgba(255,255,255,0.25)', font: { family: FONT, color: '#f2f5fa', size: 12 } },
  }, extra);
}
const draw = (id, data, layout, config = {}) => Plotly.react(id, data, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'], ...config });
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// ---------------------------------------------------------------- compute + render
let cache = null;
function compute() {
  const raw = readRaw();
  const err = validate(raw);
  showError(err);
  if (err) { cache = null; return null; }
  const p = readInputs();
  let failedSigma = p.sigma; // which sigma the tree choked on: the analysis sigma or yours
  try {
    const evalAt = (sigma, full) => {
      failedSigma = sigma;
      const bsm = P.bsmPrice(p.S, p.K, p.T, p.r, sigma, p.q, p.kind);
      const eu = P.binomialTree(p.S, p.K, p.T, p.r, sigma, p.q, p.kind, p.steps, false);
      const am = P.binomialTree(p.S, p.K, p.T, p.r, sigma, p.q, p.kind, p.steps, true, full);
      if (!full) return { bsm, eu, am };
      // americanGreeks also bumps sigma by 0.005, so it can fail at a very low sigma where the plain price still works: show "—" then
      let ag; try { ag = P.americanGreeks(p.S, p.K, p.T, p.r, sigma, p.q, p.kind, Math.min(p.steps, 500)); } catch { ag = { delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN }; }
      return { bsm, eu, am, g: P.bsmGreeks(p.S, p.K, p.T, p.r, sigma, p.q, p.kind), ag };
    };
    const eff = evalAt(p.sigma, true);                              // at the analysis σ: Greeks, charts, scenarios
    const mod = p.sigma === raw.sigma ? eff : evalAt(raw.sigma, false); // at YOUR σ: the model fair value
    cache = { p, raw, ...eff, mod, intrinsic: P.intrinsic(p.S, p.K, p.kind) };
  } catch (e) {
    // the tree needs d < e^((r-q)dt) < u: with a tiny sigma and many steps it does not hold. Say what to change instead of quoting the condition.
    showError(/no-arbitrage/i.test(e.message) ? `Volatility ${pct(failedSigma, 2)} is too low for ${p.steps} tree steps (the up/down moves become smaller than the interest drift). Raise σ, or lower the steps slider.` : e.message);
    cache = null;
  }
  return cache;
}

function renderHero() {
  const c = cache; if (!c) { $('hero').innerHTML = ''; return; }
  const { p, raw } = c;
  const price = modelPrice();
  const be = p.kind === 'call' ? p.K + price : p.K - price;
  const [, d2] = P.d1d2(p.S, p.K, p.T, p.r, raw.sigma, p.q);
  const probItm = p.kind === 'call' ? P.N(d2) : P.N(-d2);
  const tv = price - c.intrinsic;
  const cards = [
    ['main', `${p.style === 'american' ? 'American' : 'European'} ${p.kind} fair value`, fmt(price, 4), `model price at model σ ${pct(raw.sigma, 1)}`],
    ['', 'Intrinsic value', fmt(c.intrinsic, 4), c.intrinsic > 0 ? 'in the money' : 'out of the money'],
    ['', 'Time value', fmt(tv, 4), `${((tv / price) * 100 || 0).toFixed(0)}% of premium`],
    ['', 'Breakeven (model)', fmt(be, 2), `at expiry (${pct((be - p.S) / p.S, 1)} from spot)`],
    ['', 'P(finish ITM)', pct(probItm, 1), 'risk-neutral, N(±d2)'],
  ];
  $('hero').innerHTML = cards.map(([cls, k, v, s]) => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

function renderOverview() {
  const c = cache; if (!c) return;
  const { p, raw } = c, m = c.mod;
  const epe = m.am.price - m.eu.price;
  const mkt = parseFloat($('premium').value);
  const rows = [
    ['Black-Scholes-Merton (closed form)', m.bsm, `European benchmark at model σ ${pct(raw.sigma, 1)}`],
    [`European tree (${p.steps} steps)`, m.eu.price, `error vs BSM ${(m.eu.price - m.bsm >= 0 ? '+' : '') + (m.eu.price - m.bsm).toFixed(5)}`],
    [`American tree (${p.steps} steps)`, m.am.price, `early-exercise premium ${(epe >= 0 ? '+' : '') + epe.toFixed(4)}`],
  ];
  if (state.lsmc) rows.push([`American LSMC (${state.lsmc.paths.toLocaleString()} paths)`, state.lsmc.price, `± ${(1.96 * state.lsmc.se).toFixed(4)} (95%); biased slightly low`]);
  if (Number.isFinite(mkt)) {
    const model = modelPrice();
    rows.push(['Your premium', mkt, `model − premium = ${(model - mkt >= 0 ? '+' : '') + (model - mkt).toFixed(4)} at model σ ${pct(raw.sigma, 1)}`]);
  }
  $('modelTable').innerHTML = `<tr><th>Model</th><th class="num">Premium</th><th>Note</th></tr>` +
    rows.map(([n, v, why]) => `<tr><td>${n}</td><td class="num">${fmt(v, 4)}</td><td class="why">${why}</td></tr>`).join('');

  const tbl = impactTableHTML();
  $('impactCardOverview').hidden = !tbl;
  $('impactTableOverview').innerHTML = tbl;
  const s = sgn();
  const desc = {
    delta: ['Delta Δ', 'Change in premium per $1 move in spot. Also the hedge ratio and roughly P(ITM).', 1],
    gamma: ['Gamma Γ', 'Change in delta per $1 move in spot. Convexity; long options are long gamma.', 1],
    vega: ['Vega', 'Change in premium per 1 vol point (1%).', 0.01],
    theta: ['Theta Θ', 'Change in premium per calendar day; the rent paid for gamma.', 1 / 365],
    rho: ['Rho ρ', 'Change in premium per 1% move in the risk-free rate.', 0.01],
  };
  $('greeksNote').textContent = `${state.side} position, signs ${state.side === 'long' ? 'as you hold it' : 'flipped for the short side'} · Greeks at σ ${pct(p.sigma, 2)}${p.sigma !== raw.sigma ? ' (implied by your premium)' : ''}${p.style === 'american' ? ' · the charts and surfaces below use Black-Scholes (European) values, so they differ slightly from the American-tree column here' : ''}`;
  $('greekTable').innerHTML = `<tr><th>Greek</th><th class="num">BSM</th><th class="num">American tree</th><th>Meaning</th></tr>` +
    Object.entries(desc).map(([k, [name, why, sc]]) => `<tr><td>${name}</td><td class="num">${fmt(s * c.g[k] * sc, 4)}</td><td class="num">${fmt(s * c.ag[k] * sc, 4)}</td><td class="why">${why}</td></tr>`).join('');
}

function greekFn(name, p) {
  const scale = { vega: 0.01, theta: 1 / 365, rho: 0.01 };
  return (S, T, sigma) => (name === 'price' ? P.bsmPrice(S, p.K, T, p.r, sigma, p.q, p.kind) : P.bsmGreeks(S, p.K, T, p.r, sigma, p.q, p.kind)[name] * (scale[name] || 1)) * (name === 'price' ? 1 : sgn());
}
const GREEK_LABELS = { delta: 'Delta', gamma: 'Gamma', vega: 'Vega (per vol pt)', theta: 'Theta (per day)', rho: 'Rho (per 1%)', price: 'Premium' };

const compareAvailable = () => !!(cache && Number.isFinite(state.iv) && state.iv > 0 && Math.abs(state.iv - cache.raw.sigma) > 1e-6);
function renderGreeks() {
  const c = cache; if (!c) return; const { p, raw } = c;
  const cmp = compareAvailable();
  $('greekLinesWrap').hidden = !cmp;
  const useCmp = cmp && $('greekLines').value === 'compare';
  const mode = $('greekX').value;
  const grid = $('greekGrid');
  if (!grid.children.length) Object.keys(GREEK_LABELS).forEach((k) => { const d = document.createElement('div'); d.className = 'g'; d.id = 'g-' + k; grid.appendChild(d); });
  const day = 1 / 365, mine = raw.sigma, theirs = state.iv, prem = getPremium();
  const cmpSeries = (mk) => [{ name: `Model σ ${pct(mine, 1)}`, dash: 'dash', color: TXT, f: mk(mine) }, { name: `My premium’s σ ${pct(theirs, 1)}`, color: COLORS[0], f: mk(theirs) }];
  let xs, series, xTitle, hint, vlines;
  if (mode === 'spot') {
    xs = linspace(Math.min(0.6 * p.K, 0.8 * p.S), Math.max(1.4 * p.K, 1.2 * p.S), 160); xTitle = 'Spot'; // always include today's spot, even when it is far from the strike
    vlines = [{ x: p.K, color: '#e5484d' }, ...(Math.abs(p.S - p.K) > 1e-9 ? [{ x: p.S, color: TXT, dash: 'dot' }] : [])];
    series = useCmp ? cmpSeries((sg) => (x) => [x, p.T, sg])
      : [0.1, 0.25, 0.5, 1].map((f) => ({ name: `${Math.max(Math.round(p.T * 365 * f), 1)}d`, f: (x) => [x, Math.max(p.T * f, day), p.sigma] }));
    hint = (useCmp ? 'Dashed lines = the model σ, solid = the σ your premium implies. Same contract and expiry, so the gap is exactly what the premium changes.'
      : 'One line per time to expiry. Gamma spikes at the strike and sharpens as expiry nears.') + ` Red dashed = strike${Math.abs(p.S - p.K) > 1e-9 ? ', white dotted = today’s spot' : ''}.`;
  } else if (mode === 'time') {
    xs = linspace(1, Math.max(p.T * 365, 2), 160); xTitle = 'Days to expiry'; vlines = [];
    series = useCmp ? cmpSeries((sg) => (x) => [p.S, x / 365, sg])
      : [0.9, 1, 1.1].map((m) => ({ name: `S = ${(m * p.K).toFixed(1)}`, f: (x) => [m * p.K, x / 365, p.sigma] }));
    hint = useCmp ? 'At today’s spot. Dashed = model σ, solid = my premium’s σ.' : 'One line per moneyness. Theta and gamma blow up for at-the-money options as expiry approaches.';
  } else {
    xs = linspace(0.05, 0.9, 160); xTitle = 'Volatility';
    vlines = cmp ? [{ x: mine, color: TXT }, { x: theirs, color: COLORS[0], dash: 'solid' }] : [{ x: p.sigma, color: '#e5484d' }];
    series = [0.9, 1, 1.1].map((m) => ({ name: `S = ${(m * p.K).toFixed(1)}`, f: (x) => [m * p.K, p.T, x] }));
    hint = cmp ? 'White dashed line = the model σ, amber line = the σ your premium implies: read each Greek where the lines cross.' : 'Vega peaks near the money; higher vol pushes delta towards 0.5 and shrinks gamma.';
  }
  $('greekHint').textContent = hint;
  for (const name of Object.keys(GREEK_LABELS)) {
    const fn = greekFn(name, p);
    const traces = series.map((s, i) => ({ x: xs, y: xs.map((x) => fn(...s.f(x))), name: s.name, mode: 'lines', line: { color: s.color || COLORS[i % COLORS.length], width: s.dash ? 1.6 : 2.2, dash: s.dash }, showlegend: name === 'delta' }));
    if (useCmp && mode === 'spot' && name === 'price' && Number.isFinite(prem)) {
      traces.push({ x: [p.S], y: [prem], mode: 'markers', name: 'your premium', showlegend: false, marker: { color: '#ffffff', size: 10, line: { color: COLORS[0], width: 3 } }, hovertemplate: 'your premium %{y:.4f} at spot %{x:.2f}<extra></extra>' });
    }
    const layout = baseLayout({ title: { text: GREEK_LABELS[name], font: { size: 13 } }, margin: { l: 46, r: 8, t: 30, b: 36 }, xaxis: { title: { text: xTitle, font: { size: 11 } }, gridcolor: GRID }, legend: { x: 0.98, y: 0.05, xanchor: 'right', yanchor: 'bottom', bgcolor: 'rgba(9,14,27,0.55)', font: { size: 10 } }, shapes: vlines.map((v) => ({ type: 'line', x0: v.x, x1: v.x, yref: 'paper', y0: 0, y1: 1, line: { color: v.color, dash: v.dash || 'dash', width: 1 } })) });
    draw('g-' + name, traces, layout);
  }
  renderGreekSurface();
}

function renderGreekSurface() {
  const c = cache; if (!c) return; const { p, raw } = c;
  const cmp = compareAvailable();
  $('greekSurfModeWrap').hidden = !cmp;
  const view = cmp ? $('greekSurfMode').value : 'premium';
  const g = $('greek3d').value, scale = { vega: 0.01, theta: 1 / 365, rho: 0.01 }[g] || 1;
  const S = linspace(Math.min(0.7 * p.K, 0.85 * p.S), Math.max(1.3 * p.K, 1.15 * p.S), 60), T = linspace(0.02, Math.max(p.T, 0.25) * 1.5, 50);
  const zAt = (sg) => T.map((t) => S.map((s) => P.bsmGreeks(s, p.K, t, p.r, sg, p.q, p.kind)[g] * scale * sgn()));
  const premiumSigma = cmp ? state.iv : p.sigma;
  let z, colorscale = IV_SCALE, extra = {}, zTitle = GREEK_LABELS[g] || g;
  if (view === 'diff') {
    const a = zAt(premiumSigma), b = zAt(raw.sigma);
    z = a.map((row, i) => row.map((v, j) => v - b[i][j]));
    colorscale = [[0, '#fb7185'], [0.5, '#22304b'], [1, '#34d399']]; extra = { cmid: 0, showscale: true, colorbar: { thickness: 12, len: 0.6 } };
    zTitle = `${zTitle}: my premium’s σ minus model σ`;
  } else z = zAt(view === 'model' ? raw.sigma : premiumSigma);
  draw('greekSurface', [{ type: 'surface', x: S, y: T, z, colorscale, showscale: false, contours: { z: { show: true, usecolormap: true, project: { z: false } } }, ...extra }],
    baseLayout({ margin: { l: 0, r: 0, t: 10, b: 0 }, scene: sceneStyle('Spot', 'Time to expiry (y)', zTitle) }));
}

const IV_SCALE = [[0, '#0b1f5c'], [0.17, '#1b4f9c'], [0.34, '#1a8a9c'], [0.5, '#3fae78'], [0.68, '#a9cf3f'], [0.84, '#f3c334'], [1, '#f59b2a']];
function sceneStyle(x, y, z) {
  const ax = (t) => ({ title: { text: t }, gridcolor: '#26324b', backgroundcolor: '#0c1322', showbackground: true, zerolinecolor: '#3a4a6b', color: TXT }); // solid colours: the 3-D engine ignores alpha
  return { xaxis: ax(x), yaxis: ax(y), zaxis: ax(z), camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } }, aspectmode: 'manual', aspectratio: { x: 1.3, y: 1, z: 0.7 } };
}

function renderPayoff() {
  const c = cache; if (!c) return; const { p } = c;
  const s = sgn(), mkt = parseFloat($('premium').value);
  const paid = Number.isFinite(mkt) ? mkt : effPrice();
  const xs = linspace(Math.min(0.6 * p.K, 0.8 * p.S), Math.max(1.4 * p.K, 1.2 * p.S), 200);
  const at = (T) => xs.map((x) => s * ((T <= 0 ? P.intrinsic(x, p.K, p.kind) : P.bsmPrice(x, p.K, T, p.r, p.sigma, p.q, p.kind)) - paid));
  const be = p.kind === 'call' ? p.K + paid : p.K - paid;
  const traces = [
    { x: xs, y: at(0), name: 'At expiry', line: { color: COLORS[0], width: 2.5 } },
    { x: xs, y: at(p.T / 2), name: 'Halfway to expiry', line: { color: '#a9cf3f', width: 1.6, dash: 'dot' } },
    { x: xs, y: at(p.T), name: p.sigma !== c.raw.sigma ? `Today at my premium’s σ ${pct(p.sigma, 1)}` : 'Today', line: { color: '#4aa3df', width: 2 } },
    ...(p.sigma !== c.raw.sigma ? [{ x: xs, y: xs.map((x) => s * (P.bsmPrice(x, p.K, p.T, p.r, c.raw.sigma, p.q, p.kind) - paid)), name: `Today at model σ ${pct(c.raw.sigma, 1)}`, line: { color: TXT, width: 1.4, dash: 'dash' } }] : []),
  ].map((t) => ({ ...t, mode: 'lines' }));
  draw('payoffPlot', traces, baseLayout({ title: `${state.side} ${p.kind} K=${p.K}, premium ${fmt(paid, 2)}`, xaxis: { title: 'Underlying price', gridcolor: GRID }, yaxis: { title: 'Profit / loss per share', gridcolor: GRID, zerolinecolor: ZERO },
    shapes: [{ type: 'line', x0: p.S, x1: p.S, yref: 'paper', y0: 0, y1: 1, line: { color: '#e5484d', dash: 'dash', width: 1 } }, { type: 'line', x0: be, x1: be, yref: 'paper', y0: 0, y1: 1, line: { color: '#3fae78', dash: 'dot', width: 1 } }],
    annotations: [{ x: p.S, yref: 'paper', y: 1, text: 'spot', showarrow: false, font: { color: '#e5484d' } }, { x: be, yref: 'paper', y: 0.94, text: `breakeven ${be.toFixed(2)}`, showarrow: false, font: { color: '#3fae78' }, xanchor: 'left' }] }));
  const maxLoss = s === 1 ? `${fmt(paid, 2)} (the premium)` : (p.kind === 'call' ? 'unbounded' : `${fmt(p.K - paid, 2)}`);
  const maxGain = s === 1 ? (p.kind === 'call' ? 'unbounded' : `${fmt(p.K - paid, 2)}`) : `${fmt(paid, 2)} (the premium)`;
  $('payoffNote').textContent = `Max loss: ${maxLoss} · Max gain: ${maxGain}. Curves use Black-Scholes value for "today" at σ ${pct(p.sigma, 1)}${p.style === 'american' ? ' (European: an American option is worth a little more, so its real curve sits slightly higher)' : ''}; premium ${Number.isFinite(mkt) ? 'is your market price' : 'is the model price'}.`;
}

function renderTree() {
  const c = cache; if (!c) return; const { p } = c;
  const rows = P.convergence(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind);
  const n = rows.map((r) => r.steps);
  draw('convPlot', [
    { x: n, y: rows.map((r) => r.european), name: 'European tree', mode: 'lines+markers', line: { color: '#4aa3df' } },
    { x: n, y: rows.map((r) => r.american), name: 'American tree', mode: 'lines+markers', line: { color: COLORS[0] } },
    { x: n, y: rows.map(() => rows[0].bsm), name: 'BSM closed form', mode: 'lines', line: { color: '#3fae78', dash: 'dash' } },
    { x: n, y: rows.map((r) => Math.abs(r.error) + 1e-12), name: '|Euro tree − BSM| (right axis)', mode: 'lines+markers', yaxis: 'y2', line: { color: '#a9cf3f', dash: 'dot' } },
  ], baseLayout({ xaxis: { type: 'log', title: 'Tree steps', gridcolor: GRID }, yaxis: { title: 'Premium', gridcolor: GRID }, yaxis2: { overlaying: 'y', side: 'right', type: 'log', title: 'Abs. error', showgrid: false }, margin: { l: 56, r: 60, t: 20, b: 60 } }));

  const b = c.am;
  let t = [], sPts = [];
  b.boundaryT.forEach((x, i) => { if (Number.isFinite(b.boundaryS[i])) { t.push(x * 365); sPts.push(b.boundaryS[i]); } });
  // the lattice has discrete spot levels, so the raw boundary is a staircase: smooth it (moving average, ~4% of the axis)
  const w = Math.max(3, Math.floor(sPts.length / 25)), half = Math.floor(w / 2);
  sPts = sPts.map((_, i) => { const a = Math.max(0, i - half), z = Math.min(sPts.length - 1, i + half); let s = 0; for (let j = a; j <= z; j++) s += sPts[j]; return s / (z - a + 1); });
  if (t.length) {
    const inside = p.kind === 'put' ? 'below' : 'above';
    draw('boundaryPlot', [
      { x: t, y: sPts, mode: 'lines', name: 'Critical spot', line: { color: COLORS[0], width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(229,72,77,.0)' },
      { x: [0, p.T * 365], y: [p.K, p.K], mode: 'lines', name: 'Strike', line: { color: ZERO, dash: 'dash' } },
      { x: [0], y: [p.S], mode: 'markers', name: 'Spot today', marker: { color: '#e5484d', size: 9 } },
    ], baseLayout({ xaxis: { title: 'Days from today', gridcolor: GRID }, yaxis: { title: 'Critical spot', gridcolor: GRID } }));
    $('boundaryNote').textContent = `Exercise immediately whenever the spot is ${inside} the curve; everywhere else, wait. The boundary approaches the strike at expiry.`;
  } else {
    draw('boundaryPlot', [], baseLayout({ annotations: [{ text: 'Early exercise is never optimal here', xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, font: { size: 16, color: '#93a0b6' } }], xaxis: { visible: false }, yaxis: { visible: false } }));
    $('boundaryNote').textContent = p.kind === 'call' ? 'An American call on a non-dividend payer is never exercised early (Merton 1973): its price equals the European price. Add a dividend yield above the risk-free rate to see a boundary.' : 'No exercise region on this tree (rate is ~0, so waiting is free).';
  }
}

function renderChecks() {
  const c = cache; if (!c) { $('checkList').innerHTML = ''; return; }
  const list = P.sanityChecks(c.p);
  $('checkList').innerHTML = list.map((x) => `<div class="check"><span class="badge ${x.passed ? 'pass' : 'fail'}">${x.passed ? 'PASS' : 'FAIL'}</span><span>${x.name}</span><span class="d">${x.detail}</span></div>`).join('');
}

const HOW = `
<h3>1 · The Black-Scholes-Merton price</h3>
<p>The stock follows geometric Brownian motion, dS = μS dt + σS dW. Hold Δ = ∂V/∂S shares against a short option and the dW term cancels, so the portfolio must earn the risk-free rate. That gives the PDE, in which μ disappears. Its solution for a European option:</p>
<div class="eq">d1 = [ ln(S/K) + (r − q + σ²/2)·T ] / (σ√T)      d2 = d1 − σ√T
Call = S·e^(−qT)·N(d1) − K·e^(−rT)·N(d2)
Put  = K·e^(−rT)·N(−d2) − S·e^(−qT)·N(−d1)</div>
<p>N(d2) is the risk-neutral probability of finishing in the money. Put-call parity, C − P = S·e^(−qT) − K·e^(−rT), holds exactly and is one of the checks.</p>
<h3>2 · The binomial tree (Cox-Ross-Rubinstein)</h3>
<div class="eq">u = e^(σ√Δt)     d = 1/u     q̃ = (e^((r−q)Δt) − d) / (u − d)     V = e^(−rΔt)·[ q̃·V_up + (1 − q̃)·V_down ]</div>
<p>Two states and two instruments (shares + bond) means the payoff can be replicated exactly, so the option price is a discounted expectation under the probability q̃ that falls out of the algebra. It only exists when d &lt; e^((r−q)Δt) &lt; u; otherwise there is an arbitrage. As Δt → 0 the tree converges to BSM.</p>
<h3>3 · American options: exercise or wait?</h3>
<p>At every node take max(continuation value, exercise value). Working backward from expiry this is dynamic programming on the lattice. Consequences you can verify in the Sanity checks tab: an American call on a non-dividend stock is never exercised early; an American put is worth strictly more than the European put when r &gt; 0; and when r → 0 the put’s early-exercise edge disappears.</p>
<h3>4 · Longstaff-Schwartz Monte Carlo</h3>
<p>Simulate risk-neutral paths, then walk backward. Among in-the-money paths regress the discounted future cash flow on basis functions of the spot (weighted Laguerre polynomials). The fitted curve estimates the continuation value; exercise on a path when the immediate payoff beats it. Because the regression is only an estimate, decisions are slightly suboptimal and LSMC is biased low relative to the tree. Replacing the polynomial basis with a kernel is exactly the step the RKHS project generalises.</p>
<h3>5 · Greeks</h3>
<p><b>Delta</b> = ∂V/∂S (hedge ratio). <b>Gamma</b> = ∂²V/∂S² (convexity). <b>Theta</b> = ∂V/∂t (the rent you pay for gamma). <b>Vega</b> = ∂V/∂σ. <b>Rho</b> = ∂V/∂r. Vanna and volga are the cross and second derivatives in vol. Closed forms come from differentiating BSM; for the American option, Δ, Γ, Θ are read from the first nodes of the tree and vega, rho are finite-difference bumps.</p>
<h3>6 · Implied vol and the surface</h3>
<p>Desks quote in volatility, not dollars: implied vol is the σ that makes BSM reproduce the market premium (solved by bisection; BSM price is strictly increasing in σ). Doing this for every strike and expiry gives the surface. Since Black Monday the surface has a skew, with out-of-the-money puts trading at higher vols than BSM's flat-vol assumption allows.</p>
<p>Full derivations and design choices are in <a href="https://github.com/Ferrsir/options-pricer/blob/main/METHODOLOGY.md" target="_blank" rel="noopener">METHODOLOGY.md</a>.</p>`;

// ---------------------------------------------------------------- guide tab (rendered from GUIDE.md by scripts/build_guide.py)
let guideLoaded = false;
async function loadGuide() {
  if (guideLoaded) return;
  try {
    const r = await fetch('./guide.html?v=13'); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('guideText').innerHTML = await r.text(); guideLoaded = true;
  } catch (e) { $('guideText').innerHTML = `<p class="hint bad">Could not load the guide (${e.message}). It is also in the repository as GUIDE.md.</p>`; }
}

// ---------------------------------------------------------------- vol surface tab
async function loadSurface() {
  const t = ($('surfTicker').value || 'NDX').trim();
  $('loadSurface').disabled = true; $('surfStatus').className = 'hint'; $('surfStatus').textContent = 'Building surface…';
  try {
    // if the surface is for the ticker you loaded, make it wide enough to include your contract (see getSurface)
    const sym = t.toUpperCase().replace('^', ''), own = cache && state.ticker && sym === state.ticker.toUpperCase().replace('^', '');
    const kc = own ? Math.log(cache.raw.K / cache.raw.S) : 0;
    const opts = own ? { maxDays: Math.ceil(cache.raw.T * 365) + 30, kRange: [Math.max(-0.25, Math.min(-0.15, kc - 0.03)), Math.min(0.2, Math.max(0.1, kc + 0.03))] } : {};
    const s = await D.getSurface(t, opts);
    state.surf = s; state.surfSym = sym; state.surfKey = own ? contractKey() : '';
    drawSurface(s);
    $('surfStatus').textContent = `${s.label} · spot ${s.spot.toLocaleString()} · ${s.asof} · ${({ live: 'live data', cboe: 'live data (Cboe, 15-min delayed)', snapshot: 'bundled snapshot' }[s.source] || 'live data')}`;
  } catch (e) { $('surfStatus').className = 'hint bad'; $('surfStatus').textContent = e.message; }
  $('loadSurface').disabled = false;
}
// does the surface reach this contract? (a 2-day / 0.005 log-moneyness tolerance: the contract's T is computed a few minutes after the surface's)
const surfaceCovers = (s, k, T) => k >= s.k[0] - 0.005 && k <= s.k[s.k.length - 1] + 0.005 && T >= s.T[0] - 0.005 && T <= s.T[s.T.length - 1] + 0.005;
const contractKey = () => (cache && state.ticker ? `${state.ticker.toUpperCase().replace('^', '')}|${Math.round(cache.raw.T * 365)}|${Math.log(cache.raw.K / cache.raw.S).toFixed(2)}` : '');
// the surface on screen belongs to the loaded ticker but your contract now lies off its edge: rebuild it once for this contract (the key stops a loop if the data simply is not there)
function maybeWidenSurface() {
  const s = state.surf, c = cache;
  if (!s || !c || !(getPremium() > 0) || !state.ticker || state.surfSym !== state.ticker.toUpperCase().replace('^', '') || state.surfKey === contractKey()) return;
  const k = Math.log(c.raw.K / c.raw.S), T = c.raw.T;
  if (!surfaceCovers(s, k, T)) { state.surfKey = contractKey(); loadSurface(); }
}
// where the user's own premium sits on the market surface (its implied vol at this strike and maturity)
function userPoint(s, zmin, zmax) {
  const c = cache, note = $('surfMarkNote');
  note.hidden = true;
  if (!c || !Number.isFinite(state.iv) || !(getPremium() > 0)) return null;
  const k = Math.log(c.raw.K / c.raw.S), T = c.raw.T, iv = state.iv * 100;
  const inRange = surfaceCovers(s, k, T);
  const fits = iv >= zmin - 5 && iv <= zmax * 1.6;
  note.hidden = false;
  note.textContent = `Your premium implies ${iv.toFixed(1)}% vol at ln(K/S) = ${k.toFixed(3)} and ${(T * 365).toFixed(0)} days${inRange ? '' : ' (outside this surface’s strike or maturity range)'}${fits ? '' : '; that is off this chart’s vol scale, so it is not plotted'}. Compare it with the surface only if your inputs describe the same stock or index.`;
  if (!fits) return null;
  return {
    zTop: Math.ceil(iv / 5) * 5 + 2,
    t3: { type: 'scatter3d', mode: 'markers+text', x: [k], y: [T], z: [iv], text: ['your premium'], textposition: 'top center', textfont: { color: COLORS[0], size: 12 }, marker: { size: 7, color: '#ffffff', line: { color: COLORS[0], width: 4 } }, hovertemplate: 'Your premium<br>k=%{x:.3f}<br>T=%{y:.3f}y<br>IV=%{z:.1f}%<extra></extra>', showlegend: false },
    t2d: { x: [k], y: [iv], mode: 'markers+text', text: ['your premium'], textposition: 'top center', name: 'Your premium', marker: { color: '#ffffff', size: 10, line: { color: COLORS[0], width: 3 } }, textfont: { color: COLORS[0], size: 11 } },
  };
}
function drawSurface(s) {
  const z = s.iv.map((row) => row.map((v) => v * 100));
  const j0 = s.k.reduce((bi, k, i) => (Math.abs(k) < Math.abs(s.k[bi]) ? i : bi), 0);
  const zmin = Math.floor(Math.min(...z.flat()) / 5) * 5, zmax = Math.ceil(Math.max(...z.flat()) / 5) * 5;
  const up = userPoint(s, zmin, zmax);
  draw('surfacePlot', [
    { type: 'surface', x: s.k, y: s.T, z, colorscale: IV_SCALE, cmin: zmin, cmax: zmax, colorbar: { title: { text: 'IV %' }, len: 0.6, thickness: 14 }, contours: { z: { show: false } }, hovertemplate: 'k=%{x:.3f}<br>T=%{y:.3f}y<br>IV=%{z:.1f}%<extra></extra>' },
    { type: 'scatter3d', mode: 'lines', x: s.T.map(() => 0), y: s.T, z: s.T.map((_, i) => z[i][j0] + 0.15), line: { color: '#e5484d', width: 5, dash: 'dash' }, name: 'ATM', hoverinfo: 'skip', showlegend: false },
    ...(up ? [up.t3] : []),
  ], baseLayout({ margin: { l: 0, r: 0, t: 40, b: 0 }, title: { text: `${s.label} implied volatility surface — spot ${s.spot.toLocaleString()} · ${s.asof}`, font: { size: 14 } },
    scene: { ...sceneStyle('Log-moneyness ln(K/S)', 'Time to expiry (years)', 'Implied vol (%)'), zaxis: { ...sceneStyle('', '', 'Implied vol (%)').zaxis, range: [zmin, up ? Math.max(zmax, up.zTop) : zmax] } } }));
  const idx = [0, Math.floor(s.T.length / 2), s.T.length - 1];
  draw('smilePlot', [...idx.map((i, n) => ({ x: s.k, y: z[i], mode: 'lines', name: `T = ${(s.T[i] * 365).toFixed(0)}d`, line: { color: COLORS[n], width: 2 } })), ...(up ? [up.t2d] : [])],
    baseLayout({ title: { text: 'Volatility smile / skew by maturity', font: { size: 13 } }, xaxis: { title: 'Log-moneyness ln(K/S)', gridcolor: GRID }, yaxis: { title: 'Implied vol (%)', gridcolor: GRID }, shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#e5484d', dash: 'dash', width: 1 } }], margin: { l: 56, r: 16, t: 34, b: 60 } }));
}

// ---------------------------------------------------------------- ticker + chain
async function loadTicker() {
  const t = $('ticker').value.trim();
  if (!t) return;
  const st = $('tickerStatus'); st.className = 'hint'; st.textContent = 'Loading…'; $('loadTicker').disabled = true;
  try {
    const q = await D.getQuote(t);
    state.ticker = t; state.chain = null; state.premAuto = true; // the premium box follows the model's recommended price until the user types their own
    $('premium').value = ''; // a premium typed for the previous ticker means nothing here
    $('S').value = +q.spot.toFixed(4);
    $('r').value = +(q.rate * 100).toFixed(3);
    $('q').value = +(q.div_yield * 100).toFixed(3);
    const v1 = q.iv30 ?? q.hist_vol_1y ?? q.hist_vol; // 30-day implied vol when the data source has it (it is what the options market is pricing today)
    $('sigma').value = +(v1 * 100).toFixed(2);
    if (!Number.isFinite(parseFloat($('K').value)) || document.activeElement !== $('K')) $('K').value = Math.round(q.spot);
    st.className = 'hint good';
    st.textContent = `${q.name || q.ticker} · spot ${q.spot.toLocaleString()} · r ${(q.rate * 100).toFixed(2)}% · q ${(q.div_yield * 100).toFixed(2)}% · as of ${q.asof} (${{ live: 'live', cboe: 'live, 15-min delayed (Cboe)', snapshot: 'snapshot' }[q.source] || 'live'})${q.source === 'cboe' ? ' · dividend yield estimated from put-call parity' : ''}`;
    const chips = $('volChips'); chips.hidden = false; chips.innerHTML = '';
    [['30-day implied vol', q.iv30], ['30d hist vol', q.hist_vol], ['1y hist vol', q.hist_vol_1y]].forEach(([l, v]) => { if (!Number.isFinite(v)) return; const b = document.createElement('button'); b.className = 'chip'; b.textContent = `σ = ${l} ${(v * 100).toFixed(1)}%`; b.onclick = () => { $('sigma').value = +(v * 100).toFixed(2); update(); }; chips.appendChild(b); });
    const sel = $('expirySel'); $('chainPick').hidden = !(q.expiries && q.expiries.length);
    sel.innerHTML = '<option value="">Choose a real expiry…</option>' + (q.expiries || []).map((e) => `<option value="${e}">${e} (${Math.max(0, Math.round((new Date(e) - Date.now()) / 864e5))}d)</option>`).join('');
    $('strikeSel').innerHTML = '';
    $('surfTicker').value = t.toUpperCase().replace('^', '');
    // a normal starting option: the first listed expiry at least 25 days out (no expiry list, e.g. snapshots: keep the days box as it is)
    const dayOf = (e) => (Date.parse(e + 'T20:00:00Z') - Date.now()) / 864e5, def = (q.expiries || []).find((e) => dayOf(e) >= 25);
    if (def) $('days').value = +dayOf(def).toFixed(2);
    update();
  } catch (e) { st.className = 'hint bad'; st.textContent = e.message; }
  $('loadTicker').disabled = false;
}

async function loadExpiry() {
  const e = $('expirySel').value; if (!e) return;
  try {
    const ch = await D.getChain(state.ticker, e);
    state.chain = ch; state.chainExpiry = e;
    $('days').value = +(ch.T * 365).toFixed(2);
    fillStrikes();
    update();
  } catch (err) { $('tickerStatus').className = 'hint bad'; $('tickerStatus').textContent = err.message; }
}
function fillStrikes() {
  if (!state.chain) return;
  const S = parseFloat($('S').value);
  const rows = state.chain.rows.filter((r) => r.type === state.type && r.strike > S * 0.6 && r.strike < S * 1.4).sort((a, b) => a.strike - b.strike);
  $('strikeSel').innerHTML = '<option value="">Choose a real contract…</option>' + rows.map((r) => `<option value="${r.strike}">${r.strike}  ·  ${r.bid}/${r.ask}  ·  IV ${(r.impliedVolatility * 100).toFixed(1)}%</option>`).join('');
}
function pickStrike() {
  const k = parseFloat($('strikeSel').value); if (!state.chain || !k) return;
  const r = state.chain.rows.find((x) => x.type === state.type && x.strike === k); if (!r) return;
  state.premAuto = false; // the market's own price replaces the recommended one
  $('K').value = k;
  const mid = r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : r.lastPrice;
  $('premium').value = +mid.toFixed(4);
  update();
}

// ---------------------------------------------------------------- your premium: implied vol, edge, banner
const getPremium = () => { const v = parseFloat($('premium').value); return Number.isFinite(v) && v >= 0 ? v : NaN; };
// modelPrice = fair value at YOUR σ; effPrice = value at the analysis σ (the premium's σ when that switch is on)
const modelPrice = () => (cache ? (cache.p.style === 'american' ? cache.mod.am.price : cache.mod.bsm) : NaN);
const effPrice = () => (cache ? (cache.p.style === 'american' ? cache.am.price : cache.bsm) : NaN);
const paidPremium = () => { const m = getPremium(); return Number.isFinite(m) ? m : modelPrice(); };

// while premAuto is on, the premium box simply mirrors the model's fair value for the current inputs
function syncAutoPremium() {
  const raw = readRaw(); if (validate(raw)) return;
  try {
    const m = raw.style === 'american' ? P.americanPrice(raw.S, raw.K, raw.T, raw.r, raw.sigma, raw.q, raw.kind, raw.steps) : P.bsmPrice(raw.S, raw.K, raw.T, raw.r, raw.sigma, raw.q, raw.kind);
    if (Number.isFinite(m) && m >= 5e-5) $('premium').value = +m.toFixed(4);
  } catch { /* tree invalid at this sigma: leave the premium as it is */ }
}
function computeIV() {
  const prem = getPremium(), raw = readRaw();
  state.iv = NaN;
  if (!(prem > 0) || validate(raw)) return NaN;
  state.iv = raw.style === 'american' ? P.americanImpliedVol(prem, raw.S, raw.K, raw.T, raw.r, raw.q, raw.kind, 200) : P.impliedVol(prem, raw.S, raw.K, raw.T, raw.r, raw.q, raw.kind);
  // A premium equal to the fair value (to the 4 decimals we display) IS your σ. Without this, rounding the fair value would imply a slightly different σ,
  // which for deep in-the-money options (tiny vega) can be a visible amount.
  try {
    const m0 = raw.style === 'american' ? P.americanPrice(raw.S, raw.K, raw.T, raw.r, raw.sigma, raw.q, raw.kind, raw.steps) : P.bsmPrice(raw.S, raw.K, raw.T, raw.r, raw.sigma, raw.q, raw.kind);
    if (Math.abs(prem - m0) < 5e-5) state.iv = raw.sigma;
  } catch { /* tree invalid at this σ: leave the implied vol as solved */ }
  return state.iv;
}
function syncBasisUI() {
  const prem = getPremium(), ok = Number.isFinite(state.iv) && state.iv > 0, raw = readRaw();
  document.querySelector('.seg button[data-k="basis"][data-v="market"]').disabled = !ok;
  const note = $('basisNote');
  if (!Number.isFinite(prem)) note.textContent = 'Type a premium (or press “Use recommended”) to compare it with the model σ.';
  else if (!ok) note.textContent = 'This premium is outside the no-arbitrage bounds, so no volatility fits it. Everything uses the model σ.';
  else if (state.basis === 'market') note.textContent = `Greeks, payoff, what-if and the Greek surface use ${pct(state.iv, 2)}, the σ implied by your premium. The fair value above still uses the model σ (${pct(raw.sigma, 2)}).`;
  else note.textContent = `Greeks, payoff, what-if and the Greek surface use the model σ (${pct(raw.sigma, 2)}). Your premium implies ${pct(state.iv, 2)}.`;
}
function renderFair() {
  const c = cache, box = $('fairBox');
  if (!c) { box.hidden = true; return; }
  const m = modelPrice(), prem = getPremium();
  box.hidden = false;
  $('fairVal').textContent = fmt(m, 4);
  $('fairSig').textContent = pct(c.raw.sigma, 1);
  $('premium').placeholder = `Recommended ${fmt(m, 4)}. Type yours…`;
  const atFair = Number.isFinite(prem) && Math.abs(prem - m) < 5e-5, worthless = m < 5e-5; // a premium of 0 has no implied vol, so there is nothing to start from
  $('fairUse').textContent = atFair ? 'Using recommended' : worthless ? 'Model ≈ 0' : 'Use recommended';
  $('fairUse').disabled = atFair || worthless;
  $('premAutoNote').textContent = state.premAuto ? 'Filled in with the recommended price. Type your own premium (or drag the slider) and everything below updates: implied volatility, Greeks, charts and surfaces.' : Number.isFinite(prem) ? 'This is your own premium. “Use recommended” puts the model’s price back.' : '';
}
function renderIvBox() {
  const box = $('ivReadout'), prem = getPremium(), raw = readRaw(), iv = state.iv;
  if (!Number.isFinite(prem) || validate(raw)) { box.hidden = true; return; }
  box.hidden = false;
  if (!(prem > 0)) { box.textContent = 'Enter a premium above 0.'; return; }
  if (!Number.isFinite(iv)) { box.textContent = 'No volatility reproduces this premium: it is outside the no-arbitrage bounds (below intrinsic/forward value or above the underlying).'; return; }
  const same = Math.abs(iv - raw.sigma) < 5e-4; // within 0.05 vol points: the same number at the precision shown, so do not claim "more" or "less"
  box.innerHTML = `Implied vol (${raw.style}): <b>${(iv * 100).toFixed(2)}%</b> <button class="chip" id="useIv">use as model σ</button><br><span class="hint">vs model σ ${(raw.sigma * 100).toFixed(2)}% → ${same ? 'this premium matches the model σ' : iv > raw.sigma ? 'this premium prices in MORE vol than the model σ' : 'this premium prices in LESS vol than the model σ'}</span>`;
  $('useIv').onclick = () => { $('sigma').value = +(iv * 100).toFixed(3); update(); };
}
function syncSlider() {
  const sl = $('premSlider'), prem = getPremium();
  if (!cache) return;
  const { p } = cache, ref = P.bsmPrice(p.S, p.K, p.T, p.r, 0.5, p.q, p.kind); // range independent of sigma and premium, so dragging is stable
  const max = Math.max(0.05, ref, Number.isFinite(prem) ? prem * 1.25 : 0);
  sl.max = max.toFixed(4); sl.step = (max / 500).toFixed(5);
  sl.value = Number.isFinite(prem) ? prem : modelPrice();
  sl.style.opacity = Number.isFinite(prem) ? 1 : 0.45;
  const m = modelPrice(); $('premium').step = m >= 50 ? 1 : m >= 5 ? 0.1 : 0.01; // arrow keys nudge the premium by a sensible amount
}
function probProfit(p, prem, sigma = p.sigma) {
  const be = p.kind === 'call' ? p.K + prem : p.K - prem;
  if (be <= 0) return { be, pr: sgn() === 1 ? 0 : 1 };
  const [, d2] = P.d1d2(p.S, be, p.T, p.r, sigma, p.q);
  const pr = p.kind === 'call' ? P.N(d2) : P.N(-d2);
  return { be, pr: sgn() === 1 ? pr : 1 - pr };
}
// Why a premium can look "rich" or "cheap" against ONE flat sigma even when it is a perfectly normal market price:
// real vol changes with strike (skew) and with expiry (events such as earnings). Shown only when the two vols differ by 15% or more.
function volContext(p, raw, iv) {
  if (!Number.isFinite(iv) || !(raw.sigma > 0) || Math.abs(iv - raw.sigma) / raw.sigma < 0.15) return '';
  if (iv > raw.sigma) {
    if (p.kind === 'put' && Math.log(p.K / p.S) < -0.03) return 'Why “rich”? Out-of-the-money puts normally trade above the at-the-money vol (this is called skew): buyers pay extra for crash protection. So a premium that looks rich against one flat σ can be a normal market price. The Vol surface tab shows the market’s vol at this strike.';
    return 'The model σ is one flat number, but market vol changes with expiry and strike (an earnings date inside the option’s life, for example, adds to it). The Vol surface tab shows what the market charges at this strike and expiry.';
  }
  return 'The market charges less vol for this contract than the model σ. Market vol changes with strike and expiry, so one flat σ will not fit every contract; the Vol surface tab shows the market’s vol at this strike and expiry.';
}
function renderBanner() {
  const box = $('premBanner'), prem = getPremium(), c = cache;
  if (!c || !Number.isFinite(prem)) { box.hidden = true; return; }
  const { p, raw } = c, s = sgn(), model = modelPrice();
  const edge = s * (model - prem), edgePct = model > 0 ? edge / model : NaN;
  const verdict = Math.abs(edgePct) < 0.02 ? ['fair vs model', ''] : edge > 0 ? [s === 1 ? 'cheap vs model' : 'rich premium vs model', 'good'] : [s === 1 ? 'rich vs model' : 'thin premium vs model', 'bad'];
  const { be, pr } = probProfit(p, prem);
  const maxLoss = s === 1 ? fmt(prem, 2) : (p.kind === 'call' ? 'unbounded' : fmt(Math.max(p.K - prem, 0), 2));
  const maxGain = s === 1 ? (p.kind === 'call' ? 'unbounded' : fmt(Math.max(p.K - prem, 0), 2)) : fmt(prem, 2);
  const iv = state.iv;
  const cells = [
    ['lead', state.premAuto ? 'Recommended premium' : 'Your premium', fmt(prem, 4), `$${(prem * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} per contract · you ${s === 1 ? 'pay' : 'collect'}`, ''],
    ['', 'Edge vs model', Math.abs(edge) < 5e-5 ? '0.0000' : `${edge >= 0 ? '+' : '−'}${fmt(Math.abs(edge), 4)}`, `${Number.isFinite(edgePct) ? (Math.abs(edgePct * 100) < 0.05 ? '0.0' : (edgePct >= 0 ? '+' : '−') + Math.abs(edgePct * 100).toFixed(1)) + '% · ' : ''}${verdict[0]} (σ ${pct(raw.sigma, 1)})`, verdict[1]],
    ['', 'Implied vol', Number.isFinite(iv) ? pct(iv, 2) : '—', Number.isFinite(iv) ? `vs model σ ${pct(raw.sigma, 1)}` : 'no vol fits this premium', ''],
    ['', 'Breakeven (your premium)', fmt(be, 2), `${pct((be - p.S) / p.S, 1)} from spot at expiry`, ''],
    ['', 'P(profit)', pct(pr, 1), `at expiry, risk-neutral, σ ${pct(p.sigma, 1)}`, ''],
    ['', 'Max loss / gain', `${maxLoss} / ${maxGain}`, 'per share', ''],
  ];
  cells.push(['', `Greeks & charts at σ ${pct(p.sigma, 1)}`, `<button class="chip" id="toImpact2">See how they change →</button>`, p.sigma !== raw.sigma ? 'the σ your premium implies' : 'the model σ', '']);
  box.hidden = false;
  const ctx = volContext(p, raw, iv);
  box.innerHTML = cells.map(([cls, k, v, sub, tone]) => `<div class="cell ${cls}"><div class="k">${k}</div><div class="v ${tone}">${v}</div><div class="s">${sub}</div></div>`).join('') + (ctx ? `<div class="note" id="volContext">${ctx}</div>` : '');
  const jump = $('toImpact2'); if (jump) jump.onclick = () => setTab('impact');
}


// ---------------------------------------------------------------- premium impact: model sigma vs market-implied sigma
function snapshotAt(p, sigma, prem) {
  const s = sgn();
  let price, g;
  try {
    // same 200 steps as the implied-vol solver, so the market column reproduces your premium
    if (p.style === 'american') { const a = P.americanGreeks(p.S, p.K, p.T, p.r, sigma, p.q, p.kind, 200); price = a.price; g = a; }
  } catch { /* tree invalid at this vol: fall through to BSM */ }
  if (!g) { price = P.bsmPrice(p.S, p.K, p.T, p.r, sigma, p.q, p.kind); g = P.bsmGreeks(p.S, p.K, p.T, p.r, sigma, p.q, p.kind); }
  const [, d2] = P.d1d2(p.S, p.K, p.T, p.r, sigma, p.q);
  return {
    sigma, price, edge: s * (price - prem),
    delta: s * g.delta, gamma: s * g.gamma, vega: s * g.vega * 0.01, theta: s * g.theta / 365, rho: s * g.rho * 0.01,
    itm: p.kind === 'call' ? P.N(d2) : P.N(-d2), pprofit: probProfit(p, prem, sigma).pr,
  };
}
function impactTableHTML() {
  const c = cache, prem = getPremium(), iv = state.iv;
  if (!c || !Number.isFinite(prem) || !(prem > 0)) return '';
  const { p } = c;
  if (!Number.isFinite(iv)) return '<p class="hint bad">No volatility reproduces this premium (outside the no-arbitrage bounds), so there is nothing to compare.</p>';
  const a = snapshotAt(p, c.raw.sigma, prem), b = snapshotAt(p, iv, prem);
  const rows = [
    ['Volatility σ', pct(a.sigma, 2), pct(b.sigma, 2), `${b.sigma >= a.sigma ? '+' : '−'}${Math.abs((b.sigma - a.sigma) * 100).toFixed(2)} pts`],
    ['Model price at that σ', fmt(a.price, 4), fmt(b.price, 4), fmt(b.price - a.price, 4)],
    ['Edge vs your premium', fmt(a.edge, 4), fmt(b.edge, 4), fmt(b.edge - a.edge, 4)],
    ['Delta', fmt(a.delta, 4), fmt(b.delta, 4), fmt(b.delta - a.delta, 4)],
    ['Gamma', fmt(a.gamma, 5), fmt(b.gamma, 5), fmt(b.gamma - a.gamma, 5)],
    ['Vega (per vol pt)', fmt(a.vega, 4), fmt(b.vega, 4), fmt(b.vega - a.vega, 4)],
    ['Theta (per day)', fmt(a.theta, 4), fmt(b.theta, 4), fmt(b.theta - a.theta, 4)],
    ['Rho (per 1%)', fmt(a.rho, 4), fmt(b.rho, 4), fmt(b.rho - a.rho, 4)],
    ['P(finish ITM)', pct(a.itm, 1), pct(b.itm, 1), `${b.itm >= a.itm ? '+' : '−'}${Math.abs((b.itm - a.itm) * 100).toFixed(1)} pts`],
    ['P(profit) at your premium', pct(a.pprofit, 1), pct(b.pprofit, 1), `${b.pprofit >= a.pprofit ? '+' : '−'}${Math.abs((b.pprofit - a.pprofit) * 100).toFixed(1)} pts`],
  ];
  const be = probProfit(p, prem).be;
  state.impactRows = { a, b };
  return `<table class="tbl"><tr><th></th><th class="num">Model σ ${pct(a.sigma, 1)}</th><th class="num">My premium (σ implied by ${fmt(prem, 2)})</th><th class="num">Change</th></tr>` +
    rows.map(([k, x, y, d]) => `<tr><td>${k}</td><td class="num">${x}</td><td class="num">${y}</td><td class="num">${d}</td></tr>`).join('') +
    `<tr><td>Breakeven at expiry</td><td class="num" colspan="2" style="text-align:center">${fmt(be, 2)} (depends only on your premium)</td><td></td></tr></table>`;
}
function impactNotesHTML() {
  const { a, b } = state.impactRows || {}; if (!a) return '';
  const dir = b.sigma > a.sigma ? 'higher' : 'lower';
  const items = [
    `<li><b>Why the numbers move.</b> An option’s price rises with volatility and with nothing else you can vary here, so a premium different from the model price can only be explained by a <b>${dir} volatility</b>: <b>${pct(b.sigma, 1)}</b> instead of ${pct(a.sigma, 1)}. Every Greek is then re-evaluated at that volatility.</li>`,
    `<li><b>Delta</b> goes from ${fmt(a.delta, 3)} to ${fmt(b.delta, 3)}, <b>gamma</b> from ${fmt(a.gamma, 4)} to ${fmt(b.gamma, 4)}, <b>vega</b> from ${fmt(a.vega, 3)} to ${fmt(b.vega, 3)}, <b>theta</b> from ${fmt(a.theta, 3)} to ${fmt(b.theta, 3)} per day.</li>`,
    `<li><b>What did <i>not</i> change:</b> your breakeven, max loss and max gain. Those depend only on the premium and strike, not on any model.</li>`,
    `<li><b>Read the edge column carefully.</b> At the model σ the model says your side ${a.edge >= 0 ? 'gains' : 'loses'} ${fmt(Math.abs(a.edge), 3)} per share by transacting at this premium. At my premium’s σ the edge is ${fmt(b.edge, 3)}, i.e. zero by construction. The real question is whether ${pct(b.sigma, 1)} volatility is believable for this contract.</li>`,
  ];
  return `<ul>${items.join('')}</ul>`;
}
const IMPACT_CHARTS = [['iv', 'Implied volatility'], ['delta', 'Delta'], ['gamma', 'Gamma'], ['vega', 'Vega (per vol pt)'], ['theta', 'Theta (per day)'], ['pp', 'P(profit)']];
function renderImpact() {
  const c = cache; if (!c) return; const { p } = c;
  const prem = getPremium(), has = Number.isFinite(prem) && prem > 0;
  $('impactEmpty').hidden = has; $('impactBody').hidden = !has;
  if (!has) return;
  $('impactTable').innerHTML = impactTableHTML();
  $('impactNotes').innerHTML = impactNotesHTML();
  const s = sgn(), model = P.bsmPrice(p.S, p.K, p.T, p.r, c.raw.sigma, p.q, p.kind);
  const [lo, hi] = P.noArbBounds(p.S, p.K, p.T, p.r, p.q, p.kind);
  const xLo = Math.max(lo + 0.002 * (hi - lo), Math.min(0.2 * model, prem * 0.8)), xHi = Math.min(hi - 0.002 * (hi - lo), Math.max(3 * model, prem * 1.3));
  const xs = linspace(xLo, xHi, 60);
  const pts = xs.map((x) => {
    const iv = P.impliedVol(x, p.S, p.K, p.T, p.r, p.q, p.kind);
    if (!Number.isFinite(iv)) return null;
    const g = P.bsmGreeks(p.S, p.K, p.T, p.r, iv, p.q, p.kind);
    return { x, iv: iv * 100, delta: s * g.delta, gamma: s * g.gamma, vega: s * g.vega * 0.01, theta: s * g.theta / 365, pp: probProfit(p, x, iv).pr * 100 };
  }).filter((q) => q && q.iv <= Math.max(300, 130 * (state.iv || 0)));  // keep the y-axes readable when the premium approaches its upper bound
  const grid = $('impactGrid');
  if (!grid.children.length) IMPACT_CHARTS.forEach(([k]) => { const d = document.createElement('div'); d.className = 'g'; d.id = 'imp-' + k; grid.appendChild(d); });
  IMPACT_CHARTS.forEach(([k, label], i) => {
    const line = (x, color, dash) => ({ type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1, line: { color, dash, width: 1.4 } });
    draw('imp-' + k, [{ x: pts.map((q) => q.x), y: pts.map((q) => q[k]), mode: 'lines', line: { color: COLORS[i % COLORS.length], width: 2.4 }, showlegend: false, hovertemplate: `premium %{x:.3f}<br>${label} %{y:.4f}<extra></extra>` }],
      baseLayout({ title: { text: label, font: { size: 13 } }, margin: { l: 50, r: 8, t: 30, b: 40 }, xaxis: { title: { text: 'Premium', font: { size: 11 } }, gridcolor: GRID }, yaxis: { gridcolor: GRID }, shapes: [line(model, TXT, 'dash'), line(prem, COLORS[0], 'solid')],
        annotations: [
          { x: model, y: 1, yref: 'paper', text: 'model', showarrow: false, xanchor: model <= prem ? 'left' : 'right', xshift: model <= prem ? 4 : -4, yanchor: 'top', font: { size: 10, color: TXT } },
          { x: prem, y: 1, yref: 'paper', text: 'yours', showarrow: false, xanchor: model <= prem ? 'right' : 'left', xshift: model <= prem ? -4 : 4, yanchor: 'top', font: { size: 10, color: COLORS[0] } },
        ] }));
  });
}

// ---------------------------------------------------------------- what-if tab
function valueAt(p, S, T, sigma) {
  if (T <= 1e-9) return P.intrinsic(S, p.K, p.kind);
  if (p.style === 'american') {
    try { return P.americanPrice(S, p.K, T, p.r, sigma, p.q, p.kind, Math.min(p.steps, 300)); } catch { /* tree invalid at this vol/time: fall back to BSM */ }
  }
  return P.bsmPrice(S, p.K, T, p.r, sigma, p.q, p.kind);
}
function wfRange(steps, total) { // running totals of the waterfall, padded 22% each side (and always including 0)
  let run = 0; const lv = [0, total];
  steps.forEach((v) => { run += v; lv.push(run); });
  const lo = Math.min(...lv), hi = Math.max(...lv), pad = Math.max(hi - lo, 0.02) * 0.22; // never a zero-width axis (it printed nano-scale ticks like ±200n)
  return [lo - pad, hi + pad];
}
function renderWhatIf() {
  const c = cache; if (!c) return; const { p } = c, s = sgn();
  const daysTotal = Math.max(1, Math.round(p.T * 365));
  const wd = $('wiDays'); wd.max = daysTotal; if (+wd.value > daysTotal) wd.value = daysTotal;
  const ds = parseFloat($('wiSpot').value), dv = parseFloat($('wiVol').value), dd = parseFloat(wd.value);
  $('wiSpotOut').textContent = `${ds >= 0 ? '+' : ''}${ds}%`;
  $('wiVolOut').textContent = `${dv >= 0 ? '+' : ''}${dv} pts`;
  $('wiDaysOut').textContent = `${dd} of ${daysTotal}`;
  $('wiBasisNote').textContent = `Scenarios start from σ = ${pct(p.sigma, 2)}${p.sigma !== c.raw.sigma ? ', the volatility implied by your premium' : ' (the model σ)'}. ${p.sigma !== c.raw.sigma ? 'Switch to “Model σ” in the left panel to value them at the model σ instead.' : ''}`;
  const paid = paidPremium(), now = effPrice();
  const S1 = p.S * (1 + ds / 100), sig1 = Math.max(0.01, p.sigma + dv / 100), T1 = p.T - dd / 365;
  const val1 = valueAt(p, S1, T1, sig1);
  const pnl = s * (val1 - paid);
  const cls = pnl > 1e-9 ? 'good' : pnl < -1e-9 ? 'bad' : '';
  $('wiStats').innerHTML = [
    ['Option value then', fmt(val1, 4), T1 <= 1e-9 ? 'at expiry = intrinsic' : `S ${fmt(S1, 2)} · σ ${pct(sig1, 1)} · ${Math.round(T1 * 365)}d left`, ''],
    ['Your P&L / share', `${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl), 4)}`, state.side === 'long' ? 'value then − premium paid' : 'premium collected − value then', cls],
    ['P&L / contract', `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`, '100 shares', cls],
    ['Return on premium', paid > 0 ? `${pnl >= 0 ? '+' : '−'}${Math.abs((pnl / paid) * 100).toFixed(1)}%` : '—', Number.isFinite(getPremium()) ? 'on your premium' : 'no premium entered: using model price', cls],
  ].map(([k, v, sub, tone]) => `<div class="stat"><div class="k">${k}</div><div class="v ${tone}">${v}</div><div class="s">${sub}</div></div>`).join('');

  // attribution of the move: entry edge, then Greeks
  const g = p.style === 'american' && Number.isFinite(c.ag.delta) ? c.ag : c.g, dS = S1 - p.S, dT = dd / 365;
  const parts = [
    ['Edge at entry', s * (now - paid)],
    ['Delta', s * g.delta * dS],
    ['Gamma', s * 0.5 * g.gamma * dS * dS],
    ['Vega', s * g.vega * (sig1 - p.sigma)],
    ['Theta', s * g.theta * dT],
  ];
  const explained = parts.reduce((a, [, v]) => a + v, 0);
  parts.push(['Other (higher order)', pnl - explained]);
  draw('wiWaterfall', [{
    type: 'waterfall', orientation: 'v', x: [...parts.map((x) => x[0]), 'Total P&L'], y: [...parts.map((x) => x[1]), 0],
    measure: [...parts.map(() => 'relative'), 'total'],
    increasing: { marker: { color: '#3fae78' } }, decreasing: { marker: { color: '#e5484d' } }, totals: { marker: { color: COLORS[0] } },
    connector: { line: { color: ZERO } }, text: [...parts.map((x) => (x[1] >= 0 ? '+' : '') + x[1].toFixed(3)), (pnl >= 0 ? '+' : '') + pnl.toFixed(3)], textposition: 'outside', cliponaxis: false,
  }], baseLayout({ yaxis: { title: 'P&L per share', gridcolor: GRID, zerolinecolor: ZERO, range: wfRange(parts.map((x) => x[1]), pnl) }, xaxis: { gridcolor: 'rgba(0,0,0,0)' }, margin: { l: 60, r: 16, t: 24, b: 50 }, showlegend: false }));

  // heat map: spot move x (days passed | vol change)
  const mode = $('wiHeat').value;
  const xs = linspace(-30, 30, 41);
  const ys = mode === 'days' ? linspace(0, daysTotal, Math.min(daysTotal + 1, 25)).map((v) => Math.round(v)) : linspace(-20, 20, 21);
  const z = ys.map((y) => xs.map((x) => {
    const S2 = p.S * (1 + x / 100);
    const T2 = mode === 'days' ? p.T - y / 365 : p.T - dd / 365;
    const sg = mode === 'days' ? sig1 : Math.max(0.01, p.sigma + y / 100);
    const v = T2 <= 1e-9 ? P.intrinsic(S2, p.K, p.kind) : P.bsmPrice(S2, p.K, T2, p.r, sg, p.q, p.kind);
    return s * (v - paid);
  }));
  const zmax = Math.max(...z.flat().map(Math.abs)) || 1;
  draw('wiHeatmap', [
    { type: 'heatmap', x: xs, y: ys, z, zmin: -zmax, zmax, colorscale: [[0, '#e5484d'], [0.5, '#12161b'], [1, '#3fae78']], colorbar: { title: { text: 'P&L' }, thickness: 12, len: 0.8 }, hovertemplate: 'spot %{x:+.1f}%<br>' + (mode === 'days' ? '%{y}d passed' : 'vol %{y:+.1f} pts') + '<br>P&L %{z:.3f}<extra></extra>' },
    { type: 'scatter', mode: 'markers', x: [ds], y: [mode === 'days' ? dd : dv], marker: { color: COLORS[0], size: 11, line: { color: '#000', width: 1.5 } }, hoverinfo: 'skip', showlegend: false },
  ], baseLayout({ xaxis: { title: 'Spot move (%)', gridcolor: 'rgba(0,0,0,0)' }, yaxis: { title: mode === 'days' ? 'Days passed' : 'Volatility change (pts)', gridcolor: 'rgba(0,0,0,0)' }, margin: { l: 60, r: 16, t: 16, b: 50 }, showlegend: false,
    shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: TXT, dash: 'dot', width: 1 } }] }));
}

// ---------------------------------------------------------------- wiring
let renderTimer;
function update() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    state.lsmc = null; $('lsmcStatus').textContent = '';
    try {
      if (state.premAuto) syncAutoPremium();
      computeIV(); compute(); syncBasisUI(); renderFair(); syncSlider(); renderHero(); renderBanner(); renderIvBox(); renderSummary(); renderCurrentTab();
    } catch (e) { showError(e.message); }
  }, 120);
}
function renderCurrentTab() {
  if (!cache) return;
  ({ overview: renderOverview, greeks: renderGreeks, payoff: renderPayoff, whatif: renderWhatIf, impact: renderImpact, tree: renderTree, checks: renderChecks, surface: () => { if (state.surf) { drawSurface(state.surf); maybeWidenSurface(); } }, how: () => {}, guide: () => {} }[state.tab])();
}
function setTab(t) {
  state.tab = t;
  const nav = $('tabsNav');
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
    if (on) nav.scrollTo({ left: b.offsetLeft - (nav.clientWidth - b.clientWidth) / 2, behavior: REDUCED ? 'auto' : 'smooth' });
  });
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + t));
  renderCurrentTab();
  if (t === 'surface' && !$('surfacePlot').data) loadSurface();
  if (t === 'guide') loadGuide();
  // keep the sticky tab bar in view: only scroll when the reader is already below the results header
  const top = nav.getBoundingClientRect().top + window.scrollY - 96;
  if (window.scrollY > top + 4) window.scrollTo({ top, behavior: REDUCED ? 'auto' : 'smooth' });
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------- UI helpers: toast, tooltips, presets, share, summary
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function setSeg(k, v) {
  state[k] = v;
  document.querySelectorAll(`.seg button[data-k="${k}"]`).forEach((b) => {
    const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function initTooltips() {
  const tt = $('tooltip');
  const hide = () => { tt.classList.remove('show'); tt.setAttribute('aria-hidden', 'true'); };
  const show = (el) => {
    tt.textContent = el.dataset.tip; tt.classList.add('show'); tt.setAttribute('aria-hidden', 'false');
    const r = el.getBoundingClientRect(), w = tt.offsetWidth, h = tt.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let y = r.top - h - 10; if (y < 8) y = r.bottom + 10;
    tt.style.left = x + 'px'; tt.style.top = y + 'px';
  };
  document.querySelectorAll('.tip').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el)); el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', () => show(el)); el.addEventListener('blur', hide);
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (tt.classList.contains('show')) hide(); else show(el); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('click', hide);
}

const PRESETS = {
  slide: { type: 'call', side: 'long', style: 'european', S: 100, K: 100, days: 365, sigma: 20, r: 5, q: 0, premium: '', label: 'Loaded the class example: 1-year at-the-money call' },
  amput: { type: 'put', side: 'long', style: 'american', S: 100, K: 100, days: 365, sigma: 20, r: 5, q: 0, premium: 6.0896, label: 'Loaded an American put priced at 6.0896 (implied vol ≈ 20%)' },
  deep: { type: 'call', side: 'long', style: 'european', S: 200, K: 100, days: 365, sigma: 20, r: 5, q: 0, premium: 150, label: 'Loaded: model says 104.88, market asks 150' },
};
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  state.premAuto = false;
  setSeg('type', p.type); setSeg('side', p.side); setSeg('style', p.style);
  ['S', 'K', 'days', 'sigma', 'r', 'q'].forEach((id) => { $(id).value = p[id]; });
  $('premium').value = p.premium; setSeg('basis', 'market'); $('steps').value = 500; $('stepsOut').textContent = '500';
  state.chain = null; $('chainPick').hidden = true; $('volChips').hidden = true;
  update(); setTab('overview'); toast(p.label);
}

function shareURL() {
  const u = new URL(location.href); u.search = ''; u.hash = '';
  const q = new URLSearchParams();
  ['type', 'side', 'style'].forEach((k) => q.set(k, state[k]));
  ['S', 'K', 'days', 'sigma', 'r', 'q', 'steps'].forEach((id) => q.set(id, $(id).value));
  if ($('premium').value !== '') q.set('premium', $('premium').value);
  if (state.basis !== 'market') q.set('basis', state.basis);
  u.search = q.toString(); if (state.tab !== 'overview') u.hash = state.tab;
  return u.toString();
}
function restoreFromURL() {
  const q = new URLSearchParams(location.search); let any = false;
  ['type', 'side', 'style'].forEach((k) => { const v = q.get(k); if (v && document.querySelector(`.seg button[data-k="${k}"][data-v="${v}"]`)) { setSeg(k, v); any = true; } });
  ['S', 'K', 'days', 'sigma', 'r', 'q', 'steps'].forEach((id) => { const v = q.get(id); if (v !== null && Number.isFinite(parseFloat(v))) { $(id).value = v; any = true; } });
  $('stepsOut').textContent = $('steps').value;
  const pr = q.get('premium'); if (pr !== null && Number.isFinite(parseFloat(pr))) { $('premium').value = pr; any = true; }
  if (q.get('basis') === 'model') setSeg('basis', 'model');
  return any;
}
async function copyShareLink() {
  const url = shareURL();
  try { await navigator.clipboard.writeText(url); toast('Link copied. It restores these inputs.'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Link copied. It restores these inputs.'); } catch { toast('Could not copy. Copy the address bar instead.'); }
    ta.remove();
  }
}

function renderSummary() {
  const c = cache, line = $('summaryLine'), mb = $('mbar');
  if (!c) { line.innerHTML = ''; mb.hidden = true; return; }
  const { p } = c;
  const chips = [
    ['lead', `${state.side === 'long' ? 'Long' : 'Short'} ${p.style === 'american' ? 'American' : 'European'} ${p.kind}`],
    ['', `S ${fmt(p.S, 2)}`], ['', `K ${fmt(p.K, 2)}`], ['', `${+(p.T * 365).toFixed(1)} d`],
    [p.sigma !== c.raw.sigma ? 'warn' : '', p.sigma !== c.raw.sigma ? `σ ${pct(p.sigma, 1)} from premium` : `σ ${pct(p.sigma, 1)}`], ['', `r ${pct(p.r, 2)}`], ['', `q ${pct(p.q, 2)}`],
  ];
  line.innerHTML = chips.map(([cls, t]) => `<span class="sum-chip ${cls}">${t}</span>`).join('');
  $('mbLabel').textContent = `${p.style === 'american' ? 'American' : 'European'} ${p.kind} premium`;
  $('mbPrice').textContent = fmt(modelPrice(), 4);
  mb.hidden = false; // CSS shows the bar on small screens only
}
function initGlass() {
  const root = document.documentElement, btn = $('glassToggle');
  try { const v = localStorage.getItem('pricer.glass'); if (v === 'on' || v === 'off') root.dataset.glass = v; } catch { /* private mode */ }
  const osReduced = () => window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  const isOn = () => (root.dataset.glass ? root.dataset.glass === 'on' : !osReduced());
  const paint = () => {
    btn.setAttribute('aria-pressed', String(isOn()));
    btn.title = isOn() ? 'Glass effects are on. Click to turn them off.' : 'Glass effects are off' + (osReduced() ? ' (your system reduces transparency)' : '') + '. Click to turn them on.';
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => {
    const next = isOn() ? 'off' : 'on'; root.dataset.glass = next;
    try { localStorage.setItem('pricer.glass', next); } catch { /* ignore */ }
    paint(); toast(`Glass effects ${next}`);
  });
  paint();
  // one-time hint: the OS asks browsers to reduce transparency, so the glass starts off until the visitor opts in
  let seen = false; try { seen = localStorage.getItem('pricer.glassHint') === '1'; } catch { /* ignore */ }
  if (osReduced() && !root.dataset.glass && !seen) {
    setTimeout(() => { toast('Your system reduces transparency, so glass effects start off. Tap the layers icon in the header to turn them on.', 7000); try { localStorage.setItem('pricer.glassHint', '1'); } catch { /* ignore */ } }, 1500);
  }
}
function initWelcome(restored) {
  let dismissed = false;
  try { dismissed = localStorage.getItem('pricer.welcomeDismissed') === '1'; } catch { /* private mode */ }
  $('welcome').hidden = dismissed || restored;
  $('welcomeClose').addEventListener('click', () => { $('welcome').hidden = true; try { localStorage.setItem('pricer.welcomeDismissed', '1'); } catch { /* ignore */ } });
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('welcomeGuide').addEventListener('click', (e) => { e.preventDefault(); setTab('guide'); });
}

function init() {
  $('howText').innerHTML = HOW;
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    setSeg(b.dataset.k, b.dataset.v);
    if (b.dataset.k === 'type') fillStrikes();
    update();
  }));
  ['S', 'K', 'days', 'sigma', 'r', 'q'].forEach((id) => $(id).addEventListener('input', update));
  $('premium').addEventListener('input', () => { state.premAuto = false; update(); }); // typing your own premium stops the auto-fill
  $('premSlider').addEventListener('input', () => { state.premAuto = false; $('premium').value = (+$('premSlider').value).toFixed(4); update(); });
  $('fairUse').addEventListener('click', () => { state.premAuto = true; update(); });
  $('greekLines').addEventListener('change', renderGreeks);
  $('greekSurfMode').addEventListener('change', renderGreekSurface);
  document.querySelectorAll('#premChips .chip').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.p, model = modelPrice();
    if (v === 'clear') { state.premAuto = false; $('premium').value = ''; }
    else if (v === 'model') { state.premAuto = true; }
    else if (Number.isFinite(model)) { state.premAuto = false; $('premium').value = +Math.max(model * (1 + parseFloat(v)), 0).toFixed(4); } // always relative to the MODEL price, so +10% then -10% is not a random walk
    update();
  }));
  ['wiSpot', 'wiVol', 'wiDays'].forEach((id) => $(id).addEventListener('input', renderWhatIf));
  $('wiHeat').addEventListener('change', renderWhatIf);
  $('steps').addEventListener('input', () => { $('stepsOut').textContent = $('steps').value; update(); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('loadTicker').addEventListener('click', loadTicker);
  $('ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTicker(); });
  $('expirySel').addEventListener('change', () => loadExpiry());
  $('strikeSel').addEventListener('change', pickStrike);
  $('greekX').addEventListener('change', renderGreeks);
  $('greek3d').addEventListener('change', renderGreekSurface);
  $('loadSurface').addEventListener('click', loadSurface);
  $('surfTicker').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSurface(); });
  $('apiBase').value = D.getApiBase();
  $('saveApi').addEventListener('click', async () => { D.setApiBase($('apiBase').value.trim()); D.resetApiProbe(); await refreshPill(); });
  $('runLsmc').addEventListener('click', () => {
    if (!cache) return; const { p } = cache;
    $('runLsmc').disabled = true; $('lsmcStatus').textContent = 'simulating…';
    setTimeout(() => {
      const t0 = performance.now();
      state.lsmc = P.lsmcPrice(p.S, p.K, p.T, p.r, p.sigmaModel, p.q, p.kind, parseInt($('lsmcPaths').value, 10), Math.max(20, Math.min(100, Math.round(p.T * 100))));
      $('lsmcStatus').textContent = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      $('runLsmc').disabled = false; renderOverview();
    }, 30);
  });
  $('toImpact').addEventListener('click', () => setTab('impact'));
  $('guideLink').addEventListener('click', (e) => { e.preventDefault(); setTab('guide'); });
  $('tabsNav').addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('.tabs button')], i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
    if (n !== null) { e.preventDefault(); tabs[n].focus(); setTab(tabs[n].dataset.tab); }
  });
  const nav = $('tabsNav');
  const edges = () => { // fade the tab bar's edges only where more tabs are hidden
    const max = nav.scrollWidth - nav.clientWidth, x = nav.scrollLeft, canScroll = max > 2;
    nav.classList.toggle('more', canScroll && x < max - 2 && x <= 2);
    nav.classList.toggle('start', canScroll && x > 2 && x < max - 2);
    nav.classList.toggle('end', canScroll && x >= max - 2);
  };
  nav.addEventListener('scroll', edges, { passive: true }); window.addEventListener('resize', edges); setTimeout(edges, 300);
  $('shareBtn').addEventListener('click', copyShareLink);
  $('mbInputs').addEventListener('click', () => $('inputsPanel').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }));
  $('mbResults').addEventListener('click', () => $('main').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }));
  initTooltips();
  initGlass();
  const restored = restoreFromURL();
  initWelcome(restored);
  const hashTab = location.hash.replace('#', '');
  refreshPill();
  update();
  if (['overview', 'impact', 'greeks', 'payoff', 'whatif', 'tree', 'surface', 'checks', 'guide', 'how'].includes(hashTab)) setTab(hashTab);
}

async function refreshPill() {
  const pill = $('dataPill');
  const base = await D.detectApi();
  if (base !== null) { $('dataPillText').textContent = 'Live market data'; pill.className = 'pill live'; pill.setAttribute('aria-label', 'Market data: live, any ticker'); }
  else { $('dataPillText').textContent = 'Bundled snapshots'; pill.className = 'pill snap'; pill.setAttribute('aria-label', 'Market data: bundled Yahoo Finance snapshots'); }
  const snaps = await D.snapshotTickers();
  $('ticker').placeholder = base !== null ? 'Any ticker: AAPL, PLTR, BRK.B, SPX…' : `Ticker — ${snaps.filter((s) => s !== 'DEMO').slice(0, 5).join(', ')}…`;
}

init();
window.__pricer = { P, D, state, compute: () => compute() }; // handy for debugging in the console
