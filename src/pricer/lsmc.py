"""Longstaff-Schwartz Monte Carlo (LSMC) for American options.

Idea
    1. Simulate many risk-neutral GBM paths on a grid of exercise dates.
    2. Walk backward. At each date, among the paths that are in the money, regress the *discounted
       future cash flow* on basis functions of the current spot. The fitted curve is an estimate of
       the continuation value E[V_{t+dt} | S_t].
    3. Exercise on a path if immediate payoff > fitted continuation value; otherwise keep the future cash flow.
    4. The price is the average discounted cash flow at time 0.

The regression in step 2 is the piece the RKHS project generalises: swap the polynomial basis for
a kernel (an infinite-dimensional basis) and you get kernel ridge regression of the continuation value.

Because exercise decisions use an *estimated* continuation value, decisions are slightly sub-optimal,
so LSMC is biased low relative to the true American price (and is only Bermudan on a finite grid).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .bsm import _sign


@dataclass
class LSMCResult:
    price: float
    std_error: float
    paths: int
    steps: int


def _basis(x: np.ndarray, degree: int, kind: str) -> np.ndarray:
    """Design matrix of basis functions in x = S/K."""
    if kind == "laguerre":
        # weighted Laguerre polynomials (the original Longstaff-Schwartz choice)
        w = np.exp(-x / 2.0)
        cols = [w, w * (1 - x), w * (1 - 2 * x + 0.5 * x**2), w * (1 - 3 * x + 1.5 * x**2 - x**3 / 6.0)]
        return np.column_stack(cols[: degree + 1])
    return np.column_stack([x**k for k in range(degree + 1)])  # plain monomials


def lsmc_price(
    S, K, T, r, sigma, q=0.0, kind="put", paths=50_000, steps=50, degree=3, basis="laguerre", seed=42
) -> LSMCResult:
    phi = _sign(kind)
    rng = np.random.default_rng(seed)
    dt = T / steps
    half = paths // 2  # antithetic variates: use Z and -Z to halve the noise
    z = rng.standard_normal((half, steps))
    z = np.vstack([z, -z])
    n = z.shape[0]

    drift = (r - q - 0.5 * sigma**2) * dt
    log_paths = np.cumsum(drift + sigma * np.sqrt(dt) * z, axis=1)
    spots = S * np.exp(log_paths)  # shape (n, steps): S at t = dt ... T

    disc = np.exp(-r * dt)
    cash = np.maximum(phi * (spots[:, -1] - K), 0.0)  # cash flow if held to maturity
    for t in range(steps - 2, -1, -1):
        cash = cash * disc  # bring the future cash flow back one step
        s_t = spots[:, t]
        payoff = np.maximum(phi * (s_t - K), 0.0)
        itm = payoff > 0
        if itm.sum() > degree + 2:
            A = _basis(s_t[itm] / K, degree, basis)
            coef, *_ = np.linalg.lstsq(A, cash[itm], rcond=None)
            continuation = A @ coef
            exercise = payoff[itm] > continuation
            idx = np.where(itm)[0][exercise]
            cash[idx] = payoff[idx]
    pv = cash * disc  # from t = dt to t = 0
    # Exercising immediately at t=0 is worth max(S-K,0); the tree/BSM comparison uses the continuation value
    price = float(np.mean(pv))
    price = max(price, float(np.maximum(phi * (S - K), 0.0)))
    se = float(np.std(pv, ddof=1) / np.sqrt(n))
    return LSMCResult(price=price, std_error=se, paths=n, steps=steps)
