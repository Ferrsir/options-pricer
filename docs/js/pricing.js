// Pricing engine (pure JS, no dependencies). Mirrors src/pricer/*.py so both give the same numbers.
// S spot, K strike, T years, r rate, sigma vol, q dividend yield, kind 'call' | 'put'.

const SQRT2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
export const pdf = (x) => Math.exp(-0.5 * x * x) / SQRT_2PI;

// Standard normal CDF. erf(z) = 2/sqrt(pi) * exp(-z^2) * sum_{n>=0} 2^n z^(2n+1) / (1*3*5*...*(2n+1))
// (all-positive series: no cancellation, accurate to ~1e-15 for |z| < 6.5).
function erf(z) {
  const a = Math.abs(z);
  if (a > 6.5) return Math.sign(z);
  let term = a, sum = a;
  for (let n = 1; n < 400; n++) {
    term *= (2 * a * a) / (2 * n + 1);
    sum += term;
    if (term < 1e-17 * sum) break;
  }
  return Math.sign(z) * (2 / Math.sqrt(Math.PI)) * Math.exp(-a * a) * sum;
}
export const N = (x) => 0.5 * (1 + erf(x / SQRT2));

const phi = (kind) => (kind === 'call' ? 1 : -1);

export function d1d2(S, K, T, r, sigma, q = 0) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return [d1, d1 - v];
}

export const intrinsic = (S, K, kind) => Math.max(phi(kind) * (S - K), 0);

export function bsmPrice(S, K, T, r, sigma, q = 0, kind = 'call') {
  const p = phi(kind);
  if (T <= 0 || sigma <= 0) return Math.max(p * (S * Math.exp(-q * Math.max(T, 0)) - K * Math.exp(-r * Math.max(T, 0))), 0);
  const [d1, d2] = d1d2(S, K, T, r, sigma, q);
  return p * (S * Math.exp(-q * T) * N(p * d1) - K * Math.exp(-r * T) * N(p * d2));
}

export function bsmGreeks(S, K, T, r, sigma, q = 0, kind = 'call') {
  const p = phi(kind);
  const [d1, d2] = d1d2(S, K, T, r, sigma, q);
  const sq = Math.sqrt(T), dq = Math.exp(-q * T), dr = Math.exp(-r * T), n1 = pdf(d1);
  const vega = S * dq * n1 * sq;
  return {
    delta: p * dq * N(p * d1),
    gamma: (dq * n1) / (S * sigma * sq),
    vega,
    theta: (-S * dq * n1 * sigma) / (2 * sq) - p * r * K * dr * N(p * d2) + p * q * S * dq * N(p * d1),
    rho: p * K * T * dr * N(p * d2),
    vanna: (-dq * n1 * d2) / sigma,
    volga: (vega * d1 * d2) / sigma,
  };
}

export function noArbBounds(S, K, T, r, q, kind) {
  const p = phi(kind), fwd = S * Math.exp(-q * T) - K * Math.exp(-r * T);
  return [Math.max(p * fwd, 0), p === 1 ? S * Math.exp(-q * T) : K * Math.exp(-r * T)];
}

// Implied vol: bisection on [1e-4, 5]  (BSM price is strictly increasing in sigma, so it always converges)
export function impliedVol(price, S, K, T, r, q = 0, kind = 'call') {
  const [lo0, hi0] = noArbBounds(S, K, T, r, q, kind);
  if (!(price > lo0 + 1e-10 && price < hi0 - 1e-10) || T <= 0) return NaN;
  let a = 1e-4, b = 5;
  if (bsmPrice(S, K, T, r, a, q, kind) > price || bsmPrice(S, K, T, r, b, q, kind) < price) return NaN;
  for (let i = 0; i < 100; i++) {
    const m = 0.5 * (a + b);
    if (bsmPrice(S, K, T, r, m, q, kind) > price) b = m; else a = m;
    if (b - a < 1e-12) break;
  }
  return 0.5 * (a + b);
}

// ---------------------------------------------------------------- Cox-Ross-Rubinstein binomial tree
export function crrParams(T, r, sigma, q, steps) {
  const dt = T / steps, u = Math.exp(sigma * Math.sqrt(dt)), d = 1 / u, growth = Math.exp((r - q) * dt);
  if (!(d < growth && growth < u)) throw new Error('No-arbitrage condition d < e^{(r-q)dt} < u violated: increase steps or check inputs');
  return { dt, u, d, p: (growth - d) / (u - d) };
}

