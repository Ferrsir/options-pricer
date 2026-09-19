"""Any-ticker market data from Cboe's public delayed-quote JSON (standard library only).

Why this exists: Yahoo Finance cannot be called from a web page (no CORS) and needs cookies for option chains, so a static
site can only reach it through a server. This module is deliberately dependency-free (no numpy, pandas or requests) so the
*same file* runs in three places: the local server (`python -m pricer serve`) as a fallback when yfinance fails, in
`serverless/` as a tiny public API for the hosted site, and in tests.

Source: https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json  (15-minute delayed; every US listed option).
Fields we use: current_price, iv30 (30-day implied vol, in percent), and per option: an OCC symbol
(ROOT + YYMMDD + C|P + strike*1000 as 8 digits), bid, ask, last_trade_price, volume, open_interest, iv.
Not provided: dividend yield (we estimate it from put-call parity), risk-free rate (13-week T-bill via Yahoo, else 4%),
company name, or price history (so there is no historical volatility here; iv30 is the better default sigma anyway).
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import statistics
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{sym}.json"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?range=5d&interval=1d"
UA = {"User-Agent": "Mozilla/5.0 (options-pricer; educational)", "Accept": "application/json"}
DEFAULT_RATE = 0.04

OCC = re.compile(r"^(?P<root>[A-Z0-9.]{1,7}?)(?P<yy>\d{2})(?P<mm>\d{2})(?P<dd>\d{2})(?P<cp>[CP])(?P<k>\d{8})$")
TICKER_OK = re.compile(r"^_?[A-Z0-9.]{1,10}$")
# Cboe lists cash-settled indexes with a leading underscore
INDEXES = {"SPX", "NDX", "VIX", "RUT", "DJX", "XSP", "OEX", "MRUT", "XND", "RUTW"}
_ALIASES = {"NASDAQ100": "NDX", "SP500": "SPX", "GSPC": "SPX", "IXIC": "COMP"}


# ------------------------------------------------------------------ small helpers
def _f(x, default=0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def candidates(ticker: str) -> list[str]:
    """Symbols to try, in order. Users type SPX, ^SPX, BRK-B, brk.b ...; Cboe wants _SPX and BRK.B."""
    t = (ticker or "").strip().upper().lstrip("^").replace("-", ".").replace(" ", "")
    t = _ALIASES.get(t, t)
    if not t or not TICKER_OK.match(t):
        raise ValueError(f"'{ticker}' is not a valid ticker symbol")
    if t.startswith("_"):
        return [t, t[1:]]
    return ["_" + t, t] if t in INDEXES else [t, "_" + t]


def year_fraction(expiry: str, now: dt.datetime | None = None) -> float:
    """Years (ACT/365) from now to 4pm New York on the expiry date."""
    exp = dt.datetime.fromisoformat(expiry).replace(hour=16)
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("America/New_York")
        exp = exp.replace(tzinfo=tz)
        now = now or dt.datetime.now(tz)
    except Exception:  # no tz database (some Windows installs): approximate with UTC-4/-5
        off = dt.timezone(dt.timedelta(hours=-4 if 3 <= exp.month <= 10 else -5))
        exp = exp.replace(tzinfo=off)
        now = now or dt.datetime.now(off)
    return max((exp - now).total_seconds() / (365.0 * 86400.0), 0.0)


# ------------------------------------------------------------------ fetching + parsing
def fetch(ticker: str, timeout: float = 25.0):
    """Returns (cboe_symbol, parsed_json). Raises ValueError when Cboe has no chain for the ticker."""
    last = None
    for sym in candidates(ticker):
        try:
            req = urllib.request.Request(CBOE_URL.format(sym=sym), headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return sym, json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (403, 404):
                continue
            raise
    raise ValueError(f"No listed options found for '{ticker}'. Cboe publishes chains only for optionable US stocks, ETFs and indexes.") from last


def parse_options(raw: dict) -> list[dict]:
    """Cboe payload -> one dict per option: expiry (YYYY-MM-DD), type, strike, bid, ask, last, volume, openInterest, iv."""
    out = []
    for o in raw.get("data", {}).get("options", []):
        m = OCC.match(o.get("option", ""))
        if not m:
            continue
        out.append(
            dict(
                expiry=f"20{m['yy']}-{m['mm']}-{m['dd']}",
                type="call" if m["cp"] == "C" else "put",
                strike=int(m["k"]) / 1000.0,
                bid=_f(o.get("bid")),
                ask=_f(o.get("ask")),
                last=_f(o.get("last_trade_price")),
                volume=_f(o.get("volume")),
                openInterest=_f(o.get("open_interest")),
                iv=_f(o.get("iv")),
            )
        )
    return out


def spot_of(raw: dict) -> float:
    d = raw.get("data", {})
    s = _f(d.get("current_price")) or _f(d.get("close")) or _f(d.get("prev_day_close"))
    if s <= 0:
        raise ValueError("Cboe returned no price for this symbol")
    return s


def asof_of(raw: dict) -> str:
    return str(raw.get("data", {}).get("last_trade_time") or raw.get("timestamp") or "")[:10]


_rate_cache: tuple[float, float] | None = None  # (value, fetched_at)


def risk_free_rate() -> float:
    """13-week T-bill yield from Yahoo's chart endpoint (no cookie needed); falls back to 4%."""
    global _rate_cache
    if _rate_cache and time.time() - _rate_cache[1] < 3600:
        return _rate_cache[0]
    rate = DEFAULT_RATE
    try:
        req = urllib.request.Request(YAHOO_CHART, headers=UA)
        with urllib.request.urlopen(req, timeout=4) as r:
            j = json.loads(r.read())
        closes = [c for c in j["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c]
        if closes and 0 <= closes[-1] <= 20:
            rate = closes[-1] / 100.0
    except Exception:
        pass
    _rate_cache = (rate, time.time())
    return rate


# ------------------------------------------------------------------ analytics
def _mid(o: dict) -> float | None:
    return 0.5 * (o["bid"] + o["ask"]) if o["bid"] > 0 and o["ask"] >= o["bid"] > 0 else None


def implied_carry(rows: list[dict], S: float, r: float, T: float, n_strikes: int = 6) -> float | None:
    """Dividend yield from put-call parity:  C - P = S e^{-qT} - K e^{-rT}  =>  F = K + e^{rT}(C - P),  q = r - ln(F/S)/T."""
    if T <= 0:
        return None
    calls = {o["strike"]: _mid(o) for o in rows if o["type"] == "call"}
    puts = {o["strike"]: _mid(o) for o in rows if o["type"] == "put"}
    common = [k for k in calls if k in puts and calls[k] is not None and puts[k] is not None]
    if len(common) < 2:
        return None
    near = sorted(common, key=lambda k: abs(k - S))[:n_strikes]
    fwd = statistics.median(k + math.exp(r * T) * (calls[k] - puts[k]) for k in near)
    if fwd <= 0:
        return None
    return r - math.log(fwd / S) / T


def _dedupe(rows: list[dict]) -> list[dict]:
    """Index products list one strike under several roots (SPX and SPXW): keep the tightest bid/ask for each (type, strike)."""
    best: dict[tuple, dict] = {}
    for o in rows:
        key = (o["type"], o["strike"])
        spread = (o["ask"] - o["bid"]) if o["bid"] > 0 and o["ask"] >= o["bid"] else float("inf")
        if key not in best or spread < best[key][0]:
            best[key] = (spread, o)
    return [v[1] for v in best.values()]


def _by_expiry(rows: list[dict]) -> dict[str, list[dict]]:
    g: dict[str, list[dict]] = {}
    for o in rows:
        g.setdefault(o["expiry"], []).append(o)
    return g


def estimate_div_yield(rows: list[dict], S: float, r: float, now: dt.datetime | None = None) -> float:
    """One dividend yield for the ticker: parity estimate at the expiry nearest 60 days (14+ days out), clipped to [0, 15%]."""
    best = None
    for exp, g in _by_expiry(rows).items():
        T = year_fraction(exp, now)
        if T * 365 < 14:
            continue
        q = implied_carry(g, S, r, T)
        if q is None:
            continue
        dist = abs(T * 365 - 60)
        if best is None or dist < best[0]:
            best = (dist, q)
    return float(min(max(best[1], 0.0), 0.15)) if best else 0.0


def pick_expiries(days_by_expiry: list[tuple[str, float]], min_days: float, max_days: float, max_n: int) -> list[str]:
    """Expiries inside [min_days, max_days], thinned to max_n spread evenly (index products list dozens of weeklies)."""
    c = sorted((e, d) for e, d in days_by_expiry if min_days <= d <= max_days)
    if len(c) > max_n:
        idx = sorted({round(i * (len(c) - 1) / (max_n - 1)) for i in range(max_n)})
        c = [c[i] for i in idx]
    return [e for e, _ in c]


# ------------------------------------------------------------------ API payloads (what the site receives)
def quote(ticker: str) -> dict:
    sym, raw = fetch(ticker)
    S, r = spot_of(raw), risk_free_rate()
    rows = parse_options(raw)
    iv30 = _f(raw["data"].get("iv30")) / 100.0
    return dict(
        ticker=sym.lstrip("_"), name="", spot=S, rate=r, div_yield=estimate_div_yield(rows, S, r),
        hist_vol=None, hist_vol_1y=None, iv30=iv30 if iv30 > 0 else None,
        asof=asof_of(raw), expiries=sorted(_by_expiry(rows)), source="cboe",
    )


def chain(ticker: str, expiry: str) -> dict:
    """All quoted options for one expiry, in the row shape the site's contract picker expects."""
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", expiry or ""):
        raise ValueError("expiry must look like 2026-10-16")
    _, raw = fetch(ticker)
    rows = _dedupe([o for o in parse_options(raw) if o["expiry"] == expiry])
    if not rows:
        raise ValueError(f"No options for expiry {expiry}")
    out = [dict(type=o["type"], strike=o["strike"], bid=o["bid"], ask=o["ask"], lastPrice=o["last"], volume=o["volume"],
                openInterest=o["openInterest"], impliedVolatility=o["iv"]) for o in rows]
    return dict(expiry=expiry, T=year_fraction(expiry), rows=out)


def chains(ticker: str, min_days: float = 14, max_days: float = 160, max_expiries: int = 14, k_lo: float = -0.25, k_hi: float = 0.2) -> dict:
    """Compact multi-expiry chain (bid/ask only, quoted strikes near the money) for building a vol surface in the browser."""
    sym, raw = fetch(ticker)
    S, r = spot_of(raw), risk_free_rate()
    groups = _by_expiry(parse_options(raw))
    days = [(e, year_fraction(e) * 365) for e in groups]
    out = []
    for e in pick_expiries(days, min_days, max_days, max(2, max_expiries)):
        rows = [
            [o["type"][0], o["strike"], o["bid"], o["ask"]]
            for o in _dedupe(groups[e])
            if o["bid"] > 0 and o["ask"] > o["bid"] and k_lo <= math.log(o["strike"] / S) <= k_hi
        ]
        if len(rows) >= 8:
            out.append(dict(expiry=e, T=round(year_fraction(e), 6), rows=rows))
    if len(out) < 2:
        raise ValueError("Not enough liquid option expiries to build a surface for this ticker")
    return dict(ticker=sym.lstrip("_"), label=sym.lstrip("_"), spot=S, rate=r, asof=asof_of(raw), source="cboe", expiries=out)


# ------------------------------------------------------------------ tiny HTTP layer (serverless function or any WSGI-less host)
def dispatch(op: str, params: dict) -> dict:
    p = {k: v[0] for k, v in params.items()}
    if op == "ping":
        return {"ok": True, "source": "cboe", "quote": True, "chain": True, "chains": True, "surface": False}
    if op == "quote":
        return quote(p.get("ticker", ""))
    if op == "chain":
        return chain(p.get("ticker", ""), p.get("expiry", ""))
    if op == "chains":
        num = lambda k, d, lo, hi: min(max(_f(p.get(k), d), lo), hi)  # noqa: E731
        return chains(p.get("ticker", ""), num("min_days", 14, 1, 400), num("max_days", 160, 5, 800), int(num("max_expiries", 14, 3, 20)))
    raise ValueError(f"unknown operation '{op}'")


class BaseHandler(BaseHTTPRequestHandler):
    """Subclass and set `op` ('ping' | 'quote' | 'chain' | 'chains'). CORS is open: the data is public and delayed."""

    op = "ping"

    def _send(self, code: int, obj: dict):
        body = b"" if code == 204 else json.dumps(obj, separators=(",", ":")).encode()  # a 204 (CORS preflight) has no body
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        # let the CDN absorb repeat requests (quotes are 15-minute delayed anyway), but never cache an error
        self.send_header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300" if code == 200 else "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {})

    def do_GET(self):  # noqa: N802
        try:
            self._send(200, dispatch(self.op, parse_qs(urlparse(self.path).query)))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # upstream hiccup: say so instead of a bare 500
            self._send(502, {"error": f"Upstream data error: {type(e).__name__}: {e}"})
