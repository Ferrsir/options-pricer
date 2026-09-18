"""Tiny local web server: serves the site in ./docs and a JSON API backed by yfinance.

    python -m pricer serve          ->  http://localhost:8000

Why this exists: Yahoo Finance does not send CORS headers (and needs a cookie "crumb" for option chains),
so a purely static page on GitHub Pages cannot reliably download option chains. Running this locally gives the
same web UI full live data. Endpoints:

    /api/quote?ticker=AAPL              spot, rate, dividend yield, historical vols, expiries
    /api/chain?ticker=AAPL&expiry=...   calls + puts for one expiry
    /api/surface?ticker=NDX             conditioned implied-vol surface grid (or ticker=demo)
"""
from __future__ import annotations

import json
import math
import mimetypes
import urllib.parse
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / "docs"


def _clean(o):
    """JSON-safe: NaN/inf -> None."""
    if isinstance(o, float):
        return None if not math.isfinite(o) else o
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def api_quote(ticker):
    from .data import expiries, get_quote

    q = asdict(get_quote(ticker))
    try:
        q["expiries"] = expiries(ticker)
    except Exception:
        q["expiries"] = []
    return q


def api_chain(ticker, expiry):
    from .data import get_chain, year_fraction

    df = get_chain(ticker, expiry).fillna(0)
    return dict(expiry=expiry, T=year_fraction(expiry), rows=df.to_dict(orient="records"))


def api_surface(ticker):
    from .surface import build_surface, synthetic_chain

    if ticker.lower() == "demo":
        chain, spot, rate, asof, label = synthetic_chain(), 25000.0, 0.04, "demo data", "Synthetic demo"
    else:
        from .data import get_full_chain, get_quote

        qt = get_quote(ticker)
        chain, spot, rate, asof = get_full_chain(ticker), qt.spot, qt.rate, qt.asof
        label = f"{qt.name or qt.ticker}"
    s = build_surface(chain, spot, rate, asof, label)
    out = s.to_json()
    out["implied_q"] = {f"{k:.4f}": v for k, v in s.implied_q.items()}
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        url = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path.startswith("/api/"):
            try:
                if url.path == "/api/quote":
                    data = api_quote(qs["ticker"])
                elif url.path == "/api/chain":
                    data = api_chain(qs["ticker"], qs["expiry"])
                elif url.path == "/api/surface":
                    data = api_surface(qs.get("ticker", "demo"))
                elif url.path == "/api/ping":
                    data = {"ok": True}
                else:
                    return self._send(404, b'{"error":"unknown endpoint"}')
                return self._send(200, json.dumps(_clean(data)).encode())
            except Exception as e:  # surface the reason to the UI instead of a bare 500
                return self._send(400, json.dumps({"error": f"{type(e).__name__}: {e}"}).encode())
        rel = url.path.lstrip("/") or "index.html"
        f = (DOCS / rel).resolve()
        if DOCS.resolve() not in f.parents and f != DOCS.resolve() or not f.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        return self._send(200, f.read_bytes(), ctype)

    def log_message(self, fmt, *args):  # quieter console
        pass


def serve(port=8000):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Options pricer running at http://localhost:{port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
