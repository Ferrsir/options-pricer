import * as P from './pricing.js';
import * as D from './data.js';

const $ = (id) => document.getElementById(id);
const state = { type: 'call', side: 'long', style: 'european', chain: null, chainExpiry: null, ticker: '', tab: 'overview', lsmc: null };
const COLORS = ['#f5a623', '#a9cf3f', '#3fae78', '#4aa3df', '#c77dff'];
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const pct = (x, d = 2) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
const sgn = () => (state.side === 'long' ? 1 : -1);

function readInputs() {
  const v = (id) => parseFloat($(id).value);
  return { S: v('S'), K: v('K'), T: v('days') / 365, r: v('r') / 100, sigma: v('sigma') / 100, q: v('q') / 100, steps: parseInt($('steps').value, 10), kind: state.type, style: state.style };
}
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
    font: { color: '#cbd2dc', size: 12 }, margin: { l: 56, r: 16, t: 34, b: 44 },
    xaxis: { gridcolor: '#252c36', zerolinecolor: '#3a4451' }, yaxis: { gridcolor: '#252c36', zerolinecolor: '#3a4451' },
    legend: { orientation: 'h', y: -0.22 },
  }, extra);
}
const draw = (id, data, layout, config = {}) => Plotly.react(id, data, layout, { responsive: true, displaylogo: false, ...config });
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// ---------------------------------------------------------------- compute + render
let cache = null;
function compute() {
  const p = readInputs();
  const err = validate(p);
  showError(err);
  if (err) { cache = null; return null; }
  try {
    const bsm = P.bsmPrice(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind);
    const g = P.bsmGreeks(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind);
    const eu = P.binomialTree(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind, p.steps, false);
    const am = P.binomialTree(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind, p.steps, true, true);
    const ag = P.americanGreeks(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind, Math.min(p.steps, 500));
    cache = { p, bsm, g, eu, am, ag, intrinsic: P.intrinsic(p.S, p.K, p.kind) };
  } catch (e) { showError(e.message); cache = null; }
  return cache;
}

