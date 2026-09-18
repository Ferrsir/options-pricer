import numpy as np
import pytest

from pricer.binomial import american_greeks, american_price, binomial_tree, european_tree_price
from pricer.bsm import bsm_greeks, bsm_price, implied_vol, implied_vol_vec
from pricer.checks import run_sanity_checks
from pricer.lsmc import lsmc_price
from pricer.surface import build_surface, synthetic_chain

P = dict(S=100.0, K=100.0, T=1.0, r=0.05, sigma=0.2, q=0.0)


def test_bsm_known_values():
    assert bsm_price(**P, kind="call") == pytest.approx(10.4506, abs=1e-4)
    assert bsm_price(**P, kind="put") == pytest.approx(5.5735, abs=1e-4)


@pytest.mark.parametrize("q", [0.0, 0.03])
def test_put_call_parity(q):
    p = {**P, "q": q}
    c, pu = bsm_price(**p, kind="call"), bsm_price(**p, kind="put")
    assert c - pu == pytest.approx(p["S"] * np.exp(-q * p["T"]) - p["K"] * np.exp(-p["r"] * p["T"]), abs=1e-10)


def test_greeks_match_finite_differences():
    for kind in ("call", "put"):
        g = bsm_greeks(**P, kind=kind)
        h = 1e-3
        f = lambda **kw: bsm_price(**{**P, **kw}, kind=kind)
        assert g["delta"] == pytest.approx((f(S=100 + h) - f(S=100 - h)) / (2 * h), rel=1e-6)
        assert g["gamma"] == pytest.approx((f(S=100 + h) - 2 * f() + f(S=100 - h)) / h**2, rel=1e-4)
        assert g["vega"] == pytest.approx((f(sigma=0.2 + h) - f(sigma=0.2 - h)) / (2 * h), rel=1e-5)
        assert g["rho"] == pytest.approx((f(r=0.05 + h) - f(r=0.05 - h)) / (2 * h), rel=1e-5)
        assert g["theta"] == pytest.approx(-(f(T=1 + h) - f(T=1 - h)) / (2 * h), rel=1e-5)


def test_greeks_with_dividend_yield():
    p = {**P, "q": 0.03}
    g = bsm_greeks(**p, kind="put")
    h = 1e-3
    fd = (bsm_price(**{**p, "T": 1 + h}, kind="put") - bsm_price(**{**p, "T": 1 - h}, kind="put")) / (2 * h)
    assert g["theta"] == pytest.approx(-fd, abs=1e-5)


@pytest.mark.parametrize("kind", ["call", "put"])
def test_implied_vol_roundtrip(kind):
    for sigma in (0.05, 0.2, 0.8, 1.5):
        px = bsm_price(100, 110, 0.5, 0.03, sigma, 0.01, kind)
        assert implied_vol(px, 100, 110, 0.5, 0.03, 0.01, kind) == pytest.approx(sigma, abs=1e-6)


def test_implied_vol_rejects_arbitrage_prices():
    assert np.isnan(implied_vol(0.0, 100, 100, 1, 0.05))          # zero premium
    assert np.isnan(implied_vol(150.0, 100, 100, 1, 0.05))        # call above spot


def test_implied_vol_vectorised_matches_scalar():
    K = np.array([90.0, 100.0, 110.0])
    px = bsm_price(100, K, 0.5, 0.03, 0.25, 0.0, "call")
    iv = implied_vol_vec(px, 100, K, 0.5, 0.03, 0.0, True)
    assert iv == pytest.approx(0.25, abs=1e-6)


def test_european_tree_converges_to_bsm():
    for kind in ("call", "put"):
        exact = bsm_price(**P, kind=kind)
        assert european_tree_price(**P, kind=kind, steps=2000) == pytest.approx(exact, abs=5e-3)
        e_small = abs(european_tree_price(**P, kind=kind, steps=50) - exact)
        e_large = abs(european_tree_price(**P, kind=kind, steps=1000) - exact)
        assert e_large < e_small


def test_american_call_no_dividend_equals_european():
    assert american_price(**P, kind="call", steps=800) == pytest.approx(european_tree_price(**P, kind="call", steps=800), abs=1e-9)


