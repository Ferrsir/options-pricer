"""The sanity checks from the HW 1 slide ("if one fails, stop and find out why")."""
from __future__ import annotations

from math import exp

from .binomial import american_price, european_tree_price
from .bsm import bsm_price, intrinsic, put_call_parity_gap


def run_sanity_checks(S=100.0, K=100.0, T=1.0, r=0.05, sigma=0.2, q=0.0, steps=1000) -> list[dict]:
    """Returns a list of {name, passed, detail}."""
    out = []

    def add(name, passed, detail):
        out.append(dict(name=name, passed=bool(passed), detail=detail))

    # 1. BSM reference value
    c = bsm_price(100, 100, 1, 0.05, 0.2, 0.0, "call")
    add("BSM reference: C(100,100,1y,5%,20%) = 10.4506", abs(c - 10.4506) < 1e-3, f"got {c:.4f}")

    # 2. Put-call parity
    call, put = bsm_price(S, K, T, r, sigma, q, "call"), bsm_price(S, K, T, r, sigma, q, "put")
    gap = put_call_parity_gap(call, put, S, K, T, r, q)
    add("Put-call parity: C - P = S e^{-qT} - K e^{-rT}", abs(gap) < 1e-10, f"gap = {gap:.2e}")

    # 3. European tree converges to BSM
    tree = european_tree_price(S, K, T, r, sigma, q, "call", steps)
    add(f"European tree ({steps} steps) matches BSM", abs(tree - call) < 0.01, f"tree {tree:.4f} vs BSM {call:.4f}")

    # 4. American call, no dividends = European call (Merton 1973)
    am_c = american_price(S, K, T, r, sigma, 0.0, "call", steps)
    eu_c = european_tree_price(S, K, T, r, sigma, 0.0, "call", steps)
    add("American call (q=0) has zero early-exercise premium", abs(am_c - eu_c) < 1e-9, f"premium = {am_c - eu_c:.2e}")

    # 5. American put strictly worth more than European put when r > 0
    am_p = american_price(S, K, T, r, sigma, q, "put", steps)
    eu_p = european_tree_price(S, K, T, r, sigma, q, "put", steps)
    add("American put premium over European put is positive (r>0)", am_p - eu_p > 1e-3, f"premium = {am_p - eu_p:.4f}")

    # 6. Deep ITM -> intrinsic (American), deep OTM -> ~0
    deep_itm = american_price(100, 50, 0.25, r, sigma, 0.0, "call", 500)
    intr = float(intrinsic(100, 50, "call"))
    carry = 50 * (1 - exp(-r * 0.25))  # all the time value a deep-ITM no-dividend call has: interest on the strike
    add("Deep ITM call ≈ intrinsic (time value = only interest on strike)", intr <= deep_itm <= intr + carry + 0.01,
        f"price {deep_itm:.3f}, intrinsic {intr:.0f}, max time value {carry:.3f}")
    deep_otm = bsm_price(100, 200, 0.25, r, sigma, q, "call")
    add("Deep OTM call ≈ 0", deep_otm < 1e-6, f"price {deep_otm:.2e}")

    # 7. Vol up -> price up
    lo, hi = bsm_price(S, K, T, r, 0.15, q, "call"), bsm_price(S, K, T, r, 0.35, q, "call")
    add("Higher vol -> higher premium", hi > lo, f"{lo:.3f} -> {hi:.3f}")

    # 8. r -> 0 kills the put's early exercise edge
    p0a = american_price(S, K, T, 0.0, sigma, 0.0, "put", steps)
    p0e = european_tree_price(S, K, T, 0.0, sigma, 0.0, "put", steps)
    add("r → 0 removes the American put's early-exercise premium", abs(p0a - p0e) < 1e-9, f"premium = {p0a - p0e:.2e}")

    # 9. American >= European >= intrinsic-ish lower bound
    add("American put ≥ intrinsic value everywhere", american_price(80, 100, T, r, sigma, q, "put", 500) >= 20 - 1e-9, "80/100 put ≥ 20")
    return out