function renderHero() {
  const c = cache; if (!c) { $('hero').innerHTML = ''; return; }
  const { p } = c;
  const price = p.style === 'american' ? c.am.price : c.bsm;
  const be = p.kind === 'call' ? p.K + price : p.K - price;
  const [, d2] = P.d1d2(p.S, p.K, p.T, p.r, p.sigma, p.q);
  const probItm = p.kind === 'call' ? P.N(d2) : P.N(-d2);
  const tv = price - c.intrinsic;
  const cards = [
    ['main', `${p.style === 'american' ? 'American' : 'European'} ${p.kind} premium`, fmt(price, 4), state.side === 'long' ? 'you pay per share' : 'you collect per share'],
    ['', 'Intrinsic value', fmt(c.intrinsic, 4), c.intrinsic > 0 ? 'in the money' : 'out of the money'],
    ['', 'Time value', fmt(tv, 4), `${((tv / price) * 100 || 0).toFixed(0)}% of premium`],
    ['', 'Breakeven', fmt(be, 2), `at expiry (${pct((be - p.S) / p.S, 1)} from spot)`],
    ['', 'P(finish ITM)', pct(probItm, 1), 'risk-neutral, N(±d2)'],
  ];
  $('hero').innerHTML = cards.map(([cls, k, v, s]) => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

function renderOverview() {
  const c = cache; if (!c) return;
  const { p } = c;
  const epe = c.am.price - c.eu.price;
  const mkt = parseFloat($('premium').value);
  const rows = [
    ['Black-Scholes-Merton (closed form)', c.bsm, 'European; the benchmark'],
    [`European tree (${p.steps} steps)`, c.eu.price, `error vs BSM ${(c.eu.price - c.bsm >= 0 ? '+' : '') + (c.eu.price - c.bsm).toFixed(5)}`],
    [`American tree (${p.steps} steps)`, c.am.price, `early-exercise premium ${(epe >= 0 ? '+' : '') + epe.toFixed(4)}`],
  ];
  if (state.lsmc) rows.push([`American LSMC (${state.lsmc.paths.toLocaleString()} paths)`, state.lsmc.price, `± ${(1.96 * state.lsmc.se).toFixed(4)} (95%); biased slightly low`]);
  if (Number.isFinite(mkt)) {
    const model = p.style === 'american' ? c.am.price : c.bsm;
    rows.push(['Market premium (yours)', mkt, `model − market = ${(model - mkt >= 0 ? '+' : '') + (model - mkt).toFixed(4)} at σ=${pct(p.sigma, 1)}`]);
  }
  $('modelTable').innerHTML = `<tr><th>Model</th><th class="num">Premium</th><th>Note</th></tr>` +
    rows.map(([n, v, why]) => `<tr><td>${n}</td><td class="num">${fmt(v, 4)}</td><td class="why">${why}</td></tr>`).join('');

  const s = sgn();
  const desc = {
    delta: ['Delta Δ', 'Change in premium per $1 move in spot. Also the hedge ratio and roughly P(ITM).', 1],
    gamma: ['Gamma Γ', 'Change in delta per $1 move in spot. Convexity; long options are long gamma.', 1],
    vega: ['Vega', 'Change in premium per 1 vol point (1%).', 0.01],
    theta: ['Theta Θ', 'Change in premium per calendar day; the rent paid for gamma.', 1 / 365],
    rho: ['Rho ρ', 'Change in premium per 1% move in the risk-free rate.', 0.01],
  };
  $('greeksNote').textContent = `${state.side} position — signs ${state.side === 'long' ? 'as you hold it' : 'flipped for the short side'}`;
  $('greekTable').innerHTML = `<tr><th>Greek</th><th class="num">BSM</th><th class="num">American tree</th><th>Meaning</th></tr>` +
    Object.entries(desc).map(([k, [name, why, sc]]) => `<tr><td>${name}</td><td class="num">${fmt(s * c.g[k] * sc, 4)}</td><td class="num">${fmt(s * c.ag[k] * sc, 4)}</td><td class="why">${why}</td></tr>`).join('');
}

function greekFn(name, p) {
  const scale = { vega: 0.01, theta: 1 / 365, rho: 0.01 };
  return (S, T, sigma) => (name === 'price' ? P.bsmPrice(S, p.K, T, p.r, sigma, p.q, p.kind) : P.bsmGreeks(S, p.K, T, p.r, sigma, p.q, p.kind)[name] * (scale[name] || 1)) * (name === 'price' ? 1 : sgn());
}
const GREEK_LABELS = { delta: 'Delta', gamma: 'Gamma', vega: 'Vega (per vol pt)', theta: 'Theta (per day)', rho: 'Rho (per 1%)', price: 'Premium' };

function renderGreeks() {
  const c = cache; if (!c) return; const { p } = c;
  const mode = $('greekX').value;
  const grid = $('greekGrid');
  if (!grid.children.length) Object.keys(GREEK_LABELS).forEach((k) => { const d = document.createElement('div'); d.className = 'g'; d.id = 'g-' + k; grid.appendChild(d); });
  const day = 1 / 365;
  let xs, series, xTitle, hint, vline;
  if (mode === 'spot') {
    xs = linspace(0.6 * p.K, 1.4 * p.K, 160); xTitle = 'Spot'; vline = p.K;
    series = [0.1, 0.25, 0.5, 1].map((f) => ({ name: `${Math.max(Math.round(p.T * 365 * f), 1)}d`, f: (x) => [x, Math.max(p.T * f, day), p.sigma] }));
    hint = 'One line per time to expiry. Gamma spikes at the strike and sharpens as expiry nears.';
  } else if (mode === 'time') {
    xs = linspace(1, Math.max(p.T * 365, 2), 160); xTitle = 'Days to expiry'; vline = null;
    series = [0.9, 1, 1.1].map((m) => ({ name: `S = ${(m * p.K).toFixed(1)}`, f: (x) => [m * p.K, x / 365, p.sigma] }));
    hint = 'One line per moneyness. Theta and gamma blow up for at-the-money options as expiry approaches.';
  } else {
    xs = linspace(0.05, 0.9, 160).map((x) => x); xTitle = 'Volatility'; vline = p.sigma;
    series = [0.9, 1, 1.1].map((m) => ({ name: `S = ${(m * p.K).toFixed(1)}`, f: (x) => [m * p.K, p.T, x] }));
    hint = 'Vega peaks near the money; higher vol pushes delta towards 0.5 and shrinks gamma.';
  }
  $('greekHint').textContent = hint;
  for (const name of Object.keys(GREEK_LABELS)) {
    const fn = greekFn(name, p);
    const traces = series.map((s, i) => ({ x: xs, y: xs.map((x) => fn(...s.f(x))), name: s.name, mode: 'lines', line: { color: COLORS[i % COLORS.length], width: 2 }, showlegend: name === 'delta' }));
    const layout = baseLayout({ title: { text: GREEK_LABELS[name], font: { size: 13 } }, margin: { l: 46, r: 8, t: 30, b: 36 }, xaxis: { title: { text: xTitle, font: { size: 11 } }, gridcolor: '#252c36' }, legend: { orientation: 'h', y: 1.28, font: { size: 10 } }, shapes: vline ? [{ type: 'line', x0: vline, x1: vline, yref: 'paper', y0: 0, y1: 1, line: { color: '#e5484d', dash: 'dash', width: 1 } }] : [] });
    draw('g-' + name, traces, layout);
  }
  renderGreekSurface();
}

function renderGreekSurface() {
  const c = cache; if (!c) return; const { p } = c;
  const g = $('greek3d').value, scale = { vega: 0.01, theta: 1 / 365, rho: 0.01 }[g] || 1;
  const S = linspace(0.7 * p.K, 1.3 * p.K, 60), T = linspace(0.02, Math.max(p.T, 0.25) * 1.5, 50);
  const z = T.map((t) => S.map((s) => P.bsmGreeks(s, p.K, t, p.r, p.sigma, p.q, p.kind)[g] * scale * sgn()));
  draw('greekSurface', [{ type: 'surface', x: S, y: T, z, colorscale: IV_SCALE, showscale: false, contours: { z: { show: true, usecolormap: true, project: { z: false } } } }],
    baseLayout({ margin: { l: 0, r: 0, t: 10, b: 0 }, scene: sceneStyle('Spot', 'Time to expiry (y)', GREEK_LABELS[g] || g) }));
}

const IV_SCALE = [[0, '#0b1f5c'], [0.17, '#1b4f9c'], [0.34, '#1a8a9c'], [0.5, '#3fae78'], [0.68, '#a9cf3f'], [0.84, '#f3c334'], [1, '#f59b2a']];
function sceneStyle(x, y, z) {
  const ax = (t) => ({ title: { text: t }, gridcolor: '#2b323c', backgroundcolor: '#0e1114', showbackground: true, zerolinecolor: '#3a4451', color: '#cbd2dc' });
  return { xaxis: ax(x), yaxis: ax(y), zaxis: ax(z), camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } }, aspectmode: 'manual', aspectratio: { x: 1.3, y: 1, z: 0.7 } };
}

