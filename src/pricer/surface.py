"""Implied-volatility surface construction.

Pipeline (matches the footer of the reference picture)
    1. Log-moneyness transform: k = ln(K / S). Strikes from different underlyings/dates become comparable.
    2. Quote conditioning: keep out-of-the-money options only (puts below the forward, calls above -
       they are the liquid ones and carry the least early-exercise premium), filter bad quotes,
       invert Black-Scholes-Merton for implied vol.
    3. Savitzky-Golay conditioning: drop outliers, then smooth each expiry's smile with a local
       polynomial (window 7, order 2) so that quote noise does not show up as spikes.
    4. Two-stage PCHIP: (a) monotone-cubic interpolation across strike inside each expiry;
       (b) monotone-cubic interpolation across time at each fixed strike. Interpolating *total variance*
       w = sigma^2 T in stage (b) keeps the surface free of calendar-spread arbitrage
       (total variance must not decrease with maturity).

PCHIP (Piecewise Cubic Hermite Interpolating Polynomial) never overshoots the data, unlike a natural
cubic spline, which is exactly what you want for a surface you are going to trade off.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.interpolate import PchipInterpolator
from scipy.signal import savgol_filter

from .bsm import implied_vol_vec

EXTRAP_DAMPING = 0.5  # fraction of the edge slope used when extrapolating a smile past its quoted strikes


@dataclass
class VolSurface:
    k: np.ndarray  # log-moneyness grid, shape (nk,)
    T: np.ndarray  # maturity grid in years, shape (nT,)
    iv: np.ndarray  # implied vol, shape (nT, nk)
    spot: float
    asof: str
    label: str = ""
    points: pd.DataFrame = field(default_factory=pd.DataFrame)  # the conditioned market IVs used
    implied_q: dict = field(default_factory=dict)  # per-expiry dividend yield backed out of put-call parity

    def to_json(self) -> dict:
        return dict(
            k=self.k.round(5).tolist(),
            T=self.T.round(5).tolist(),
            iv=np.round(self.iv, 5).tolist(),
            spot=self.spot,
            asof=self.asof,
            label=self.label,
        )


def implied_dividend_yields(chain: pd.DataFrame, S: float, r: float, n_strikes: int = 6) -> dict:
    """Back out q per expiry from put-call parity:  C - P = S e^{-qT} - K e^{-rT}  =>  F = K + e^{rT}(C-P)."""
    out = {}
    for T, g in chain.groupby("T"):
        c = g[g["type"] == "call"].set_index("strike")["mid"]
        p = g[g["type"] == "put"].set_index("strike")["mid"]
        common = c.index.intersection(p.index)
        common = [k for k in common if np.isfinite(c[k]) and np.isfinite(p[k])]
        if len(common) < 2:
            continue  # filled in below from neighbouring expiries
        near = sorted(common, key=lambda k: abs(k - S))[:n_strikes]
        fwd = np.median([k + np.exp(r * T) * (c[k] - p[k]) for k in near])
        q = r - np.log(fwd / S) / T
        if np.isfinite(q):
            out[T] = float(np.clip(q, -0.02, 0.15))
    # Expiries with no usable put/call pair borrow q from the nearest expiries that have one
    all_T = sorted(chain["T"].unique())
    if out:
        known_T = np.array(sorted(out))
        known_q = np.array([out[t] for t in known_T])
        return {T: (out[T] if T in out else float(np.interp(T, known_T, known_q))) for T in all_T}
    return {T: 0.0 for T in all_T}


def condition_chain(chain: pd.DataFrame, S: float, r: float, k_range=(-0.15, 0.10), max_rel_spread=0.6):
    """Chain -> DataFrame of clean (T, k, iv) points using OTM options and per-expiry implied q."""
    qmap = implied_dividend_yields(chain, S, r)
    df = chain.copy()
    df["q"] = df["T"].map(qmap)
    df["fwd"] = S * np.exp((r - df["q"]) * df["T"])
    df["k"] = np.log(df["strike"] / S)
    otm = ((df["type"] == "put") & (df["strike"] < df["fwd"])) | ((df["type"] == "call") & (df["strike"] >= df["fwd"]))
    spread_ok = ((df["ask"] - df["bid"]) / df["mid"]) < max_rel_spread
    df = df[otm & spread_ok & df["mid"].notna() & df["k"].between(*k_range)].copy()
    # one quote per (expiry, strike): index products list duplicate roots, and PCHIP needs strictly increasing strikes
    df = df.assign(_rel=(df["ask"] - df["bid"]) / df["mid"]).sort_values("_rel").drop_duplicates(["T", "strike"]).drop(columns="_rel")
    df["iv"] = implied_vol_vec(df["mid"], S, df["strike"], df["T"], r, df["q"], df["type"] == "call")
    df = df[np.isfinite(df["iv"]) & (df["iv"] > 0.02) & (df["iv"] < 3.0)]
    return df[["T", "strike", "k", "iv", "type", "mid"]].sort_values(["T", "k"]).reset_index(drop=True), qmap


def _reject_outliers(k: np.ndarray, iv: np.ndarray, width: int = 5, n_mad: float = 4.0):
    """Drop points that sit far from a rolling median of their neighbours (robust z-score via MAD)."""
    if len(iv) < width + 2:
        return k, iv
    half = width // 2
    med = np.array([np.median(iv[max(0, i - half) : i + half + 1]) for i in range(len(iv))])
    resid = iv - med
    mad = np.median(np.abs(resid - np.median(resid))) + 1e-9
    keep = np.abs(resid) < n_mad * 1.4826 * mad
    return k[keep], iv[keep]


def smooth_smile(k: np.ndarray, iv: np.ndarray, window: int = 7, order: int = 2):
    """Savitzky-Golay smoothing of one expiry's smile (after outlier rejection)."""
    k, iv = _reject_outliers(k, iv)
    if len(iv) < order + 2:
        return k, iv
    w = min(window, len(iv) if len(iv) % 2 == 1 else len(iv) - 1)
    if w <= order:
        return k, iv
    return k, savgol_filter(iv, window_length=w, polyorder=order, mode="interp")


