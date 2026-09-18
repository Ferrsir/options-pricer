"""Capture real Yahoo Finance data so the hosted (static) site works without a live API.

    python scripts/snapshot.py                 # default tickers
    python scripts/snapshot.py NDX AAPL TSLA   # custom tickers

Writes docs/data/snapshots.json (quote + implied-vol surface per ticker) and docs/assets/ndx_surface.png.
"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pricer import viz  # noqa: E402
from pricer.data import get_full_chain, get_quote, normalize_ticker  # noqa: E402
from pricer.surface import build_surface, synthetic_chain  # noqa: E402

DEFAULT = ["NDX", "SPX", "SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META"]


def surface_json(surf):
    d = surf.to_json()
    d["implied_q"] = {f"{k:.4f}": v for k, v in surf.implied_q.items()}
    return d


def main(tickers):
    out = {}
    for t in tickers:
        sym = t.upper().lstrip("^")
        try:
            qt = get_quote(t)
            chain = get_full_chain(t, 14, 160, 14)
            label = qt.name or qt.ticker
            surf = build_surface(chain, qt.spot, qt.rate, qt.asof, label)
            out[sym] = {"quote": asdict(qt), "surface": surface_json(surf)}
            print(f"ok   {sym:6s} spot={qt.spot:>10,.2f}  iv range {surf.iv.min():.1%}-{surf.iv.max():.1%}")
            if sym == "NDX":
                viz.plot_surface(surf, str(ROOT / "docs/assets/ndx_surface.png"),
                                 title="NASDAQ-100 Index (NDX) Implied Volatility Surface", dpi=150)
        except Exception as e:  # keep going: some tickers have thin or missing option chains
            print(f"skip {sym:6s} {type(e).__name__}: {e}")
    demo = build_surface(synthetic_chain(), 25000.0, 0.04, "demo data", "Synthetic demo")
    out["DEMO"] = {"quote": dict(ticker="DEMO", spot=25000.0, rate=0.04, div_yield=0.01, hist_vol=0.18, hist_vol_1y=0.2,
                                 asof="demo data", name="Synthetic demo index"), "surface": surface_json(demo)}
    dest = ROOT / "docs/data/snapshots.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB, {len(out)} entries)")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT)
