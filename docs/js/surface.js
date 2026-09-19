// Implied-volatility surface builder in pure JS. It mirrors src/pricer/surface.py step by step, so a static page can
// build the same picture from raw option chains (payload of the /api/chains endpoint) with no Python behind it.
//
//   1. quotes -> per-expiry dividend yield from put-call parity, out-of-the-money mids -> Black-Scholes implied vols (log-moneyness k = ln(K/S))
//   2. per expiry: reject outliers (rolling median + MAD), Savitzky-Golay smooth (window 7, order 2)
//   3. stage 1: PCHIP across strike, damped linear extrapolation beyond the quoted strikes
//   4. stage 2: PCHIP across time on TOTAL variance (kept non-decreasing in T), converted back to vol
import { impliedVol } from './pricing.js?v=8';

const EXTRAP_DAMPING = 0.5;
export const K_RANGE = [-0.15, 0.1];

const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// ---- tiny linear algebra: least-squares polynomial fit via normal equations (degree <= 3, a handful of points)
function polyfit(xs, ys, deg) {
  const m = deg + 1, A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  xs.forEach((x, i) => { for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += x ** (r + c); A[r][m] += ys[i] * x ** r; } });
  for (let c = 0; c < m; c++) {
    let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = c + 1; r < m; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
  }
  const co = new Array(m).fill(0);
  for (let i = m - 1; i >= 0; i--) { let s = A[i][m]; for (let k = i + 1; k < m; k++) s -= A[i][k] * co[k]; co[i] = s / A[i][i]; }
  return co; // co[j] multiplies x^j
}
const polyval = (co, x) => co.reduce((s, c, j) => s + c * x ** j, 0);

// ---- Savitzky-Golay (uniform spacing, like scipy.signal.savgol_filter(mode="interp"))
export function savgol(y, w = 7, order = 2) {
  const n = y.length;
  const win = Math.min(w, n % 2 ? n : n - 1);
  if (win <= order) return y.slice();
  const half = (win - 1) / 2, out = new Array(n);
  const idx = (a) => Array.from({ length: win }, (_, i) => a + i);
  const head = polyfit(idx(0), y.slice(0, win), order), tail = polyfit(idx(n - win), y.slice(n - win), order);
  for (let i = 0; i < n; i++) {
    if (i < half) out[i] = polyval(head, i);
    else if (i >= n - half) out[i] = polyval(tail, i); // the tail fit used absolute indices n-win..n-1, so evaluate at i
    else { const xs = idx(-half).map((v) => v), co = polyfit(xs, y.slice(i - half, i + half + 1), order); out[i] = co[0]; }
  }
  return out;
}

// ---- PCHIP (Fritsch-Carlson, same slope rules as scipy.interpolate.PchipInterpolator)
function pchipSlopes(x, y) {
  const n = x.length, h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(x[i + 1] - x[i]); d.push((y[i + 1] - y[i]) / h[i]); }
  if (n === 2) return [d[0], d[0]];
  const edge = (h0, h1, m0, m1) => {
    let v = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (Math.sign(v) !== Math.sign(m0)) v = 0;
    else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(v) > 3 * Math.abs(m0)) v = 3 * m0;
    return v;
  };
  const m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (Math.sign(d[i - 1]) !== Math.sign(d[i]) || d[i - 1] === 0 || d[i] === 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  m[0] = edge(h[0], h[1], d[0], d[1]);
  m[n - 1] = edge(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}
export function pchip(x, y) {
  const m = pchipSlopes(x, y), n = x.length;
  return (t) => {
    let lo = 0, hi = n - 2; // last interval whose left end <= t
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (x[mid] <= t) lo = mid; else hi = mid - 1; }
    const h = x[lo + 1] - x[lo], s = (t - x[lo]) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[lo] + (s3 - 2 * s2 + s) * h * m[lo] + (-2 * s3 + 3 * s2) * y[lo + 1] + (s3 - s2) * h * m[lo + 1];
  };
}

// ---- step 1: dividend yield per expiry from put-call parity, then clean OTM implied vols
const mid = (bid, ask) => (bid > 0 && ask >= bid ? 0.5 * (bid + ask) : null);

export function impliedCarry(rows, S, r, T, nStrikes = 6) {
  const calls = new Map(), puts = new Map();
  rows.forEach(([t, K, b, a]) => { const m = mid(b, a); if (m !== null) (t === 'c' ? calls : puts).set(K, m); });
  const common = [...calls.keys()].filter((K) => puts.has(K));
  if (common.length < 2) return null;
  const near = common.sort((a, b) => Math.abs(a - S) - Math.abs(b - S)).slice(0, nStrikes);
  const fwd = median(near.map((K) => K + Math.exp(r * T) * (calls.get(K) - puts.get(K))));
  if (!(fwd > 0)) return null;
  return r - Math.log(fwd / S) / T;
}

// q per expiry; expiries without a usable put/call pair borrow from their neighbours (linear in T), as in Python
export function carryPerExpiry(expiries, S, r) {
  const raw = expiries.map((e) => { const q = impliedCarry(e.rows, S, r, e.T); return q === null || !Number.isFinite(q) ? null : Math.min(Math.max(q, -0.02), 0.15); });
  const known = raw.map((q, i) => [expiries[i].T, q]).filter(([, q]) => q !== null).sort((a, b) => a[0] - b[0]);
  if (!known.length) return raw.map(() => 0);
  return raw.map((q, i) => {
    if (q !== null) return q;
    const T = expiries[i].T;
    if (T <= known[0][0]) return known[0][1];
    if (T >= known[known.length - 1][0]) return known[known.length - 1][1];
    let j = 0; while (known[j + 1][0] < T) j++;
    const [t0, q0] = known[j], [t1, q1] = known[j + 1];
    return q0 + ((q1 - q0) * (T - t0)) / (t1 - t0);
  });
}

