// Market data layer. Yahoo Finance sends no CORS headers, so a page hosted on GitHub Pages cannot call it directly.
// Sources are tried in this order:
//   1. A pricer API: same origin (`python -m pricer serve` or a deployed /api), http://localhost:8000, or a URL
//      the user pastes into the "Data API" box  ->  full live data (spot, rate, dividends, vol, option chains, surface)
//   2. Bundled snapshots in ./data/snapshots.json (real Yahoo data captured when the site was built)
//   3. Manual entry

const LS_KEY = 'pricer.apiBase';
let snapshots = null;

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
  return [...new Set(list)];
}

let liveBase; // undefined = not probed, null = none available
export async function detectApi() {
  if (liveBase !== undefined) return liveBase;
  for (const b of candidateBases()) {
    try { await getJson(`${b}/api/ping`, 2500); liveBase = b; return b; } catch { /* try next */ }
  }
  liveBase = null; return null;
}
export const resetApiProbe = () => { liveBase = undefined; };

export async function loadSnapshots() {
  if (snapshots) return snapshots;
  try { snapshots = await getJson('./data/snapshots.json?v=3'); } catch { snapshots = {}; }
  return snapshots;
}

const norm = (t) => t.trim().toUpperCase().replace(/^\^/, '');

export async function getQuote(ticker) {
  const sym = norm(ticker);
  const base = await detectApi();
  if (base !== null) {
    const q = await getJson(`${base}/api/quote?ticker=${encodeURIComponent(sym)}`);
    return { ...q, source: 'live' };
  }
  const snaps = await loadSnapshots();
  const s = snaps[sym];
  if (s) return { ...s.quote, expiries: [], source: 'snapshot' };
  const known = Object.keys(snaps).join(', ');
  throw new Error(`No live data API reachable and "${sym}" is not in the bundled snapshots (${known || 'none'}). Run "python -m pricer serve" locally for any ticker.`);
}

export async function getChain(ticker, expiry) {
  const base = await detectApi();
  if (base === null) throw new Error('Option chains need the live data API (python -m pricer serve).');
  return getJson(`${base}/api/chain?ticker=${encodeURIComponent(norm(ticker))}&expiry=${encodeURIComponent(expiry)}`);
}

export async function getSurface(ticker) {
  const sym = norm(ticker || 'demo');
  const base = await detectApi();
  if (base !== null) {
    const s = await getJson(`${base}/api/surface?ticker=${encodeURIComponent(sym)}`, 90000);
    return { ...s, source: 'live' };
  }
  const snaps = await loadSnapshots();
  const s = snaps[sym] || (sym === 'DEMO' ? snaps.DEMO : null);
  if (s && s.surface) return { ...s.surface, source: 'snapshot' };
  throw new Error(`No surface snapshot for "${sym}". Available: ${Object.keys(snaps).join(', ')}. Run "python -m pricer serve" for any ticker.`);
}

export const snapshotTickers = async () => Object.keys(await loadSnapshots());
