"""Market data from Yahoo Finance (via the `yfinance` package).

Nothing here is needed to *price* an option - it just fills in the inputs (spot, rate, dividend
yield, historical vol) and downloads option chains so that we can compare model prices with the market.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

DEFAULT_RATE = 0.04  # fallback risk-free rate if ^IRX is unavailable


def _yf():
    import yfinance as yf  # imported lazily so the pricing core has no network dependency

    return yf


def normalize_ticker(ticker: str) -> str:
    """Yahoo uses ^NDX / ^SPX style symbols for indexes; accept NDX / SPX / NASDAQ100 as shortcuts."""
    t = ticker.strip().upper()
    aliases = {"NDX": "^NDX", "SPX": "^SPX", "VIX": "^VIX", "RUT": "^RUT", "DJI": "^DJI", "NASDAQ100": "^NDX", "SP500": "^GSPC"}
    return aliases.get(t, t)


@dataclass
class Quote:
    ticker: str
    spot: float
    rate: float
    div_yield: float
    hist_vol: float  # annualised, from 30 trading days of log returns
    hist_vol_1y: float
    asof: str
    name: str = ""
    iv30: float = float("nan")  # 30-day implied vol (only from the Cboe fallback)
    source: str = "yahoo"


def risk_free_rate() -> float:
    """13-week T-bill yield (^IRX, quoted in percent) as a proxy for the risk-free rate."""
    try:
        h = _yf().Ticker("^IRX").history(period="5d")
        return float(h["Close"].dropna().iloc[-1]) / 100.0
    except Exception:
        return DEFAULT_RATE


def historical_vol(closes: pd.Series, window: int | None = None) -> float:
    rets = np.log(closes.dropna()).diff().dropna()
    if window:
        rets = rets.tail(window)
    return float(rets.std(ddof=1) * np.sqrt(252)) if len(rets) > 2 else float("nan")


def trailing_dividend_yield(tk, spot: float) -> float:
    try:
        div = tk.dividends
        if div is None or len(div) == 0:
            return 0.0
        cutoff = pd.Timestamp.now(tz=div.index.tz) - pd.Timedelta(days=365)
        return float(div[div.index >= cutoff].sum() / spot)
    except Exception:
        return 0.0


def _quote_from_cboe(ticker: str) -> Quote:
    from . import cboe

    q = cboe.quote(ticker)
    nan = float("nan")
    return Quote(ticker=q["ticker"], spot=q["spot"], rate=q["rate"], div_yield=q["div_yield"], hist_vol=nan, hist_vol_1y=nan,
                 asof=q["asof"], name=q["name"], iv30=q["iv30"] if q["iv30"] else nan, source="cboe")


def get_quote(ticker: str) -> Quote:
    """Yahoo Finance first (has price history, so historical vol); Cboe's public chains when Yahoo fails or has no data."""
    try:
        return _get_quote_yahoo(ticker)
    except Exception:
        return _quote_from_cboe(ticker)


def _get_quote_yahoo(ticker: str) -> Quote:
    yf = _yf()
    sym = normalize_ticker(ticker)
    tk = yf.Ticker(sym)
    hist = tk.history(period="1y", auto_adjust=False)
    if hist.empty:
        raise ValueError(f"No price data found for {ticker!r}")
    closes = hist["Close"]
    try:  # cheap: comes with the history call (tk.info would add several seconds)
        meta = tk.history_metadata or {}
        name = meta.get("shortName") or meta.get("longName") or ""
    except Exception:
        name = ""
    return Quote(
        ticker=sym,
        spot=float(closes.iloc[-1]),
        rate=risk_free_rate(),
        div_yield=trailing_dividend_yield(tk, float(closes.iloc[-1])),
        hist_vol=historical_vol(closes, 30),
        hist_vol_1y=historical_vol(closes),
        asof=str(closes.index[-1].date()),
        name=name,
    )


def expiries(ticker: str) -> list[str]:
    try:
        e = list(_yf().Ticker(normalize_ticker(ticker)).options)
        if e:
            return e
    except Exception:
        pass
    from . import cboe

    return cboe.quote(ticker)["expiries"]