export function binomialTree(S, K, T, r, sigma, q = 0, kind = 'call', steps = 500, american = true, wantBoundary = false) {
  const ph = phi(kind);
  const { dt, u, p } = crrParams(T, r, sigma, q, steps);
  const disc = Math.exp(-r * dt), pu = p * disc, pd = (1 - p) * disc;
  let v = new Float64Array(steps + 1);
  const lu = Math.log(u);
  for (let j = 0; j <= steps; j++) v[j] = Math.max(ph * (S * Math.exp((2 * j - steps) * lu) - K), 0);
  const early = {}, bT = [], bS = [];
  for (let i = steps - 1; i >= 0; i--) {
    let hi = -1, lo = -1;
    for (let j = 0; j <= i; j++) {
      const cont = pu * v[j + 1] + pd * v[j];
      let val = cont;
      if (american) {
        const ex = Math.max(ph * (S * Math.exp((2 * j - i) * lu) - K), 0);
        if (ex > cont + 1e-12) { if (lo < 0) lo = j; hi = j; }
        if (ex > cont) val = ex;
      }
      v[j] = val;
    }
    if (american && wantBoundary) {
      bT.push(i * dt);
      const sp = (j) => S * Math.exp((2 * j - i) * lu);
      if (hi < 0) bS.push(NaN);
      else if (ph === -1) bS.push(Math.min(0.5 * (sp(hi) + sp(Math.min(hi + 1, i))), K));
      else bS.push(Math.max(0.5 * (sp(lo) + sp(Math.max(lo - 1, 0))), K));
    }
    if (i <= 2) early[i] = Array.from(v.slice(0, i + 1));
  }
  const price = v[0];
  let delta = NaN, gamma = NaN, theta = NaN;
  if (steps >= 3) {
    const Su = S * u, Sd = S / u, Suu = S * u * u, Sdd = S / (u * u);
    delta = (early[1][1] - early[1][0]) / (Su - Sd);
    const dUp = (early[2][2] - early[2][1]) / (Suu - S), dDn = (early[2][1] - early[2][0]) / (S - Sdd);
    gamma = (dUp - dDn) / (0.5 * (Suu - Sdd));
    theta = (early[2][1] - price) / (2 * dt);
  }
  return { price, delta, gamma, theta, steps, boundaryT: bT.reverse(), boundaryS: bS.reverse() };
}

export const europeanTree = (S, K, T, r, s, q, kind, n) => binomialTree(S, K, T, r, s, q, kind, n, false).price;
export const americanPrice = (S, K, T, r, s, q, kind, n) => binomialTree(S, K, T, r, s, q, kind, n, true).price;

export function americanGreeks(S, K, T, r, sigma, q, kind, steps) {
  const t = binomialTree(S, K, T, r, sigma, q, kind, steps, true);
  const dv = 0.005, dr = 0.0005;
  const vega = (americanPrice(S, K, T, r, sigma + dv, q, kind, steps) - americanPrice(S, K, T, r, sigma - dv, q, kind, steps)) / (2 * dv);
  const rho = (americanPrice(S, K, T, r + dr, sigma, q, kind, steps) - americanPrice(S, K, T, r - dr, sigma, q, kind, steps)) / (2 * dr);
  return { price: t.price, delta: t.delta, gamma: t.gamma, theta: t.theta, vega, rho };
}

export function americanImpliedVol(price, S, K, T, r, q, kind, steps = 200) {
  let a = 1e-3, b = 5;
  if (americanPrice(S, K, T, r, a, q, kind, steps) > price || americanPrice(S, K, T, r, b, q, kind, steps) < price) return NaN;
  for (let i = 0; i < 60; i++) {
    const m = 0.5 * (a + b);
    if (americanPrice(S, K, T, r, m, q, kind, steps) > price) b = m; else a = m;
    if (b - a < 1e-7) break;
  }
  return 0.5 * (a + b);
}

export function convergence(S, K, T, r, sigma, q, kind, list = [5, 10, 25, 50, 100, 250, 500, 1000]) {
  const exact = bsmPrice(S, K, T, r, sigma, q, kind);
  return list.map((n) => {
    const eu = europeanTree(S, K, T, r, sigma, q, kind, n);
    return { steps: n, european: eu, american: americanPrice(S, K, T, r, sigma, q, kind, n), bsm: exact, error: eu - exact };
  });
}

// ---------------------------------------------------------------- Longstaff-Schwartz Monte Carlo
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gaussian(rng) { // Box-Muller
  let u = 0; while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
function solveLinear(A, b) { // Gaussian elimination with partial pivoting (tiny systems)
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) M[c][c] = 1e-14;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}
const laguerre = (x) => { const w = Math.exp(-x / 2); return [w, w * (1 - x), w * (1 - 2 * x + 0.5 * x * x), w * (1 - 3 * x + 1.5 * x * x - (x * x * x) / 6)]; };

