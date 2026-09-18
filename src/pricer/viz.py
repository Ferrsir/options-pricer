"""Plots: implied-vol surface, Greeks, payoff, tree convergence, early-exercise boundary."""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.ticker import FuncFormatter

from .bsm import bsm_greeks, bsm_price, intrinsic

BG = "#0a0a0a"
FG = "#e8e8e8"
GRID = "#3a3a3a"
IV_CMAP = LinearSegmentedColormap.from_list(
    "ivmap", ["#0b1f5c", "#1b4f9c", "#1a8a9c", "#3fae78", "#a9cf3f", "#f3c334", "#f59b2a"]
)


def _dark(fig, *axes):
    fig.patch.set_facecolor(BG)
    for ax in axes:
        ax.set_facecolor(BG)
        ax.tick_params(colors=FG)
        for lab in (ax.xaxis.label, ax.yaxis.label, ax.title):
            lab.set_color(FG)
        for s in ax.spines.values():
            s.set_color(GRID)
        ax.grid(color=GRID, alpha=0.5, lw=0.5)


def plot_surface(surface, path="iv_surface.png", title=None, subtitle=None, vmin=None, vmax=None, elev=27, azim=-57, dpi=170):
    """3-D implied vol surface in the style of the reference picture (dark, log-moneyness x maturity)."""
    K, TT = np.meshgrid(surface.k, surface.T)
    Z = surface.iv * 100.0
    vmin = vmin if vmin is not None else np.floor(np.nanmin(Z) / 5) * 5
    vmax = vmax if vmax is not None else np.ceil(np.nanmax(Z) / 5) * 5

    fig = plt.figure(figsize=(11, 9.5))
    ax = fig.add_subplot(111, projection="3d")
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    norm = matplotlib.colors.Normalize(vmin=vmin, vmax=vmax)
    surf = ax.plot_surface(K, TT, Z, facecolors=IV_CMAP(norm(Z)), rstride=1, cstride=1, linewidth=0.15,
                           edgecolor=(0, 0, 0, 0.25), antialiased=True, shade=False)
    # ATM line (k = 0) running along the maturity axis
    j0 = int(np.argmin(np.abs(surface.k)))
    ax.plot(np.zeros_like(surface.T), surface.T, Z[:, j0] + (vmax - vmin) * 0.004, color="#e5484d", lw=1.8, ls="--", zorder=10)

    ax.set_xlabel("Log-Moneyness  ln(K/S)", color=FG, labelpad=14)
    ax.set_ylabel("Time to Expiry (Years)", color=FG, labelpad=14)
    ax.set_zlabel("Implied Volatility (%)", color=FG, labelpad=10)
    ax.set_zlim(vmin, vmax)
    ax.zaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}%"))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:+.2f}" if abs(v) > 1e-9 else "0.00"))
    ax.tick_params(colors=FG, labelsize=9)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.set_pane_color((0.04, 0.04, 0.04, 1.0))
        axis._axinfo["grid"]["color"] = (0.3, 0.3, 0.3, 0.6)
        axis._axinfo["grid"]["linewidth"] = 0.5
    ax.view_init(elev=elev, azim=azim)
    ax.set_box_aspect((1.25, 1.0, 0.75), zoom=1.02)
    ax.zaxis.set_major_locator(matplotlib.ticker.MultipleLocator(5))

    sm = matplotlib.cm.ScalarMappable(norm=norm, cmap=IV_CMAP)
    fig.subplots_adjust(left=0.0, right=0.80, top=0.93, bottom=0.10)
    cax = fig.add_axes([0.91, 0.30, 0.022, 0.40])
    cb = fig.colorbar(sm, cax=cax)
    cb.set_label("Implied Volatility", color=FG)
    cb.ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}%"))
    cb.ax.tick_params(colors=FG)
    cb.outline.set_edgecolor(GRID)

    title = title or f"{surface.label or 'Underlying'} Implied Volatility Surface"
    subtitle = subtitle or f"Spot: ${surface.spot:,.2f}  ·  {surface.asof}  ·  PCHIP Interpolation"
    fig.text(0.40, 0.965, title, ha="center", color=FG, fontsize=15)
    fig.text(0.40, 0.93, subtitle, ha="center", color=FG, fontsize=14)
    fig.text(0.45, 0.03,
             "Methodology: Log-moneyness transform  ·  Savitzky-Golay conditioning  ·  Two-stage PCHIP interpolation (strike × time)",
             ha="center", color="#8a8a8a", fontsize=8.5)
    fig.savefig(path, dpi=dpi, facecolor=BG, bbox_inches="tight", pad_inches=0.3)
    plt.close(fig)
    return path