def year_fraction(expiry: str, now: pd.Timestamp | None = None) -> float:
    """Years from now until 4pm New York on the expiry date (ACT/365)."""
    now = now or pd.Timestamp.now(tz="America/New_York")
    exp = pd.Timestamp(expiry).tz_localize("America/New_York") + pd.Timedelta(hours=16)
    return max((exp - now).total_seconds() / (365.0 * 86400.0), 0.0)


def _chain_from_cboe(ticker: str, expiry: str) -> pd.DataFrame:
    from . import cboe

    rows = cboe.chain(ticker, expiry)["rows"]
    df = pd.DataFrame(rows).assign(expiry=expiry)
    df["mid"] = np.where((df["bid"] > 0) & (df["ask"] > 0), 0.5 * (df["bid"] + df["ask"]), np.nan)
    return df[["expiry", "type", "strike", "bid", "ask", "mid", "lastPrice", "volume", "openInterest", "impliedVolatility"]]


def get_chain(ticker: str, expiry: str) -> pd.DataFrame:
    """Calls and puts for one expiry in a single tidy DataFrame (Yahoo, else Cboe)."""
    try:
        df = _get_chain_yahoo(ticker, expiry)
        if len(df):
            return df
    except Exception:
        pass
    return _chain_from_cboe(ticker, expiry)


def _get_chain_yahoo(ticker: str, expiry: str) -> pd.DataFrame:
    ch = _yf().Ticker(normalize_ticker(ticker)).option_chain(expiry)
    calls, puts = ch.calls.copy(), ch.puts.copy()
    calls["type"], puts["type"] = "call", "put"
    df = pd.concat([calls, puts], ignore_index=True)
    df["expiry"] = expiry
    df["mid"] = np.where((df["bid"] > 0) & (df["ask"] > 0), 0.5 * (df["bid"] + df["ask"]), np.nan)
    keep = ["expiry", "type", "strike", "bid", "ask", "mid", "lastPrice", "volume", "openInterest", "impliedVolatility"]
    return df[[c for c in keep if c in df.columns]]


def _full_chain_from_cboe(ticker: str, min_days: float, max_days: float, max_expiries: int) -> pd.DataFrame:
    from . import cboe

    payload = cboe.chains(ticker, min_days, max_days, max_expiries)
    rows = [dict(expiry=e["expiry"], T=e["T"], type="call" if t == "c" else "put", strike=k, bid=b, ask=a, mid=0.5 * (b + a))
            for e in payload["expiries"] for t, k, b, a in e["rows"]]
    return pd.DataFrame(rows)


def get_full_chain(ticker: str, min_days: float = 7, max_days: float = 200, max_expiries: int = 14) -> pd.DataFrame:
    """Yahoo chains, falling back to Cboe's public chains when Yahoo has none or fails."""
    try:
        return _get_full_chain_yahoo(ticker, min_days, max_days, max_expiries)
    except Exception:
        return _full_chain_from_cboe(ticker, min_days, max_days, max_expiries)


def _get_full_chain_yahoo(ticker: str, min_days: float = 7, max_days: float = 200, max_expiries: int = 14) -> pd.DataFrame:
    """Chains for many expiries, tagged with T (years).

    Index products list dozens of near-dated weeklies, so instead of taking the first N expiries we
    keep N expiries spread evenly across the maturity range (this is what gives the surface a long time axis).
    """
    now = pd.Timestamp.now(tz="America/New_York")
    cands = [(e, year_fraction(e, now)) for e in expiries(ticker)]
    cands = [(e, T) for e, T in cands if min_days <= T * 365 <= max_days]
    if len(cands) > max_expiries:
        idx = np.unique(np.linspace(0, len(cands) - 1, max_expiries).round().astype(int))
        cands = [cands[i] for i in idx]
    frames = []
    for e, T in cands:
        try:
            df = get_chain(ticker, e)
        except Exception:
            continue
        df["T"] = T
        frames.append(df)
    if not frames:
        raise ValueError(f"No option chains found for {ticker!r} in the requested maturity range")
    return pd.concat(frames, ignore_index=True)
