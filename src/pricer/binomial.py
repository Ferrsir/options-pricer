"""Cox-Ross-Rubinstein binomial tree for European and American options.

Derivation in one paragraph (see METHODOLOGY.md for the long version)
    Over a step dt the stock moves to S*u or S*d with u = e^{sigma sqrt(dt)}, d = 1/u.
    Holding Delta shares plus a bond replicates the option payoff in both states, so the
    option's value today is the discounted expectation under the *risk-neutral* probability

        q_up = (e^{(r-q) dt} - d) / (u - d)        (needs d < e^{(r-q)dt} < u, else arbitrage)

        V = e^{-r dt} [ q_up V_up + (1 - q_up) V_down ].

    For an American option, at every node we keep max(continuation value, exercise value).
    That one extra `np.maximum` is the entire difference between the European and American code.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .bsm import _sign


@dataclass
class TreeResult:
    price: float
    delta: float
    gamma: float
    theta: float  # per year
    steps: int
    # Early-exercise boundary: for each time step, the critical spot where exercise becomes optimal
    # (puts: exercise when S <= boundary; calls: when S >= boundary). NaN if never optimal at that step.
    boundary_t: np.ndarray = field(default_factory=lambda: np.array([]))
    boundary_S: np.ndarray = field(default_factory=lambda: np.array([]))


def crr_parameters(T, r, sigma, q, steps):
    dt = T / steps
    u = np.exp(sigma * np.sqrt(dt))
    d = 1.0 / u
    growth = np.exp((r - q) * dt)
    if not (d < growth < u):
        raise ValueError(
            "No-arbitrage condition d < e^{(r-q)dt} < u violated - increase `steps` or check inputs "
            f"(d={d:.6f}, growth={growth:.6f}, u={u:.6f})."
        )
    p = (growth - d) / (u - d)
    return dt, u, d, p


def binomial_tree(S, K, T, r, sigma, q=0.0, kind="call", steps=500, american=True, want_boundary=False) -> TreeResult:
    """Price an option on a CRR tree. Also returns tree Delta, Gamma, Theta (Hull's method)."""
    phi = _sign(kind)
    steps = int(steps)
    dt, u, d, p = crr_parameters(T, r, sigma, q, steps)
    disc = np.exp(-r * dt)

    # Stock prices at the last step: S u^j d^(n-j) = S u^(2j-n), j = number of up moves
    j = np.arange(steps + 1)
    values = np.maximum(phi * (S * u ** (2 * j - steps) - K), 0.0)

    early = {}  # option values at steps 2, 1, 0 for Greeks
    b_t, b_S = [], []
    for i in range(steps - 1, -1, -1):
        values = disc * (p * values[1:] + (1.0 - p) * values[:-1])  # continuation
        if american:
            spots = S * u ** (2 * np.arange(i + 1) - i)
            exercise = np.maximum(phi * (spots - K), 0.0)
            if want_boundary:
                exercising = exercise > values + 1e-12
                b_t.append(i * dt)
                if exercising.any():
                    # boundary sits between the last exercise node and the first continue node
                    idx = np.flatnonzero(exercising)
                    if phi == -1:
                        hi = idx.max()
                        b_S.append(min(0.5 * (spots[hi] + spots[min(hi + 1, i)]), K))
                    else:
                        lo = idx.min()
                        b_S.append(max(0.5 * (spots[lo] + spots[max(lo - 1, 0)]), K))
                else:
                    b_S.append(np.nan)
            values = np.maximum(values, exercise)
        if i <= 2:
            early[i] = values.copy()

    price = float(values[0])
    delta = gamma = theta = float("nan")
    if steps >= 3:
        Su, Sd = S * u, S * d
        delta = (early[1][1] - early[1][0]) / (Su - Sd)
        S_uu, S_ud, S_dd = S * u * u, S, S * d * d
        d_up = (early[2][2] - early[2][1]) / (S_uu - S_ud)
        d_dn = (early[2][1] - early[2][0]) / (S_ud - S_dd)
        gamma = (d_up - d_dn) / (0.5 * (S_uu - S_dd))
        theta = (early[2][1] - price) / (2.0 * dt)  # middle node of step 2 has the same spot as today
    boundary_t = np.array(b_t[::-1])
    boundary_S = np.array(b_S[::-1])
    return TreeResult(price, float(delta), float(gamma), float(theta), steps, boundary_t, boundary_S)


def european_tree_price(S, K, T, r, sigma, q=0.0, kind="call", steps=500) -> float:
    return binomial_tree(S, K, T, r, sigma, q, kind, steps, american=False).price


def american_price(S, K, T, r, sigma, q=0.0, kind="call", steps=500) -> float:
    """American option premium via CRR tree (exercise-vs-continue at every node)."""
    return binomial_tree(S, K, T, r, sigma, q, kind, steps, american=True).price


def american_greeks(S, K, T, r, sigma, q=0.0, kind="call", steps=500):
    """Greeks for the American option.

    Delta/Gamma/Theta come straight from the first tree nodes. Vega and Rho have no node
    shortcut, so they are central finite differences (bump and re-price on the same tree).
    """
    res = binomial_tree(S, K, T, r, sigma, q, kind, steps, american=True)
    dv, dr = 0.005, 0.0005
    vega = (american_price(S, K, T, r, sigma + dv, q, kind, steps) - american_price(S, K, T, r, sigma - dv, q, kind, steps)) / (2 * dv)
    rho = (american_price(S, K, T, r + dr, sigma, q, kind, steps) - american_price(S, K, T, r - dr, sigma, q, kind, steps)) / (2 * dr)
    return dict(price=res.price, delta=res.delta, gamma=res.gamma, theta=res.theta, vega=vega, rho=rho)


def american_implied_vol(price, S, K, T, r, q=0.0, kind="call", steps=300, lo=1e-3, hi=5.0):
    """Implied vol under the American (tree) model - what you want for single-stock options."""
    from scipy.optimize import brentq

    f = lambda s: american_price(S, K, T, r, s, q, kind, steps) - price
    try:
        if f(lo) > 0 or f(hi) < 0:
            return float("nan")
        return brentq(f, lo, hi, xtol=1e-8, maxiter=100)
    except ValueError:
        return float("nan")


def convergence_table(S, K, T, r, sigma, q=0.0, kind="call", step_list=(5, 10, 25, 50, 100, 250, 500, 1000, 2000)):
    """European tree price vs closed-form BSM as steps grow (error should shrink ~ 1/steps)."""
    from .bsm import bsm_price

    exact = bsm_price(S, K, T, r, sigma, q, kind)
    rows = []
    for n in step_list:
        eu = european_tree_price(S, K, T, r, sigma, q, kind, n)
        am = american_price(S, K, T, r, sigma, q, kind, n)
        rows.append(dict(steps=n, european_tree=eu, bsm=exact, error=eu - exact, american_tree=am))
    return rows