def test_american_put_premium_positive_and_reference_value():
    am = american_price(**P, kind="put", steps=2000)
    eu = european_tree_price(**P, kind="put", steps=2000)
    assert am > eu + 0.3
    assert am == pytest.approx(6.0896, abs=5e-3)  # widely-quoted value for this contract


def test_american_call_with_dividends_can_exceed_european():
    p = {**P, "q": 0.08}
    assert american_price(**p, kind="call", steps=800) > european_tree_price(**p, kind="call", steps=800) + 0.01


def test_american_put_zero_rate_no_early_exercise_edge():
    p = {**P, "r": 0.0}
    assert american_price(**p, kind="put", steps=500) == pytest.approx(european_tree_price(**p, kind="put", steps=500), abs=1e-9)


def test_deep_itm_put_is_intrinsic_deep_otm_zero():
    assert american_price(50, 100, 0.5, 0.05, 0.2, 0.0, "put", 500) == pytest.approx(50.0, abs=1e-9)
    assert bsm_price(100, 300, 0.25, 0.05, 0.2, 0.0, "call") < 1e-12


def test_premium_increases_with_vol():
    prices = [bsm_price(**{**P, "sigma": s}, kind="put") for s in (0.1, 0.2, 0.3, 0.4)]
    assert prices == sorted(prices)


def test_tree_greeks_close_to_bsm_for_european_like_case():
    g = bsm_greeks(**P, kind="call")
    ag = american_greeks(**P, kind="call", steps=800)  # q=0 call: American == European
    assert ag["delta"] == pytest.approx(g["delta"], abs=2e-3)
    assert ag["gamma"] == pytest.approx(g["gamma"], abs=5e-4)
    assert ag["vega"] == pytest.approx(g["vega"], abs=0.1)
    assert ag["theta"] == pytest.approx(g["theta"], abs=0.1)


def test_exercise_boundary_below_strike_for_put():
    res = binomial_tree(**P, kind="put", steps=400, american=True, want_boundary=True)
    b = res.boundary_S[np.isfinite(res.boundary_S)]
    assert len(b) > 0 and (b <= P["K"]).all()
    smooth = np.convolve(b, np.ones(2) / 2, mode="valid")  # lattice parity makes raw boundary saw-tooth
    assert smooth[-1] > smooth[0] and (np.diff(smooth) >= -0.5).all()  # rises toward the strike as expiry nears


def test_lsmc_close_to_tree_and_low_biased():
    tree = american_price(**P, kind="put", steps=1000)
    ls = lsmc_price(**P, kind="put", paths=100_000, steps=50)
    assert ls.price == pytest.approx(tree, abs=0.06)
    assert ls.price <= tree + 3 * ls.std_error


def test_sanity_check_suite_passes():
    assert all(c["passed"] for c in run_sanity_checks())


def test_surface_recovers_known_vol_function():
    spot = 25000.0
    surf = build_surface(synthetic_chain(spot=spot, noise=0.0, n_T=8), spot, 0.04)
    assert surf.iv.shape == (len(surf.T), len(surf.k))
    assert np.isfinite(surf.iv).all()
    # true model: base - 0.55 k e^{-1.5T} + 2.2 k^2 with base = 0.17 + 0.03 e^{-6T}
    T_mid, k_mid = surf.T[len(surf.T) // 2], -0.05
    j = int(np.argmin(np.abs(surf.k - k_mid)))
    truth = 0.17 + 0.03 * np.exp(-6 * T_mid) - 0.55 * surf.k[j] * np.exp(-1.5 * T_mid) + 2.2 * surf.k[j] ** 2
    assert surf.iv[len(surf.T) // 2, j] == pytest.approx(truth, abs=0.01)
    # skew: downside vol > upside vol
    assert surf.iv[:, 0].mean() > surf.iv[:, -1].mean()
    # no calendar arbitrage: total variance non-decreasing in T
    w = surf.iv**2 * surf.T[:, None]
    assert (np.diff(w, axis=0) >= -1e-9).all()
    # dividend yield recovered from put-call parity (true q = 1%)
    assert np.mean(list(surf.implied_q.values())) == pytest.approx(0.01, abs=0.002)
