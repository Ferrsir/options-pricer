"""Command line interface:  python -m pricer <command> --help"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from . import viz
from .binomial import american_greeks, binomial_tree, convergence_table
from .bsm import bsm_greeks, bsm_price, implied_vol, intrinsic
from .checks import run_sanity_checks
from .lsmc import lsmc_price


def _resolve_inputs(a):
    """Fill spot / rate / vol / dividend from Yahoo when --ticker is given (explicit flags always win)."""
    spot, rate, vol, div = a.spot, a.rate, a.vol, a.div
    label = a.ticker or "manual inputs"
    if a.ticker:
        from .data import get_quote

        qt = get_quote(a.ticker)
        label = f"{qt.ticker} {qt.name}".strip()
        spot = spot if spot is not None else qt.spot
        rate = rate if rate is not None else qt.rate
        div = div if div is not None else qt.div_yield
        vol = vol if vol is not None else qt.hist_vol_1y
        print(f"[yahoo] {label}: spot={qt.spot:.2f} r(13w T-bill)={qt.rate:.3%} q(trailing)={qt.div_yield:.2%} "
              f"30d hist vol={qt.hist_vol:.1%} 1y hist vol={qt.hist_vol_1y:.1%} (as of {qt.asof})")
    if spot is None or a.strike is None:
        sys.exit("error: need --spot and --strike (or --ticker and --strike)")
    T = a.years if a.years is not None else (a.days if a.days is not None else 365) / 365.0
    return dict(S=spot, K=a.strike, T=T, r=0.04 if rate is None else rate, sigma=0.25 if vol is None else vol,
                q=0.0 if div is None else div), label


def cmd_price(a):
    p, label = _resolve_inputs(a)
    S, K, T, r, sigma, q = p["S"], p["K"], p["T"], p["r"], p["sigma"], p["q"]
    kind = a.type
    if a.premium is not None:
        iv = implied_vol(a.premium, S, K, T, r, q, kind)
        print(f"Implied vol from premium {a.premium:.4f}: {iv:.4%}" if np.isfinite(iv) else "Premium violates no-arbitrage bounds")
        if np.isfinite(iv):
            sigma = iv

    bsm = bsm_price(S, K, T, r, sigma, q, kind)
    tree = binomial_tree(S, K, T, r, sigma, q, kind, a.steps, american=True, want_boundary=True)
    euro_tree = binomial_tree(S, K, T, r, sigma, q, kind, a.steps, american=False)
    g = bsm_greeks(S, K, T, r, sigma, q, kind)
    ag = american_greeks(S, K, T, r, sigma, q, kind, min(a.steps, 500))

    print(f"\n=== {kind.upper()}  S={S:g}  K={K:g}  T={T:.4f}y ({T * 365:.0f}d)  r={r:.3%}  σ={sigma:.2%}  q={q:.2%}  [{label}] ===")
    print(f"{'Intrinsic value':32s}{float(intrinsic(S, K, kind)):12.4f}")
    print(f"{'BSM (European, closed form)':32s}{bsm:12.4f}")
    print(f"{'European tree (' + str(a.steps) + ' steps)':32s}{euro_tree.price:12.4f}   (error vs BSM {euro_tree.price - bsm:+.5f})")
    print(f"{'American tree (' + str(a.steps) + ' steps)':32s}{tree.price:12.4f}   (early-exercise premium {tree.price - euro_tree.price:+.4f})")
    if a.lsmc:
        ls = lsmc_price(S, K, T, r, sigma, q, kind, paths=a.paths)
        print(f"{'American LSMC (' + str(ls.paths) + ' paths)':32s}{ls.price:12.4f}   (± {1.96 * ls.std_error:.4f} 95% CI; biased slightly low)")
    print(f"{'Time value (BSM - intrinsic)':32s}{bsm - float(intrinsic(S, K, kind)):12.4f}")
    be = K + bsm if kind == "call" else K - bsm
    print(f"{'Breakeven at expiry':32s}{be:12.4f}")

    print(f"\n{'Greek':8s}{'BSM (Euro)':>14s}{'American tree':>16s}   meaning")
    rows = [("delta", "$ per $1 move in spot; hedge ratio", 1), ("gamma", "change in delta per $1 move in spot", 1),
            ("vega", "$ per 1 vol point (÷100)", 0.01), ("theta", "$ per calendar day (÷365)", 1 / 365), ("rho", "$ per 1% rate move (÷100)", 0.01)]
    for name, desc, sc in rows:
        print(f"{name:8s}{g[name] * sc:14.4f}{ag[name] * sc:16.4f}   {desc}")

    if a.out:
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        viz.plot_greeks_vs_spot(K, T, r, sigma, q, kind, str(out / "greeks_vs_spot.png"))
        viz.plot_greeks_surface(K, r, sigma, q, kind, "gamma", str(out / "gamma_surface.png"))
        viz.plot_payoff(S, K, bsm, kind, "long", str(out / "payoff.png"), T, r, sigma, q)
        viz.plot_convergence(convergence_table(S, K, T, r, sigma, q, kind), str(out / "convergence.png"))
        if kind == "put" or q > 0:
            viz.plot_boundary(tree, K, kind, str(out / "exercise_boundary.png"))
        print(f"\nCharts written to {out.resolve()}")


def cmd_iv(a):
    S, K, T, r, q = a.spot, a.strike, (a.days / 365.0 if a.days else a.years), a.rate, a.div
    iv = implied_vol(a.premium, S, K, T, r, q, a.type)
    print(f"Implied volatility = {iv:.4%}" if np.isfinite(iv) else "No volatility reproduces this premium (arbitrage bounds violated)")


def cmd_checks(a):
    results = run_sanity_checks()
    for c in results:
        print(f"[{'PASS' if c['passed'] else 'FAIL'}] {c['name']:70s} {c['detail']}")
    sys.exit(0 if all(c["passed"] for c in results) else 1)


def cmd_surface(a):
    from .surface import build_surface, synthetic_chain

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if a.demo or not a.ticker:
        spot, rate, asof, label = 25000.0, 0.04, "demo data", "Synthetic Index"
        chain = synthetic_chain(spot, rate)
        print("Using synthetic demo chain (no network).")
    else:
        from .data import get_full_chain, get_quote, normalize_ticker

        qt = get_quote(a.ticker)
        spot, rate, asof = qt.spot, qt.rate, qt.asof
        label = a.title or f"{qt.name or qt.ticker} ({normalize_ticker(a.ticker).lstrip('^')})"
        print(f"Downloading option chains for {qt.ticker} (spot {spot:,.2f}, r={rate:.2%}) ...")
        chain = get_full_chain(a.ticker, a.min_days, a.max_days, a.max_expiries)
        print(f"  {len(chain)} quotes across {chain['T'].nunique()} expiries")
    surf = build_surface(chain, spot, rate, asof, label, k_range=(a.kmin, a.kmax))
    print(f"  implied dividend yields by expiry: {', '.join(f'{v:.2%}' for v in surf.implied_q.values())}")
    print(f"  IV range on grid: {surf.iv.min():.1%} - {surf.iv.max():.1%}")
    viz.plot_surface(surf, str(out), title=a.title or f"{label} Implied Volatility Surface")
    print(f"Saved {out.resolve()}")
    if a.csv:
        surf.points.to_csv(a.csv, index=False)
        print(f"Saved conditioned quotes to {a.csv}")


def cmd_serve(a):
    from .server import serve

    serve(a.port)


def build_parser():
    ap = argparse.ArgumentParser(prog="pricer", description="Options premium pricer (BSM, American tree, LSMC, Greeks, IV surface)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--ticker", help="Yahoo Finance ticker (fills spot, rate, dividend yield, historical vol)")
        p.add_argument("--spot", type=float)
        p.add_argument("--strike", type=float)
        p.add_argument("--days", type=float, help="days to expiry")
        p.add_argument("--years", type=float, help="years to expiry")
        p.add_argument("--rate", type=float, help="risk-free rate, e.g. 0.045")
        p.add_argument("--vol", type=float, help="volatility, e.g. 0.25")
        p.add_argument("--div", type=float, help="continuous dividend yield, e.g. 0.01")
        p.add_argument("--type", choices=["call", "put"], default="call")

    p = sub.add_parser("price", help="price an option (BSM + American tree [+ LSMC]) and show Greeks")
    common(p)
    p.add_argument("--premium", type=float, help="observed market premium -> solve implied vol and price with it")
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--lsmc", action="store_true", help="also run Longstaff-Schwartz Monte Carlo")
    p.add_argument("--paths", type=int, default=100_000)
    p.add_argument("--out", help="directory to write charts into")
    p.set_defaults(func=cmd_price)

    p = sub.add_parser("iv", help="implied volatility from a market premium")
    p.add_argument("--premium", type=float, required=True)
    p.add_argument("--spot", type=float, required=True)
    p.add_argument("--strike", type=float, required=True)
    p.add_argument("--days", type=float)
    p.add_argument("--years", type=float, default=1.0)
    p.add_argument("--rate", type=float, default=0.04)
    p.add_argument("--div", type=float, default=0.0)
    p.add_argument("--type", choices=["call", "put"], default="call")
    p.set_defaults(func=cmd_iv)

    p = sub.add_parser("checks", help="run the HW sanity checks")
    p.set_defaults(func=cmd_checks)

    p = sub.add_parser("surface", help="build an implied-vol surface picture from Yahoo option chains")
    p.add_argument("ticker", nargs="?", help="e.g. NDX, SPY, AAPL (omit or use --demo for synthetic data)")
    p.add_argument("--demo", action="store_true")
    p.add_argument("--out", default="output/iv_surface.png")
    p.add_argument("--title")
    p.add_argument("--csv", help="also save the conditioned (T, k, iv) points")
    p.add_argument("--min-days", type=float, default=14, dest="min_days")
    p.add_argument("--max-days", type=float, default=160, dest="max_days")
    p.add_argument("--max-expiries", type=int, default=14, dest="max_expiries")
    p.add_argument("--kmin", type=float, default=-0.15)
    p.add_argument("--kmax", type=float, default=0.10)
    p.set_defaults(func=cmd_surface)

    p = sub.add_parser("serve", help="run the web app locally with live Yahoo Finance data")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)
    return ap


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252; we print σ, ≥, etc.
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