function renderPayoff() {
  const c = cache; if (!c) return; const { p } = c;
  const s = sgn(), mkt = parseFloat($('premium').value);
  const paid = Number.isFinite(mkt) ? mkt : (p.style === 'american' ? c.am.price : c.bsm);
  const xs = linspace(0.6 * p.K, 1.4 * p.K, 200);
  const at = (T) => xs.map((x) => s * ((T <= 0 ? P.intrinsic(x, p.K, p.kind) : P.bsmPrice(x, p.K, T, p.r, p.sigma, p.q, p.kind)) - paid));
  const be = p.kind === 'call' ? p.K + paid : p.K - paid;
  const traces = [
    { x: xs, y: at(0), name: 'At expiry', line: { color: '#f5a623', width: 2.5 } },
    { x: xs, y: at(p.T / 2), name: 'Halfway to expiry', line: { color: '#a9cf3f', width: 1.6, dash: 'dot' } },
    { x: xs, y: at(p.T), name: 'Today', line: { color: '#4aa3df', width: 2 } },
  ].map((t) => ({ ...t, mode: 'lines' }));
  draw('payoffPlot', traces, baseLayout({ title: `${state.side} ${p.kind} K=${p.K}, premium ${fmt(paid, 2)}`, xaxis: { title: 'Underlying price', gridcolor: '#252c36' }, yaxis: { title: 'Profit / loss per share', gridcolor: '#252c36', zerolinecolor: '#5a6572' },
    shapes: [{ type: 'line', x0: p.S, x1: p.S, yref: 'paper', y0: 0, y1: 1, line: { color: '#e5484d', dash: 'dash', width: 1 } }, { type: 'line', x0: be, x1: be, yref: 'paper', y0: 0, y1: 1, line: { color: '#3fae78', dash: 'dot', width: 1 } }],
    annotations: [{ x: p.S, yref: 'paper', y: 1, text: 'spot', showarrow: false, font: { color: '#e5484d' } }, { x: be, yref: 'paper', y: 0.94, text: `breakeven ${be.toFixed(2)}`, showarrow: false, font: { color: '#3fae78' }, xanchor: 'left' }] }));
  const maxLoss = s === 1 ? `${fmt(paid, 2)} (the premium)` : (p.kind === 'call' ? 'unbounded' : `${fmt(p.K - paid, 2)}`);
  const maxGain = s === 1 ? (p.kind === 'call' ? 'unbounded' : `${fmt(p.K - paid, 2)}`) : `${fmt(paid, 2)} (the premium)`;
  $('payoffNote').textContent = `Max loss: ${maxLoss} · Max gain: ${maxGain}. Curves use Black-Scholes value for "today"; premium ${Number.isFinite(mkt) ? 'is your market price' : 'is the model price'}.`;
}

