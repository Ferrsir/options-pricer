# AGENTS.md: shared notes for AI agents (Claude Code, Codex) and humans

This file is the **shared channel** between the agents working on this repo. Read it before you change anything; append to the [handoff log](#handoff-log) before you stop. Codex reads `AGENTS.md` natively; Claude Code reads it through `CLAUDE.md`, which imports this file. There is one source of truth, so do not copy its contents elsewhere.

## What this project is

An **options premium pricer** for Traders@SMU HW 1: Black-Scholes-Merton, an American binomial tree, Longstaff-Schwartz Monte Carlo (LSMC), Greeks, implied vol, vol surfaces. It ships as a Python package (`src/pricer`), a CLI (`python -m pricer`), and a static website (`docs/`, served by GitHub Pages at https://ferrsir.github.io/options-pricer/).

**The owner must be able to explain every line to their class.** Prefer clear, commented, explainable code over clever code. `METHODOLOGY.md` (derivations) and `GUIDE.md` (plain-English guide) exist for that reason; keep them true when behaviour changes.

## Commands

```bash
pip install -e ".[dev]"            # install (numpy, scipy, matplotlib, pandas, yfinance, pytest, markdown)
python -m pytest -q                # 22 tests, must stay green
python -m pricer checks            # the slide's sanity checks
python -m pricer serve             # site + live Yahoo API at http://localhost:8000
python -m pricer surface NDX --out output/ndx_surface.png
python scripts/snapshot.py         # refresh docs/data/snapshots.json from real Yahoo data
python scripts/build_guide.py      # regenerate docs/guide.html from GUIDE.md
```

Pushing to `main` deploys the site (GitHub Pages, source = `main` / `docs`). A build takes about a minute: `gh api repos/Ferrsir/options-pricer/pages/builds/latest --jq .status`.

## Map

| Path | What it is |
|---|---|
| `src/pricer/bsm.py` | BSM price, Greeks, implied vol (scalar and vectorised) |
| `src/pricer/binomial.py` | CRR tree, American exercise, tree Greeks, exercise boundary, American implied vol |
| `src/pricer/lsmc.py` | Longstaff-Schwartz Monte Carlo |
| `src/pricer/surface.py` | IV surface: log-moneyness, Savitzky-Golay, two-stage PCHIP |
| `src/pricer/data.py`, `server.py` | Yahoo Finance access; local API used by the site |
| `src/pricer/viz.py`, `cli.py`, `checks.py` | Plots, CLI, slide sanity checks |
| `docs/js/pricing.js` | **JavaScript re-implementation of the Python engine** (same numbers) |
| `docs/js/app.js`, `data.js`, `index.html`, `style.css` | The site UI and data layer |
| `docs/data/snapshots.json` | Real Yahoo snapshots so the hosted site works without an API |
| `tests/test_pricer.py` | All tests |

## Rules that are easy to break

1. **Two engines must agree.** `docs/js/pricing.js` mirrors `src/pricer/{bsm,binomial,lsmc}.py`. Change one, change the other, then compare numbers (reference case: S=K=100, T=1, r=5%, σ=20%, q=0 → call 10.450583572, put 5.573526022, American put with 1000 steps 6.089595283). There is no Node here; check JS in a browser console via `window.__pricer.P` on a page served by `python -m pricer serve`.
2. **Bump the cache-bust version** (`?v=N`) in `docs/index.html`, `docs/js/app.js` (imports and the `guide.html` fetch) and `docs/js/data.js` whenever you change anything under `docs/`. GitHub Pages caches for 10 minutes; without the bump visitors get a half-stale site. Current value: `v=4`.
3. **`GUIDE.md` is the source of `docs/guide.html`.** Edit `GUIDE.md`, then run `python scripts/build_guide.py` and commit both. Do not hand-edit `docs/guide.html`.
4. **`docs/data/snapshots.json` is generated** from real market data by `scripts/snapshot.py`. Never hand-edit or fabricate values. Quote figures in `GUIDE.md` that come from the reference case should be recomputed, not guessed.
5. **Tree validity.** The CRR tree needs `d < e^{(r-q)dt} < u`, i.e. `σ > |r-q|·√dt`. Any code that searches over σ (implied vol) must start above that bound or catch the error. See `american_implied_vol` (Python) and `americanImpliedVol` (JS).
6. **Yahoo has no CORS.** A static page cannot call it; the site uses a local API (`python -m pricer serve`) or the bundled snapshots. Do not add a public CORS proxy (they are unreliable and dead as of 2026-09).
7. **Git identity.** Commit with the GitHub `users.noreply.github.com` address, never a personal email. Repo is public.
8. **UI design system (glass).** Tokens live at the top of `docs/style.css` (`--glass`, `--ink*`, `--accent`, radii). New surfaces reuse `.glass`; do not invent new colours or blur values. Text must stay at 4.5:1 or better on glass, `prefers-reduced-motion` and `prefers-reduced-transparency` must keep working, and every interactive element needs a visible focus ring. Icons are the inline SVG sprite at the top of `index.html` (no emoji). Numbers use the mono font. Plotly charts take colours from the `GRID`/`ZERO`/`TXT`/`COLORS` constants and `baseLayout()` in `app.js`; **3-D (WebGL) scenes ignore alpha, so use solid hex colours there**. Every element ID in `index.html` is referenced from `app.js`; rename one and you must rename both. Inputs that carry an info tooltip use `<label for=...>` beside the `.tip` button (a button *inside* a label steals the label's association).
9. **Explainability over cleverness.** No new dependency or framework without a reason the owner can defend in class.
10. **Do not overstate.** Numbers in docs and UI text must come from running the code. Say what was and was not verified.

## Definition of done

- `python -m pytest -q` passes; new behaviour has a test.
- JS and Python agree on any changed formula (rule 1).
- `GUIDE.md` → `docs/guide.html` rebuilt if `GUIDE.md` changed; cache-bust bumped if `docs/` changed.
- Pushed to `main`, Pages build is `built`, and the live page was loaded and exercised (not only the local copy).
- A handoff entry is appended below.

## Known limitations and open items

- Hosted site cannot fetch live tickers or option chains. Only 11 snapshot tickers plus `DEMO`. Fix option (not done): a small serverless `/api` (e.g. Vercel) mirroring `server.py`'s `/api/quote`, `/api/chain`, `/api/surface`.
- The *Premium impact* sweep curves use Black-Scholes even when American is selected; the comparison table uses the tree.
- Vol surface: equity options are American but we invert the European formula on OTM quotes; butterfly arbitrage is only approximately removed (a desk would fit SVI). Documented in `METHODOLOGY.md` §7.
- Screenshots for visual checks: the in-app preview pane is tiny; use headless Edge instead: `msedge --headless=new --enable-unsafe-swiftshader --window-size=1440,1900 --virtual-time-budget=14000 --screenshot=out.png URL` (the first invocation of a session sometimes writes a 0-byte file; run it once more).
- No CI workflow (the GitHub token used so far lacked `workflow` scope).

## Handoff log

Append-only, **newest first**. Format is fixed so either agent can scan it.

**Rules**

- One entry per work session. Start it with `### YYYY-MM-DD · <agent> → <agent or "anyone">`, using absolute dates.
- Keep it under about 15 lines: what you did, what you verified, what you need, open questions.
- Never edit or delete another agent's entry. Reply beneath it with your own entry and, if resolved, add `✅ resolved in <date> entry` to the original line.
- No secrets, tokens or personal data. State uncertainty plainly.
- If you disagree with a rule or a decision here, say so in an entry instead of silently working around it.

**Entry template**

```
### YYYY-MM-DD · <agent> → <agent or anyone>
Done: ...
Verified: ... (say how; say what was NOT verified)
Needs from you: ...
Open questions: ...
```

### 2026-09-18 · Claude → Codex (UI redesign)
Done: Redesigned the site as a glassmorphism UI (frosted panels over a navy mesh, IBM Plex Sans/Mono, amber accent, SVG icons). New UX: start-here card with one-click examples, contract summary chips + Copy-link (inputs restored from the URL), unit-suffixed inputs with info tooltips, collapsible input sections, keyboard-navigable ARIA tabs (arrow keys, Home/End), sticky tab bar, mobile Inputs/Results bar, toast, chart theming (Plotly matches the glass), skeleton shimmer, Open Graph/canonical tags. No pricing logic was touched. Cache-bust is now `v=4`.
Verified: 22 tests still pass; page exercised in a browser; full-width (1440), and phone-width renders inspected with headless Edge. NOT verified: real touch devices, VoiceOver/NVDA, Safari/Firefox rendering of `backdrop-filter`, Lighthouse scores.
Needs from you (optional): run an accessibility audit (axe/Lighthouse) on `docs/index.html`; check contrast of `--ink-3` text over the brightest part of the background; try Firefox and Safari.
Open questions: none.

### 2026-09-18 · Claude → Codex
Done: Built the whole project from an empty folder (engines, CLI, tests, site, guide) and published it. Added premium what-if tools: *Your premium* box, the *Premium impact* tab (model σ vs market-implied σ, sweep curves), the *What-if* tab (P&L, Greek waterfall, heat map) and the plain-English *Guide* tab. Fixed the American implied-vol crash at very low σ (regression test added). Added this file.
Verified: 22 tests pass; JS engine matches Python (reference call/put/tree/Greeks agree to ~1e-12); live site exercised in a browser (tabs, premium flow, snapshot mode) with no console errors; Pages build `built`. NOT verified: a full-width desktop screenshot of the new tabs (the preview pane was tiny), mobile layout beyond one screenshot, keyboard/screen-reader accessibility.
Needs from you (all optional, none started): an independent review of `docs/js/pricing.js` against `src/pricer/*.py` for parity edge cases (very short expiry, large q, deep ITM/OTM); an accessibility pass on `docs/index.html` (labels, focus order, contrast); Open Graph / share-preview metadata for the Pages site.
Open questions: Should the hosted site get a live-data API? It needs the owner to approve a deploy to another platform, so ask them first.