def plot_greeks_vs_spot(K, T, r, sigma, q=0.0, kind="call", path="greeks_vs_spot.png", dpi=150):
    """Delta, gamma, vega, theta, rho (and vanna) as spot moves, for several maturities."""
    S = np.linspace(0.6 * K, 1.4 * K, 300)
    names = [("delta", "Delta"), ("gamma", "Gamma"), ("vega", "Vega (per 1 vol pt)"),
             ("theta", "Theta (per day)"), ("rho", "Rho (per 1% rate)"), ("price", "Premium")]
    scale = dict(vega=0.01, theta=1 / 365.0, rho=0.01)
    Ts = [max(T * f, 1 / 365) for f in (0.1, 0.25, 0.5, 1.0)]
    cols = ["#f59b2a", "#a9cf3f", "#3fae78", "#4aa3df"]
    fig, axes = plt.subplots(2, 3, figsize=(15, 8))
    _dark(fig, *axes.ravel())
    for ax, (key, label) in zip(axes.ravel(), names):
        for Ti, c in zip(Ts, cols):
            if key == "price":
                y = bsm_price(S, K, Ti, r, sigma, q, kind)
            else:
                y = bsm_greeks(S, K, Ti, r, sigma, q, kind)[key] * scale.get(key, 1.0)
            ax.plot(S, y, color=c, lw=1.8, label=f"T = {Ti * 365:.0f}d")
        ax.axvline(K, color="#e5484d", ls="--", lw=1, alpha=0.8)
        ax.set_title(label)
        ax.set_xlabel("Spot")
    axes[0, 0].legend(facecolor=BG, edgecolor=GRID, labelcolor=FG, fontsize=9)
    fig.suptitle(f"{kind.title()} Greeks vs Spot   (K={K:g}, r={r:.1%}, σ={sigma:.1%}, q={q:.1%})", color=FG, fontsize=14)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(path, dpi=dpi, facecolor=BG)
    plt.close(fig)
    return path