export function conditionChain(payload, kRange = K_RANGE, maxRelSpread = 0.6) {
  const { spot: S, rate: r, expiries } = payload;
  const qs = carryPerExpiry(expiries, S, r), points = [];
  expiries.forEach((e, ei) => {
    const q = qs[ei], fwd = S * Math.exp((r - q) * e.T), bestByStrike = new Map();
    e.rows.forEach(([t, K, b, a]) => {
      const m = mid(b, a); if (m === null) return;
      const rel = (a - b) / m, k = Math.log(K / S);
      const otm = (t === 'p' && K < fwd) || (t === 'c' && K >= fwd);
      if (!otm || !(rel < maxRelSpread) || k < kRange[0] || k > kRange[1]) return;
      const prev = bestByStrike.get(K); // duplicate strikes (e.g. SPX and SPXW roots): keep the tightest quote
      if (!prev || rel < prev.rel) bestByStrike.set(K, { t, K, m, rel, k });
    });
    bestByStrike.forEach((p) => {
      const iv = impliedVol(p.m, S, p.K, e.T, r, q, p.t === 'c' ? 'call' : 'put');
      if (Number.isFinite(iv) && iv > 0.02 && iv < 3.0) points.push({ ei, T: e.T, k: p.k, iv, K: p.K });
    });
  });
  return { points, qs };
}

function rejectOutliers(k, iv, width = 5, nMad = 4) {
  if (iv.length < width + 2) return [k, iv];
  const half = (width - 1) / 2;
  const med = iv.map((_, i) => median(iv.slice(Math.max(0, i - half), i + half + 1)));
  const resid = iv.map((v, i) => v - med[i]);
  const mr = median(resid), mad = median(resid.map((v) => Math.abs(v - mr))) + 1e-9;
  const keep = resid.map((v) => Math.abs(v) < nMad * 1.4826 * mad);
  return [k.filter((_, i) => keep[i]), iv.filter((_, i) => keep[i])];
}

// ---- steps 2-4: the surface
export function buildSurface(payload, { kRange = K_RANGE, nk = 60, nT = 50, minPoints = 7 } = {}) {
  const { points, qs } = conditionChain(payload, kRange);
  const byExpiry = new Map();
  points.forEach((p) => { if (!byExpiry.has(p.ei)) byExpiry.set(p.ei, []); byExpiry.get(p.ei).push(p); });
  const smiles = [];
  [...byExpiry.entries()].sort((a, b) => a[0] - b[0]).forEach(([ei, g]) => {
    if (g.length < minPoints) return;
    g.sort((a, b) => a.k - b.k);
    let [k, iv] = rejectOutliers(g.map((p) => p.k), g.map((p) => p.iv));
    if (iv.length >= 3) iv = savgol(iv, 7, 2);
    if (k.length >= 4) smiles.push({ T: payload.expiries[ei].T, k, iv });
  });
  if (smiles.length < 2) throw new Error('Need at least two maturities with enough clean quotes to build a surface');
  smiles.sort((a, b) => a.T - b.T);

  const kGrid = linspace(kRange[0], kRange[1], nk), Ts = smiles.map((s) => s.T);
  const allIv = points.map((p) => p.iv), loCap = 0.7 * Math.min(...allIv), hiCap = 1.3 * Math.max(...allIv);
  const wByT = smiles.map((s) => {
    const f = pchip(s.k, s.iv), nEdge = Math.min(4, s.k.length);
    const slope = (xs, ys) => polyfit(xs, ys, 1)[1];
    const sLo = slope(s.k.slice(0, nEdge), s.iv.slice(0, nEdge)), sHi = slope(s.k.slice(-nEdge), s.iv.slice(-nEdge));
    const k0 = s.k[0], k1 = s.k[s.k.length - 1];
    return kGrid.map((x) => {
      let v = x < k0 ? s.iv[0] + EXTRAP_DAMPING * sLo * (x - k0) : x > k1 ? s.iv[s.iv.length - 1] + EXTRAP_DAMPING * sHi * (x - k1) : f(x);
      v = Math.min(Math.max(v, loCap), hiCap);
      return v * v * s.T; // total variance
    });
  });
  const TGrid = linspace(Ts[0], Ts[Ts.length - 1], nT);
  const iv = TGrid.map(() => new Array(nk));
  for (let j = 0; j < nk; j++) {
    let run = -Infinity; // total variance must not fall as maturity grows (no calendar arbitrage)
    const col = wByT.map((row) => (run = Math.max(run, row[j])));
    const g = pchip(Ts, col);
    TGrid.forEach((t, i) => { iv[i][j] = Math.sqrt(Math.max(g(t), 1e-10) / t); });
  }
  return { k: kGrid, T: TGrid, iv, spot: payload.spot, asof: payload.asof || '', label: payload.label || payload.ticker || '', source: payload.source || 'api', impliedQ: qs };
}
