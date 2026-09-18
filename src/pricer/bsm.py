"""Black-Scholes-Merton pricing, Greeks and implied volatility (European options).

Notation used everywhere in this package
    S      spot price of the underlying
    K      strike
    T      time to expiry in years
    r      continuously-compounded risk-free rate
    sigma  volatility (annualised, e.g. 0.20 = 20%)
    q      continuous dividend yield
    kind   "call" or "put"

Every function accepts scalars or numpy arrays (they broadcast).
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import brentq
from scipy.special import ndtr  # standard normal CDF, vectorised and fast

SQRT_2PI = np.sqrt(2.0 * np.pi)


def _pdf(x):
    return np.exp(-0.5 * x * x) / SQRT_2PI


def _sign(kind: str) -> int:
    kind = kind.lower()
    if kind in ("call", "c"):
        return 1
    if kind in ("put", "p"):
        return -1
    raise ValueError(f"kind must be 'call' or 'put', got {kind!r}")


def d1_d2(S, K, T, r, sigma, q=0.0):
    """d1 = [ln(S/K) + (r - q + sigma^2/2) T] / (sigma sqrt(T)),  d2 = d1 - sigma sqrt(T)."""
    S, K, T, r, sigma, q = (np.asarray(x, dtype=float) for x in (S, K, T, r, sigma, q))
    vol_sqrt_t = sigma * np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma**2) * T) / vol_sqrt_t
    return d1, d1 - vol_sqrt_t


def intrinsic(S, K, kind="call"):
    """Payoff if exercised right now: (S-K)+ for a call, (K-S)+ for a put."""
    return np.maximum(_sign(kind) * (np.asarray(S, dtype=float) - K), 0.0)


def bsm_price(S, K, T, r, sigma, q=0.0, kind="call"):
    """European option premium.

    call = S e^{-qT} N(d1) - K e^{-rT} N(d2)
    put  = K e^{-rT} N(-d2) - S e^{-qT} N(-d1)

    T <= 0 or sigma <= 0 degenerates to the (discounted-forward) intrinsic value.
    """
    phi = _sign(kind)
    S, K, T, r, sigma, q = np.broadcast_arrays(*(np.asarray(x, dtype=float) for x in (S, K, T, r, sigma, q)))
    degenerate = (T <= 0) | (sigma <= 0)
    Ts = np.where(degenerate, 1.0, T)
    sg = np.where(degenerate, 1.0, sigma)
    d1, d2 = d1_d2(S, K, Ts, r, sg, q)
    live = phi * (S * np.exp(-q * Ts) * ndtr(phi * d1) - K * np.exp(-r * Ts) * ndtr(phi * d2))
    # Zero-vol / expired limit: forward payoff discounted
    Tf = np.maximum(T, 0.0)
    limit = np.maximum(phi * (S * np.exp(-q * Tf) - K * np.exp(-r * Tf)), 0.0)
    out = np.where(degenerate, limit, live)
    return float(out) if out.ndim == 0 else out


def bsm_greeks(S, K, T, r, sigma, q=0.0, kind="call"):
    """Closed-form Greeks. Returns a dict with

    delta   dV/dS
    gamma   d2V/dS2
    vega    dV/dsigma            (per 1.00 change in vol; divide by 100 for "per vol point")
    theta   dV/dt (per year)     (negative for long options; divide by 365 for per calendar day)
    rho     dV/dr                (per 1.00 change in r;   divide by 100 for "per 1%")
    vanna   d2V/(dS dsigma)      (how delta changes as vol changes)
    volga   d2V/dsigma2          (a.k.a. vomma - convexity in vol)
    """
    phi = _sign(kind)
    S, K, T, r, sigma, q = (np.asarray(x, dtype=float) for x in (S, K, T, r, sigma, q))
    d1, d2 = d1_d2(S, K, T, r, sigma, q)
    sqrt_t = np.sqrt(T)
    disc_q, disc_r = np.exp(-q * T), np.exp(-r * T)
    pdf_d1 = _pdf(d1)

    delta = phi * disc_q * ndtr(phi * d1)
    gamma = disc_q * pdf_d1 / (S * sigma * sqrt_t)
    vega = S * disc_q * pdf_d1 * sqrt_t
    theta = (
        -S * disc_q * pdf_d1 * sigma / (2.0 * sqrt_t)
        - phi * r * K * disc_r * ndtr(phi * d2)
        + phi * q * S * disc_q * ndtr(phi * d1)
    )
    rho = phi * K * T * disc_r * ndtr(phi * d2)
    vanna = -disc_q * pdf_d1 * d2 / sigma
    volga = vega * d1 * d2 / sigma
    out = dict(delta=delta, gamma=gamma, vega=vega, theta=theta, rho=rho, vanna=vanna, volga=volga)
    return {k: (float(v) if np.ndim(v) == 0 else v) for k, v in out.items()}


def no_arbitrage_bounds(S, K, T, r, q=0.0, kind="call"):
    """Model-free price bounds for a European option: (lower, upper)."""
    phi = _sign(kind)
    fwd_disc = S * np.exp(-q * T) - K * np.exp(-r * T)
    lower = max(phi * fwd_disc, 0.0)
    upper = S * np.exp(-q * T) if phi == 1 else K * np.exp(-r * T)
    return lower, upper


def implied_vol(price, S, K, T, r, q=0.0, kind="call", lo=1e-4, hi=5.0):
    """Volatility that makes BSM price equal the observed premium (Brent root-find).

    Returns NaN if the premium violates no-arbitrage bounds (no vol can produce it).
    BSM price is strictly increasing in sigma (vega > 0), so the root is unique.
    """
    lower, upper = no_arbitrage_bounds(S, K, T, r, q, kind)
    if not (lower + 1e-12 < price < upper - 1e-12) or T <= 0:
        return float("nan")
    f = lambda s: bsm_price(S, K, T, r, s, q, kind) - price
    if f(lo) > 0 or f(hi) < 0:
        return float("nan")
    return brentq(f, lo, hi, xtol=1e-10, rtol=1e-12, maxiter=200)


def implied_vol_vec(price, S, K, T, r, q, is_call, lo=1e-4, hi=5.0, iters=60):
    """Vectorised implied vol by bisection (used for whole option chains).

    is_call is a boolean array. Points outside the arbitrage bounds return NaN.
    Bisection is slower than Newton but cannot diverge, which matters on messy quotes.
    """
    price, S, K, T, r, q = np.broadcast_arrays(*(np.asarray(x, dtype=float) for x in (price, S, K, T, r, q)))
    is_call = np.broadcast_to(np.asarray(is_call, dtype=bool), price.shape)
    phi = np.where(is_call, 1.0, -1.0)
    Tp = np.maximum(T, 1e-12)
    fwd_disc = S * np.exp(-q * Tp) - K * np.exp(-r * Tp)
    lower = np.maximum(phi * fwd_disc, 0.0)
    upper = np.where(is_call, S * np.exp(-q * Tp), K * np.exp(-r * Tp))
    ok = (T > 0) & (price > lower + 1e-10) & (price < upper - 1e-10)

    def px(sig):
        d1, d2 = d1_d2(S, K, Tp, r, sig, q)
        return phi * (S * np.exp(-q * Tp) * ndtr(phi * d1) - K * np.exp(-r * Tp) * ndtr(phi * d2))

    a = np.full(price.shape, lo)
    b = np.full(price.shape, hi)
    for _ in range(iters):
        m = 0.5 * (a + b)
        too_high = px(m) > price
        b = np.where(too_high, m, b)
        a = np.where(too_high, a, m)
    iv = 0.5 * (a + b)
    iv = np.where(ok & (iv > lo * 1.01) & (iv < hi * 0.99), iv, np.nan)
    return iv


def put_call_parity_gap(call, put, S, K, T, r, q=0.0):
    """C - P - (S e^{-qT} - K e^{-rT}); should be ~0 for European options."""
    return call - put - (S * np.exp(-q * T) - K * np.exp(-r * T))
