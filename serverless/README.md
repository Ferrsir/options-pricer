# Any-ticker API (serverless)

A tiny, dependency-free Python API that gives the static website live data for **any optionable US ticker**.
The browser cannot call Yahoo Finance or Cboe directly (no CORS), so this proxies Cboe's public 15-minute-delayed chains
and returns small JSON. Source of truth: `src/pricer/cboe.py` (`lib/cboe.py` here is a copy; `python scripts/build_serverless.py` refreshes it
and a test fails if they drift).

| Endpoint | Returns |
|---|---|
| `GET /api/ping` | `{ok, quote, chain, chains, surface:false}` so the site knows what this server can do |
| `GET /api/quote?ticker=AAPL` | spot, rate, estimated dividend yield, 30-day implied vol (`iv30`), expiries |
| `GET /api/chain?ticker=AAPL&expiry=2026-10-16` | quoted calls and puts for one expiry (contract picker) |
| `GET /api/chains?ticker=TSLA` | compact multi-expiry bid/ask; the site builds the vol surface from it in the browser (`docs/js/surface.js`) |

Deploy on Vercel from the dashboard (no CLI needed): **Add New → Project → import `Ferrsir/options-pricer`**, set **Root Directory** to `serverless`, Framework Preset **Other**, leave build settings empty, Deploy.
Check `https://<your-project>.vercel.app/api/ping` returns `{"ok":true,...}`. If it asks you to log in, turn **Vercel Authentication** off under Settings → Deployment Protection (the data is public and delayed).
Any other host that runs Python functions with a `handler(BaseHTTPRequestHandler)` per file works too.
Then set `DEFAULT_API` in `docs/js/data.js` to the deployment URL (or paste it in the site's *Data API* box) and bump the cache-bust version.
Cboe data is delayed and unofficial: educational use only.
