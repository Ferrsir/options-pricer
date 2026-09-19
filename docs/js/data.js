// Market data layer. Yahoo Finance sends no CORS headers, so a page hosted on GitHub Pages cannot call it directly.
// Sources are tried in this order:
//   1. A pricer API: same origin (`python -m pricer serve` or a deployed /api), http://localhost:8000, or a URL
//      the user pastes into the "Data API" box  ->  full live data (spot, rate, dividends, vol, option chains, surface)
//   2. Bundled snapshots in ./data/snapshots.json (real Yahoo data captured when the site was built)
//   3. Manual entry

import { buildSurface } from './surface.js?v=8';

const LS_KEY = 'pricer.apiBase';
// Public any-ticker API (serverless/, deployed once). Empty until deployed; the page then falls back to the bundled snapshots.
export const DEFAULT_API = 'https://options-pricer-api-five.vercel.app'; // serverless/ deployed on Vercel (Cboe delayed chains, any optionable ticker)
let snapshots = null;
let caps = {};

export const getApiBase = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } };
export const setApiBase = (v) => { try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch { /* private mode */ } };

async function getJson(url, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

function candidateBases() {
  const list = [];
  const custom = getApiBase().replace(/\/$/, '');
  if (custom) list.push(custom);
  if (location.protocol.startsWith('http') && !location.hostname.endsWith('github.io')) list.push(''); // same origin
  list.push('http://localhost:8000');
  if (DEFAULT_API) list.push(DEFAULT_API);
  return [...new Set(list)];
}

let liveBase; // undefined = not probed, null = none available
export async function detectApi() {
  if (liveBase !== undefined) return liveBase;
  for (const b of candidateBases()) {
    try { caps = await getJson(`${b}/api/ping`, 2500); liveBase = b; return b; } catch { /* try next */ }
  }
  liveBase = null; return null;
}
export const resetApiProbe = () => { liveBase = undefined; caps = {}; };
export const apiCaps = () => caps;

export async function loadSnapshots() {
  if (snapshots) return snapshots;
  try { snapshots = await getJson('./data/snapshots.json?v=8'); } catch { snapshots = {}; }
  return snapshots;
}

const norm = (t) => t.trim().toUpperCase().replace(/^\^/, '');

export async function getQuote(ticker) {
  const sym = norm(ticker);
  const base = await detectApi();
  const snap = async () => { const s = (await loadSnapshots())[sym]; return s ? { ...s.quote, expiries: [], source: 'snapshot' } : null; };
  if (base !== null) {
    try { const j = await getJson(`${base}/api/quote?ticker=${encodeURIComponent(sym)}`, 30000); return { ...j, source: j.source === 'cboe' ? 'cboe' : 'live' }; }
    catch (e) { const s = await snap(); if (s) return s; throw e; }   // the API's own message ("no listed options…") is the useful one
  }
  const s = await snap();
  if (s) return s;
  const known = Object.keys(await loadSnapshots()).filter((k) => k !== 'DEMO').join(', ');
  throw new Error(`No live data service is reachable right now, and "${sym}" is not in the bundled snapshots (${known}). Run "python -m pricer serve" locally for any ticker.`);
}

export async function getChain(ticker, expiry) {
  const base = await detectApi();
  if (base === null) throw new Error('Option chains need the live data API (python -m pricer serve).');
  return getJson(`${base}/api/chain?ticker=${encodeURIComponent(norm(ticker))}&expiry=${encodeURIComponent(expiry)}`);
}

export async function getSurface(ticker) {
  const sym = norm(ticker || 'demo');
  const base = await detectApi();
  const snap = async () => { const sn = await loadSnapshots(); const s = sn[sym] || (sym === 'DEMO' ? sn.DEMO : null); return s && s.surface ? { ...s.surface, source: 'snapshot' } : null; };
  if (base !== null) {
    try {
      if (caps.surface) return { ...(await getJson(`${base}/api/surface?ticker=${encodeURIComponent(sym)}`, 90000)), source: 'live' };
      // serverless API: it returns compact chains and the browser builds the surface (src/pricer/surface.py ported to js/surface.js)
      const payload = await getJson(`${base}/api/chains?ticker=${encodeURIComponent(sym)}`, 60000);
      return { ...buildSurface(payload), source: 'cboe' };
    } catch (e) { const s = await snap(); if (s) return s; throw e; }
  }
  const s = await snap();
  if (s) return s;
  throw new Error(`No live data service is reachable, and there is no bundled surface for "${sym}". Available: ${Object.keys(await loadSnapshots()).join(', ')}. Run "python -m pricer serve" for any ticker.`);
}

export const snapshotTickers = async () => Object.keys(await loadSnapshots());