function renderTree() {
  const c = cache; if (!c) return; const { p } = c;
  const rows = P.convergence(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind);
  const n = rows.map((r) => r.steps);
  draw('convPlot', [
    { x: n, y: rows.map((r) => r.european), name: 'European tree', mode: 'lines+markers', line: { color: '#4aa3df' } },
    { x: n, y: rows.map((r) => r.american), name: 'American tree', mode: 'lines+markers', line: { color: '#f5a623' } },
    { x: n, y: rows.map(() => rows[0].bsm), name: 'BSM closed form', mode: 'lines', line: { color: '#3fae78', dash: 'dash' } },
    { x: n, y: rows.map((r) => Math.abs(r.error) + 1e-12), name: '|Euro tree − BSM| (right axis)', mode: 'lines+markers', yaxis: 'y2', line: { color: '#a9cf3f', dash: 'dot' } },
  ], baseLayout({ xaxis: { type: 'log', title: 'Tree steps', gridcolor: '#252c36' }, yaxis: { title: 'Premium', gridcolor: '#252c36' }, yaxis2: { overlaying: 'y', side: 'right', type: 'log', title: 'Abs. error', showgrid: false }, margin: { l: 56, r: 60, t: 20, b: 60 } }));

  const b = c.am;
  let t = [], sPts = [];
  b.boundaryT.forEach((x, i) => { if (Number.isFinite(b.boundaryS[i])) { t.push(x * 365); sPts.push(b.boundaryS[i]); } });
  // the lattice has discrete spot levels, so the raw boundary is a staircase: smooth it (moving average, ~4% of the axis)
  const w = Math.max(3, Math.floor(sPts.length / 25)), half = Math.floor(w / 2);
  sPts = sPts.map((_, i) => { const a = Math.max(0, i - half), z = Math.min(sPts.length - 1, i + half); let s = 0; for (let j = a; j <= z; j++) s += sPts[j]; return s / (z - a + 1); });
  if (t.length) {
    const inside = p.kind === 'put' ? 'below' : 'above';
    draw('boundaryPlot', [
      { x: t, y: sPts, mode: 'lines', name: 'Critical spot', line: { color: '#f5a623', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(229,72,77,.0)' },
      { x: [0, p.T * 365], y: [p.K, p.K], mode: 'lines', name: 'Strike', line: { color: '#5a6572', dash: 'dash' } },
      { x: [0], y: [p.S], mode: 'markers', name: 'Spot today', marker: { color: '#e5484d', size: 9 } },
    ], baseLayout({ xaxis: { title: 'Days from today', gridcolor: '#252c36' }, yaxis: { title: 'Critical spot', gridcolor: '#252c36' } }));
    $('boundaryNote').textContent = `Exercise immediately whenever the spot is ${inside} the curve; everywhere else, wait. The boundary approaches the strike at expiry.`;
  } else {
    draw('boundaryPlot', [], baseLayout({ annotations: [{ text: 'Early exercise is never optimal here', xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, font: { size: 16, color: '#8b95a3' } }], xaxis: { visible: false }, yaxis: { visible: false } }));
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

// ---------------------------------------------------------------- vol surface tab
async function loadSurface() {
  const t = ($('surfTicker').value || 'NDX').trim();
  $('loadSurface').disabled = true; $('surfStatus').className = 'hint'; $('surfStatus').textContent = 'Building surface…';
  try {
    const s = await D.getSurface(t);
    drawSurface(s);
    $('surfStatus').textContent = `${s.label} · spot ${s.spot.toLocaleString()} · ${s.asof} · ${s.source === 'live' ? 'live data' : 'bundled snapshot'}`;
  } catch (e) { $('surfStatus').className = 'hint bad'; $('surfStatus').textContent = e.message; }
  $('loadSurface').disabled = false;
}
function drawSurface(s) {
  const z = s.iv.map((row) => row.map((v) => v * 100));
  const j0 = s.k.reduce((bi, k, i) => (Math.abs(k) < Math.abs(s.k[bi]) ? i : bi), 0);
  const zmin = Math.floor(Math.min(...z.flat()) / 5) * 5, zmax = Math.ceil(Math.max(...z.flat()) / 5) * 5;
  draw('surfacePlot', [
    { type: 'surface', x: s.k, y: s.T, z, colorscale: IV_SCALE, cmin: zmin, cmax: zmax, colorbar: { title: { text: 'IV %' }, len: 0.6, thickness: 14 }, contours: { z: { show: false } }, hovertemplate: 'k=%{x:.3f}<br>T=%{y:.3f}y<br>IV=%{z:.1f}%<extra></extra>' },
    { type: 'scatter3d', mode: 'lines', x: s.T.map(() => 0), y: s.T, z: s.T.map((_, i) => z[i][j0] + 0.15), line: { color: '#e5484d', width: 5, dash: 'dash' }, name: 'ATM', hoverinfo: 'skip', showlegend: false },
  ], baseLayout({ margin: { l: 0, r: 0, t: 40, b: 0 }, title: { text: `${s.label} implied volatility surface — spot ${s.spot.toLocaleString()} · ${s.asof}`, font: { size: 14 } },
    scene: { ...sceneStyle('Log-moneyness ln(K/S)', 'Time to expiry (years)', 'Implied vol (%)'), zaxis: { ...sceneStyle('', '', 'Implied vol (%)').zaxis, range: [zmin, zmax] } } }));
  const idx = [0, Math.floor(s.T.length / 2), s.T.length - 1];
  draw('smilePlot', idx.map((i, n) => ({ x: s.k, y: z[i], mode: 'lines', name: `T = ${(s.T[i] * 365).toFixed(0)}d`, line: { color: COLORS[n], width: 2 } })),
    baseLayout({ title: { text: 'Volatility smile / skew by maturity', font: { size: 13 } }, xaxis: { title: 'Log-moneyness ln(K/S)', gridcolor: '#252c36' }, yaxis: { title: 'Implied vol (%)', gridcolor: '#252c36' }, shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#e5484d', dash: 'dash', width: 1 } }], margin: { l: 56, r: 16, t: 34, b: 60 } }));
}

// ---------------------------------------------------------------- ticker + chain
async function loadTicker() {
  const t = $('ticker').value.trim();
  if (!t) return;
  const st = $('tickerStatus'); st.className = 'hint'; st.textContent = 'Loading…'; $('loadTicker').disabled = true;
  try {
    const q = await D.getQuote(t);
    state.ticker = t; state.chain = null;
    $('S').value = +q.spot.toFixed(4);
    $('r').value = +(q.rate * 100).toFixed(3);
    $('q').value = +(q.div_yield * 100).toFixed(3);
    const v1 = q.hist_vol_1y ?? q.hist_vol;
    $('sigma').value = +(v1 * 100).toFixed(2);
    if (!Number.isFinite(parseFloat($('K').value)) || document.activeElement !== $('K')) $('K').value = Math.round(q.spot);
    st.className = 'hint good';
    st.textContent = `${q.name || q.ticker} · spot ${q.spot.toLocaleString()} · r ${(q.rate * 100).toFixed(2)}% · q ${(q.div_yield * 100).toFixed(2)}% · as of ${q.asof} (${q.source === 'live' ? 'live' : 'snapshot'})`;
    const chips = $('volChips'); chips.hidden = false; chips.innerHTML = '';
    [['30d hist vol', q.hist_vol], ['1y hist vol', q.hist_vol_1y]].forEach(([l, v]) => { if (!Number.isFinite(v)) return; const b = document.createElement('button'); b.className = 'chip'; b.textContent = `σ = ${l} ${(v * 100).toFixed(1)}%`; b.onclick = () => { $('sigma').value = +(v * 100).toFixed(2); update(); }; chips.appendChild(b); });
    const sel = $('expirySel'); $('chainPick').hidden = !(q.expiries && q.expiries.length);
    sel.innerHTML = '<option value="">Choose expiry…</option>' + (q.expiries || []).map((e) => `<option value="${e}">${e} (${Math.max(0, Math.round((new Date(e) - Date.now()) / 864e5))}d)</option>`).join('');
    $('strikeSel').innerHTML = '';
    $('surfTicker').value = t.toUpperCase().replace('^', '');
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
  } catch (err) { $('tickerStatus').className = 'hint bad'; $('tickerStatus').textContent = err.message; }
}
function fillStrikes() {
  if (!state.chain) return;
  const S = parseFloat($('S').value);
  const rows = state.chain.rows.filter((r) => r.type === state.type && r.strike > S * 0.6 && r.strike < S * 1.4).sort((a, b) => a.strike - b.strike);
  $('strikeSel').innerHTML = '<option value="">Choose contract…</option>' + rows.map((r) => `<option value="${r.strike}">${r.strike}  ·  ${r.bid}/${r.ask}  ·  IV ${(r.impliedVolatility * 100).toFixed(1)}%</option>`).join('');
}
function pickStrike() {
  const k = parseFloat($('strikeSel').value); if (!state.chain || !k) return;
  const r = state.chain.rows.find((x) => x.type === state.type && x.strike === k); if (!r) return;
  $('K').value = k;
  const mid = r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : r.lastPrice;
  $('premium').value = +mid.toFixed(4);
  update();
}

// ---------------------------------------------------------------- implied vol from a premium
let ivTimer;
function updateIV() {
  clearTimeout(ivTimer);
  ivTimer = setTimeout(() => {
    const box = $('ivReadout'), prem = parseFloat($('premium').value), p = readInputs();
    if (!Number.isFinite(prem) || validate(p)) { box.hidden = true; return; }
    const iv = p.style === 'american' ? P.americanImpliedVol(prem, p.S, p.K, p.T, p.r, p.q, p.kind, 200) : P.impliedVol(prem, p.S, p.K, p.T, p.r, p.q, p.kind);
    box.hidden = false;
    if (!Number.isFinite(iv)) { box.innerHTML = 'No volatility reproduces this premium (it violates no-arbitrage bounds).'; return; }
    box.innerHTML = `Implied vol (${p.style}): <b>${(iv * 100).toFixed(2)}%</b> <button class="chip" id="useIv">use as σ</button><br><span class="hint">vs. your σ ${(p.sigma * 100).toFixed(1)}% → ${iv > p.sigma ? 'market is pricing more vol than your input' : 'market is pricing less vol than your input'}</span>`;
    $('useIv').onclick = () => { $('sigma').value = +(iv * 100).toFixed(3); update(); };
  }, 250);
}

// ---------------------------------------------------------------- wiring
let renderTimer;
function update() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    state.lsmc = null; $('lsmcStatus').textContent = '';
    compute(); renderHero(); renderCurrentTab(); updateIV();
  }, 120);
}
function renderCurrentTab() {
  if (!cache) return;
  ({ overview: renderOverview, greeks: renderGreeks, payoff: renderPayoff, tree: renderTree, checks: renderChecks, surface: () => {}, how: () => {} }[state.tab])();
}
function setTab(t) {
  state.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + t));
  renderCurrentTab();
  if (t === 'surface' && !$('surfacePlot').data) loadSurface();
  window.dispatchEvent(new Event('resize'));
}

function init() {
  $('howText').innerHTML = HOW;
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    state[b.dataset.k] = b.dataset.v;
    if (b.dataset.k === 'type') fillStrikes();
    update();
  }));
  ['S', 'K', 'days', 'sigma', 'r', 'q'].forEach((id) => $(id).addEventListener('input', update));
  $('premium').addEventListener('input', () => { update(); });
  $('steps').addEventListener('input', () => { $('stepsOut').textContent = $('steps').value; update(); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('loadTicker').addEventListener('click', loadTicker);
  $('ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTicker(); });
  $('expirySel').addEventListener('change', loadExpiry);
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
      state.lsmc = P.lsmcPrice(p.S, p.K, p.T, p.r, p.sigma, p.q, p.kind, parseInt($('lsmcPaths').value, 10), Math.max(20, Math.min(100, Math.round(p.T * 100))));
      $('lsmcStatus').textContent = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      $('runLsmc').disabled = false; renderOverview();
    }, 30);
  });
  const hashTab = location.hash.replace('#', '');
  refreshPill();
  update();
  if (['overview', 'greeks', 'payoff', 'tree', 'surface', 'checks', 'how'].includes(hashTab)) setTab(hashTab);
}

async function refreshPill() {
  const pill = $('dataPill');
  const base = await D.detectApi();
  if (base !== null) { pill.textContent = 'data: live Yahoo Finance'; pill.className = 'pill live'; }
  else { pill.textContent = 'data: bundled snapshots'; pill.className = 'pill snap'; }
  const snaps = await D.snapshotTickers();
  $('ticker').placeholder = base !== null ? 'Any ticker — AAPL, SPY, NDX…' : `Ticker — ${snaps.filter((s) => s !== 'DEMO').slice(0, 5).join(', ')}…`;
}

init();
window.__pricer = { P, D, state, compute: () => compute() }; // handy for debugging in the console