export function lsmcPrice(S, K, T, r, sigma, q = 0, kind = 'put', paths = 20000, steps = 50, seed = 42) {
  const ph = phi(kind), dt = T / steps, half = Math.floor(paths / 2), n = half * 2, rng = mulberry32(seed);
  const drift = (r - q - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt);
  const spots = Array.from({ length: steps }, () => new Float64Array(n));
  for (let i = 0; i < half; i++) { // antithetic pairs
    let la = 0, lb = 0;
    for (let t = 0; t < steps; t++) { const z = gaussian(rng); la += drift + vol * z; lb += drift - vol * z; spots[t][i] = S * Math.exp(la); spots[t][i + half] = S * Math.exp(lb); }
  }
  const disc = Math.exp(-r * dt);
  const cash = new Float64Array(n);
  for (let i = 0; i < n; i++) cash[i] = Math.max(ph * (spots[steps - 1][i] - K), 0);
  for (let t = steps - 2; t >= 0; t--) {
    for (let i = 0; i < n; i++) cash[i] *= disc;
    const idx = [];
    for (let i = 0; i < n; i++) if (ph * (spots[t][i] - K) > 0) idx.push(i);
    if (idx.length < 8) continue;
    const B = 4, A = Array.from({ length: B }, () => new Array(B).fill(0)), y = new Array(B).fill(0);
    const rows = idx.map((i) => laguerre(spots[t][i] / K));
    rows.forEach((row, m) => { for (let a = 0; a < B; a++) { y[a] += row[a] * cash[idx[m]]; for (let b = 0; b < B; b++) A[a][b] += row[a] * row[b]; } });
    for (let a = 0; a < B; a++) A[a][a] += 1e-10;
    const coef = solveLinear(A, y);
    rows.forEach((row, m) => {
      const cont = row[0] * coef[0] + row[1] * coef[1] + row[2] * coef[2] + row[3] * coef[3];
      const pay = ph * (spots[t][idx[m]] - K);
      if (pay > cont) cash[idx[m]] = pay;
    });
  }
  let mean = 0; for (let i = 0; i < n; i++) mean += cash[i] * disc; mean /= n;
  let vr = 0; for (let i = 0; i < n; i++) { const d = cash[i] * disc - mean; vr += d * d; }
  return { price: Math.max(mean, intrinsic(S, K, kind)), se: Math.sqrt(vr / (n - 1)) / Math.sqrt(n), paths: n, steps };
}

// ---------------------------------------------------------------- HW sanity checks
export function sanityChecks(p) {
  const { S, K, T, r, sigma, q } = p, out = [];
  const add = (name, passed, detail) => out.push({ name, passed, detail });
  const c = bsmPrice(100, 100, 1, 0.05, 0.2, 0, 'call');
  add('BSM reference value C(100,100,1y,5%,20%) = 10.4506', Math.abs(c - 10.4506) < 1e-3, `got ${c.toFixed(4)}`);
  const call = bsmPrice(S, K, T, r, sigma, q, 'call'), put = bsmPrice(S, K, T, r, sigma, q, 'put');
  const gap = call - put - (S * Math.exp(-q * T) - K * Math.exp(-r * T));
  add('Put-call parity: C - P = S e^(-qT) - K e^(-rT)', Math.abs(gap) < 1e-9, `gap = ${gap.toExponential(2)}`);
  const n = 1000, tree = europeanTree(S, K, T, r, sigma, q, 'call', n);
  add(`European tree (${n} steps) matches BSM`, Math.abs(tree - call) < 0.01 * Math.max(1, call / 10), `tree ${tree.toFixed(4)} vs BSM ${call.toFixed(4)}`);
  const amC = americanPrice(S, K, T, r, sigma, 0, 'call', 500), euC = europeanTree(S, K, T, r, sigma, 0, 'call', 500);
  add('American call with no dividends has zero early-exercise premium', Math.abs(amC - euC) < 1e-9, `premium = ${(amC - euC).toExponential(2)}`);
  const amP = americanPrice(S, K, T, r, sigma, q, 'put', 500), euP = europeanTree(S, K, T, r, sigma, q, 'put', 500);
  add('American put premium over European put is positive (r > 0)', r <= 0 || amP - euP > 1e-6, `premium = ${(amP - euP).toFixed(4)}`);
  const itm = americanPrice(100, 50, 0.25, r, sigma, 0, 'call', 300), carry = 50 * (1 - Math.exp(-r * 0.25));
  add('Deep ITM call ≈ intrinsic (time value is only interest on the strike)', itm >= 50 - 1e-9 && itm <= 50 + carry + 0.01, `price ${itm.toFixed(3)} vs intrinsic 50, max time value ${carry.toFixed(3)}`);
  const otm = bsmPrice(100, 200, 0.25, r, sigma, q, 'call');
  add('Deep OTM call ≈ 0', otm < 1e-6, `price ${otm.toExponential(2)}`);
  const lo = bsmPrice(S, K, T, r, sigma * 0.75, q, 'call'), hi = bsmPrice(S, K, T, r, sigma * 1.25, q, 'call');
  add('Higher vol → higher premium', hi > lo, `${lo.toFixed(3)} → ${hi.toFixed(3)}`);
  const p0a = americanPrice(S, K, T, 0, sigma, 0, 'put', 300), p0e = europeanTree(S, K, T, 0, sigma, 0, 'put', 300);
  add('r → 0 removes the American put’s early-exercise premium', Math.abs(p0a - p0e) < 1e-9, `premium = ${(p0a - p0e).toExponential(2)}`);
  return out;
}
