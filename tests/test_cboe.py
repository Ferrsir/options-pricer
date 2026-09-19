"""Any-ticker data layer: offline tests (no network). The synthetic chain is priced with our own Black-Scholes, so
recovering the dividend yield and the volatility surface from it is a real end-to-end check of the pipeline."""
import datetime as dt
import json
import math
from pathlib import Path

import numpy as np
import pytest

from pricer import cboe
from pricer.bsm import bsm_price

ROOT = Path(__file__).resolve().parents[1]
S0, R, Q, SIGMA = 100.0, 0.04, 0.02, 0.25


def _occ(root, expiry, cp, strike):
    return f"{root}{expiry.strftime('%y%m%d')}{cp}{int(round(strike * 1000)):08d}"


def fake_raw(days=(20, 45, 75, 100, 130), root="TEST", spread=0.02, dup=False):
    """A Cboe-shaped payload with BSM-priced quotes (flat 25% vol, 2% dividend yield)."""
    today = dt.date.today()
    opts = []
    for d in days:
        exp = today + dt.timedelta(days=d)
        T = cboe.year_fraction(exp.isoformat())
        for K in np.arange(70, 131, 2.5):
            for cp, kind in (("C", "call"), ("P", "put")):
                mid = bsm_price(S0, K, T, R, SIGMA, Q, kind)
                if mid < 0.05:
                    continue
                for r_ in ([root, root + "W"] if dup and cp == "C" else [root]):
                    w = spread if r_ == root else spread * 3  # the second root is wider: dedupe must keep the tight one
                    opts.append({"option": _occ(r_, exp, cp, K), "bid": mid * (1 - w), "ask": mid * (1 + w), "iv": 0.25,
                                 "last_trade_price": mid, "volume": 10, "open_interest": 100})
    return {"timestamp": today.isoformat(), "data": {"current_price": S0, "iv30": 25.0, "last_trade_time": today.isoformat() + "T15:59:59", "options": opts}}


@pytest.fixture
def patched(monkeypatch):
    def install(raw):
        monkeypatch.setattr(cboe, "fetch", lambda t, timeout=25.0: (t.upper(), raw))
        monkeypatch.setattr(cboe, "risk_free_rate", lambda: R)
    return install


def test_ticker_normalisation():
    assert cboe.candidates("aapl") == ["AAPL", "_AAPL"]
    assert cboe.candidates("^SPX")[0] == "_SPX"
    assert cboe.candidates("brk-b")[0] == "BRK.B"
    assert cboe.candidates("NDX")[0] == "_NDX"
    for bad in ["", "   ", "bad ticker!", "A" * 20, "AAPL;DROP"]:
        with pytest.raises(ValueError):
            cboe.candidates(bad)


def test_occ_symbols_are_parsed():
    rows = cboe.parse_options({"data": {"options": [
        {"option": "AAPL261016C00337500", "bid": 1.0, "ask": 1.2},
        {"option": "BRK.B270115P00450000", "bid": 3.0, "ask": 3.4},
        {"option": "garbage", "bid": 1, "ask": 2},
    ]}})
    assert len(rows) == 2
    assert (rows[0]["expiry"], rows[0]["type"], rows[0]["strike"]) == ("2026-10-16", "call", 337.5)
    assert (rows[1]["expiry"], rows[1]["type"], rows[1]["strike"]) == ("2027-01-15", "put", 450.0)


def test_dividend_yield_recovered_from_put_call_parity():
    rows = cboe.parse_options(fake_raw(days=(60,)))
    T = cboe.year_fraction(rows[0]["expiry"])
    assert cboe.implied_carry(rows, S0, R, T) == pytest.approx(Q, abs=2e-3)


def test_quote_payload(patched):
    patched(fake_raw())
    q = cboe.quote("TEST")
    assert q["spot"] == S0 and q["iv30"] == pytest.approx(0.25) and q["source"] == "cboe"
    assert q["div_yield"] == pytest.approx(Q, abs=3e-3)
    assert len(q["expiries"]) == 5 and q["expiries"] == sorted(q["expiries"])


def test_chains_are_compact_thinned_and_deduped(patched):
    patched(fake_raw(days=tuple(range(15, 200, 8)), dup=True))
    payload = cboe.chains("TEST", 14, 160, 6)
    assert len(payload["expiries"]) <= 6 and payload["expiries"][0]["T"] < payload["expiries"][-1]["T"]
    for e in payload["expiries"]:
        keys = [(t, k) for t, k, _, _ in e["rows"]]
        assert len(keys) == len(set(keys)), "duplicate (type, strike) rows survived"
        assert all(b > 0 and a > b for _, _, b, a in e["rows"])
    assert len(json.dumps(payload)) < 60_000  # small enough for a serverless response


def test_chain_single_expiry_and_errors(patched):
    raw = fake_raw()
    patched(raw)
    exp = cboe.quote("TEST")["expiries"][1]
    ch = cboe.chain("TEST", exp)
    assert ch["expiry"] == exp and ch["T"] > 0 and {"type", "strike", "bid", "ask", "impliedVolatility"} <= set(ch["rows"][0])
    with pytest.raises(ValueError):
        cboe.chain("TEST", "not-a-date")
    with pytest.raises(ValueError):
        cboe.chain("TEST", "2001-01-01")
    with pytest.raises(ValueError):
        cboe.dispatch("nope", {})


def test_surface_built_from_cboe_style_chains_recovers_flat_vol(patched):
    """End to end: chains payload -> DataFrame -> the same surface pipeline used for Yahoo data. The synthetic vol is flat 25%."""
    from pricer import data as d
    from pricer.surface import build_surface

    patched(fake_raw(days=(20, 45, 75, 100, 130, 160)))
    df = d._full_chain_from_cboe("TEST", 14, 200, 8)
    s = build_surface(df, S0, R, "test", "TEST")
    assert np.isfinite(s.iv).all()
    assert s.iv.mean() == pytest.approx(SIGMA, abs=0.01)
    assert np.mean(list(s.implied_q.values())) == pytest.approx(Q, abs=4e-3)


def test_serverless_copy_is_in_sync_with_the_source_module():
    assert (ROOT / "serverless/lib/cboe.py").read_text(encoding="utf-8") == (ROOT / "src/pricer/cboe.py").read_text(encoding="utf-8"), \
        "run `python scripts/build_serverless.py` after editing src/pricer/cboe.py"


def test_year_fraction_is_ordered_and_nonnegative():
    a = cboe.year_fraction((dt.date.today() + dt.timedelta(days=30)).isoformat())
    b = cboe.year_fraction((dt.date.today() + dt.timedelta(days=60)).isoformat())
    assert 0 < a < b and math.isclose(b - a, 30 / 365, rel_tol=0.05)
    assert cboe.year_fraction("2001-01-01") == 0.0