def build_surface(
    chain: pd.DataFrame,
    spot: float,
    rate: float,
    asof: str = "",
    label: str = "",
    k_range=(-0.15, 0.10),
    nk: int = 60,
    nT: int = 50,
    min_points: int = 7,
) -> VolSurface:
    pts, qmap = condition_chain(chain, spot, rate, k_range)

    # Stage 0: Savitzky-Golay conditioning of every expiry's smile
    smiles = []
    for T, g in pts.groupby("T"):
        if len(g) < min_points:
            continue
        k, iv = smooth_smile(g["k"].to_numpy(), g["iv"].to_numpy())
        if len(k) >= 4:
            smiles.append((float(T), k, iv))
    if len(smiles) < 2:
        raise ValueError("Need at least two maturities with enough clean quotes to build a surface")

    k_grid = np.linspace(k_range[0], k_range[1], nk)
    Ts = np.array([s[0] for s in smiles])

    # Stage 1: PCHIP across strike inside each expiry, evaluated on the common k grid.
    # Beyond the quoted strikes we extrapolate linearly with a damped edge slope (holding the smile flat
    # would build vertical cliffs on short-dated expiries whose strikes are narrow), clipped to a sane band.
    lo_cap, hi_cap = 0.7 * pts["iv"].min(), 1.3 * pts["iv"].max()
    w_by_T = np.empty((len(smiles), nk))
    for i, (T, k, iv) in enumerate(smiles):
        f = PchipInterpolator(k, iv, extrapolate=False)
        n_edge = min(4, len(k))
        slope_lo = np.polyfit(k[:n_edge], iv[:n_edge], 1)[0]
        slope_hi = np.polyfit(k[-n_edge:], iv[-n_edge:], 1)[0]
        vals = f(k_grid)
        vals = np.where(k_grid < k[0], iv[0] + EXTRAP_DAMPING * slope_lo * (k_grid - k[0]), vals)
        vals = np.where(k_grid > k[-1], iv[-1] + EXTRAP_DAMPING * slope_hi * (k_grid - k[-1]), vals)
        vals = np.clip(vals, lo_cap, hi_cap)
        w_by_T[i] = vals**2 * T  # total variance

    # Stage 2: PCHIP across time at every strike (on total variance), then convert back to vol.
    T_grid = np.linspace(Ts.min(), Ts.max(), nT)
    iv_grid = np.empty((nT, nk))
    for j in range(nk):
        w_col = np.maximum.accumulate(w_by_T[:, j])  # enforce no calendar arbitrage in the input
        w_T = PchipInterpolator(Ts, w_col)(T_grid)
        iv_grid[:, j] = np.sqrt(np.maximum(w_T, 1e-10) / T_grid)

    return VolSurface(k_grid, T_grid, iv_grid, spot, asof, label, pts, qmap)


def synthetic_chain(spot=25000.0, rate=0.04, q=0.01, seed=7, noise=0.004, n_T=8) -> pd.DataFrame:
    """A realistic-looking fake option chain (skewed smile + term structure + quote noise).

    Used for `--demo` mode, for tests, and so the site works with no network. Prices come from
    BSM with a known vol function, so the surface pipeline can be tested for recovery.
    """
    from .bsm import bsm_price

    rng = np.random.default_rng(seed)
    rows = []
    for days in np.linspace(14, 160, n_T):
        T = days / 365.0
        for K in np.linspace(spot * 0.84, spot * 1.12, 70):
            k = np.log(K / spot)
            base = 0.17 + 0.03 * np.exp(-T * 6)  # term structure (high short-dated vol decaying)
            iv = base - 0.55 * k * np.exp(-T * 1.5) + 2.2 * k**2 + rng.normal(0, noise)
            iv = max(iv, 0.06)
            for kind in ("call", "put"):
                mid = bsm_price(spot, K, T, rate, iv, q, kind)
                if mid < 0.05:
                    continue
                rows.append(dict(expiry=f"{days:.0f}d", type=kind, strike=round(K, 0), bid=mid * 0.995,
                                 ask=mid * 1.005, mid=mid, T=T, volume=100, openInterest=100))
    return pd.DataFrame(rows)