def plot_greeks_surface(K, r, sigma, q=0.0, kind="call", greek="gamma", path="greek_surface.png", dpi=150):
    """3-D surface of one Greek over (spot, time to expiry) - shows e.g. how gamma explodes near expiry ATM."""
    S = np.linspace(0.7 * K, 1.3 * K, 80)
    T = np.linspace(0.02, 1.0, 60)
    SS, TT = np.meshgrid(S, T)
    Z = bsm_greeks(SS, K, TT, r, sigma, q, kind)[greek]
    fig = plt.figure(figsize=(9, 7))
    ax = fig.add_subplot(111, projection="3d")
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    ax.plot_surface(SS, TT, Z, cmap=IV_CMAP, linewidth=0.1, edgecolor=(0, 0, 0, 0.2), antialiased=True)
    ax.set_xlabel("Spot", color=FG)
    ax.set_ylabel("Time to expiry (y)", color=FG)
    ax.set_zlabel(greek.title(), color=FG)
    ax.tick_params(colors=FG)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.set_pane_color((0.04, 0.04, 0.04, 1.0))
    ax.view_init(elev=25, azim=-58)
    ax.set_title(f"{kind.title()} {greek.title()} surface", color=FG)
    fig.savefig(path, dpi=dpi, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    return path


def plot_payoff(S0, K, premium, kind="call", side="long", path="payoff.png", T=None, r=0.0, sigma=None, q=0.0, dpi=150):
    """Expiry P&L (and optionally today's BSM value curve) for a long or short option."""
    S = np.linspace(0.6 * K, 1.4 * K, 400)
    sgn = 1 if side == "long" else -1
    pnl = sgn * (intrinsic(S, K, kind) - premium)
    fig, ax = plt.subplots(figsize=(8, 5))
    _dark(fig, ax)
    ax.plot(S, pnl, color="#f59b2a", lw=2, label="P&L at expiry")
    if T and sigma:
        ax.plot(S, sgn * (bsm_price(S, K, T, r, sigma, q, kind) - premium), color="#4aa3df", lw=1.8, label="P&L today (BSM)")
    ax.axhline(0, color=GRID)
    ax.axvline(S0, color="#e5484d", ls="--", lw=1, label=f"Spot {S0:g}")
    be = K + premium if kind == "call" else K - premium
    ax.axvline(be, color="#3fae78", ls=":", lw=1.2, label=f"Breakeven {be:.2f}")
    ax.set_xlabel("Underlying at expiry")
    ax.set_ylabel("Profit / loss per share")
    ax.set_title(f"{side.title()} {kind} K={K:g}, premium {premium:.2f}")
    ax.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG)
    fig.savefig(path, dpi=dpi, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    return path


def plot_convergence(rows, path="convergence.png", dpi=150):
    fig, (a, b) = plt.subplots(1, 2, figsize=(12, 4.5))
    _dark(fig, a, b)
    n = [r["steps"] for r in rows]
    a.plot(n, [r["european_tree"] for r in rows], "o-", color="#4aa3df", label="European tree")
    a.plot(n, [r["american_tree"] for r in rows], "s-", color="#f59b2a", label="American tree")
    a.axhline(rows[0]["bsm"], color="#3fae78", ls="--", label="BSM closed form")
    a.set_xscale("log")
    a.set_xlabel("Tree steps")
    a.set_ylabel("Premium")
    a.set_title("Tree converges to Black-Scholes-Merton")
    a.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG)
    b.loglog(n, np.abs([r["error"] for r in rows]) + 1e-12, "o-", color="#a9cf3f")
    b.set_xlabel("Tree steps")
    b.set_ylabel("|tree - BSM|")
    b.set_title("Error shrinks ~ 1/steps (saw-tooth from strike/lattice alignment)")
    fig.savefig(path, dpi=dpi, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    return path


def smooth_boundary(t, S):
    """The lattice only has discrete spot levels, so the raw boundary is a staircase; a moving average
    over ~4% of the time axis recovers the smooth curve the staircase approximates."""
    from scipy.ndimage import uniform_filter1d

    ok = np.isfinite(S)
    t, S = np.asarray(t)[ok], np.asarray(S)[ok]
    if len(S) < 8:
        return t, S
    return t, uniform_filter1d(S, size=max(3, len(S) // 25), mode="nearest")


def plot_boundary(res, K, kind="put", path="exercise_boundary.png", dpi=150):
    """Early-exercise boundary from the tree: exercise when the spot is on the 'inside' of this curve."""
    fig, ax = plt.subplots(figsize=(8, 5))
    _dark(fig, ax)
    bt, bS = smooth_boundary(res.boundary_t, res.boundary_S)
    ax.plot(bt, bS, color="#f59b2a", lw=2)
    ax.axhline(K, color=GRID, ls="--")
    ax.set_xlabel("Time (years from today)")
    ax.set_ylabel("Critical spot")
    side = "at or below" if kind == "put" else "at or above"
    ax.set_title(f"American {kind}: exercise immediately when spot is {side} the curve")
    ax.fill_between(bt, bS, ax.get_ylim()[0] if kind == "put" else ax.get_ylim()[1],
                    color="#e5484d", alpha=0.12, label="exercise region")
    ax.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG)
    fig.savefig(path, dpi=dpi, facecolor=BG, bbox_inches="tight")
    plt.close(fig)
    return path
