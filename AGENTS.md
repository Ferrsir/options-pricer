# AGENTS.md: shared notes for AI agents (Claude Code, Codex) and humans

This file is the **shared channel** between the agents working on this repo. Read it before you change anything; append to the [handoff log](#handoff-log) before you stop. Codex reads `AGENTS.md` natively; Claude Code reads it through `CLAUDE.md`, which imports this file. There is one source of truth, so do not copy its contents elsewhere.

## What this project is

An **options premium pricer** for Traders@SMU HW 1: Black-Scholes-Merton, an American binomial tree, Longstaff-Schwartz Monte Carlo (LSMC), Greeks, implied vol, vol surfaces. It ships as a Python package (`src/pricer`), a CLI (`python -m pricer`), and a static website (`docs/`, served by GitHub Pages at https://ferrsir.github.io/options-pricer/).

**The owner must be able to explain every line to their class.** Prefer clear, commented, explainable code over clever code. `METHODOLOGY.md` (derivations) and `GUIDE.md` (plain-English guide) exist for that reason; keep them true when behaviour changes.

## Commands

```bash
pip install -e ".[dev]"            # install (numpy, scipy, matplotlib, pandas, yfinance, pytest, markdown)
python -m pytest -q                # 31 tests, must stay green
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
| `src/pricer/data.py`, `server.py` | Yahoo Finance access (Cboe fallback); local API used by the site |
| `src/pricer/cboe.py` (+ copy in `serverless/lib/`) | **Any-ticker data**: Cboe public delayed chains, stdlib only; also the serverless API handlers |
| `serverless/` | Deployable API for the hosted site (`api/*.py`); refresh its copy with `python scripts/build_serverless.py` |
| `docs/js/surface.js` | JS port of `surface.py` (smoothing + PCHIP); parity-tested against Python |
| `src/pricer/viz.py`, `cli.py`, `checks.py` | Plots, CLI, slide sanity checks |
| `docs/js/pricing.js` | **JavaScript re-implementation of the Python engine** (same numbers) |
| `docs/js/app.js`, `data.js`, `index.html`, `style.css` | The site UI and data layer |
| `docs/data/snapshots.json` | Real Yahoo snapshots so the hosted site works without an API |
| `tests/test_pricer.py` | All tests |

## Rules that are easy to break

1. **Two engines must agree.** `docs/js/pricing.js` mirrors `src/pricer/{bsm,binomial,lsmc}.py`. Change one, change the other, then compare numbers (reference case: S=K=100, T=1, r=5%, σ=20%, q=0 → call 10.450583572, put 5.573526022, American put with 1000 steps 6.089595283). There is no Node here; check JS in a browser console via `window.__pricer.P` on a page served by `python -m pricer serve`.
2. **Bump the cache-bust version** (`?v=N`) in `docs/index.html`, `docs/js/app.js` (imports and the `guide.html` fetch) and `docs/js/data.js` whenever you change anything under `docs/`. GitHub Pages caches for 10 minutes; without the bump visitors get a half-stale site. Current value: `v=10`.
3. **`GUIDE.md` is the source of `docs/guide.html`.** Edit `GUIDE.md`, then run `python scripts/build_guide.py` and commit both. Do not hand-edit `docs/guide.html`.
4. **`docs/data/snapshots.json` is generated** from real market data by `scripts/snapshot.py`. Never hand-edit or fabricate values. Quote figures in `GUIDE.md` that come from the reference case should be recomputed, not guessed.
5. **Tree validity.** The CRR tree needs `d < e^{(r-q)dt} < u`, i.e. `σ > |r-q|·√dt`. Any code that searches over σ (implied vol) must start above that bound or catch the error. See `american_implied_vol` (Python) and `americanImpliedVol` (JS).
6. **Yahoo has no CORS.** A static page cannot call it; the site uses a local API (`python -m pricer serve`) or the bundled snapshots. Do not add a public CORS proxy (they are unreliable and dead as of 2026-09).
7. **Git identity.** Commit with the GitHub `users.noreply.github.com` address, never a personal email. Repo is public.
8. **UI design system (glass).** Tokens live at the top of `docs/style.css` (`--glass`, `--ink*`, `--accent`, radii). New surfaces reuse `.glass`; do not invent new colours or blur values. Text must stay at 4.5:1 or better on glass, `prefers-reduced-motion` and `prefers-reduced-transparency` must keep working, and every interactive element needs a visible focus ring. Any new translucent surface must be added to the two `:is(.glass, .stat, ...)` fallback rules in `style.css`: by default the site follows the OS "reduce transparency" setting (this owner's Windows has Transparency effects OFF), and the header toggle (`html[data-glass="on|off"]`, remembered in localStorage) overrides it. Icons are the inline SVG sprite at the top of `index.html` (no emoji). Numbers use the mono font. Plotly charts take colours from the `GRID`/`ZERO`/`TXT`/`COLORS` constants and `baseLayout()` in `app.js`; **3-D (WebGL) scenes ignore alpha, so use solid hex colours there**. Every element ID in `index.html` is referenced from `app.js`; rename one and you must rename both. Inputs that carry an info tooltip use `<label for=...>` beside the `.tip` button (a button *inside* a label steals the label's association).
9. **Explainability over cleverness.** No new dependency or framework without a reason the owner can defend in class.
10. **Two volatilities, never merged.** `readRaw()` = the inputs as typed; `readInputs()` adds `p.sigmaModel` (the σ box, "my view") and sets `p.sigma` to the σ implied by the premium when `state.basis === 'market'` (the default once a premium is valid). `cache.mod` holds prices at your σ (hero, Overview prices, banner edge, LSMC); `cache.*` (g, ag, bsm, eu, am) is the analysis basis used by Greeks, payoff, What-if, Tree and both surfaces. The implied vol is **never written back into the σ input** (the old lock checkbox did, which destroyed the comparison).
11. **Surface has two implementations too.** `docs/js/surface.js` mirrors `src/pricer/surface.py` (same steps, same constants, dedupe of duplicate strikes). Change one, change the other, and re-run the parity check (write payloads with `cboe.chains`, build both, compare grids; max diff was ~1e-13 on TSLA/AAPL/PLTR and 6e-11 on SPX). `src/pricer/cboe.py` and `serverless/lib/cboe.py` must stay identical (a test enforces it).
12. **Do not overstate.** Numbers in docs and UI text must come from running the code. Say what was and was not verified.

## Definition of done

- `python -m pytest -q` passes; new behaviour has a test.
- JS and Python agree on any changed formula (rule 1).
- `GUIDE.md` → `docs/guide.html` rebuilt if `GUIDE.md` changed; cache-bust bumped if `docs/` changed.
- Pushed to `main`, Pages build is `built`, and the live page was loaded and exercised (not only the local copy).
- A handoff entry is appended below.

## Known limitations and open items

- Any-ticker on the hosted site uses the serverless API deployed on Vercel (project `options-pricer-api`, https://options-pricer-api-five.vercel.app, Hobby plan, linked to this repo with Root Directory `serverless`, so a push to `main` redeploys it); `DEFAULT_API` in `docs/js/data.js` points at it. If it is down, the site falls back to the 11 bundled snapshot tickers. The API has open CORS (`*`) and no rate limit. Cboe data is delayed, unofficial and has no historical volatility, dividend yield (estimated from put-call parity) or company name; the risk-free rate is the 13-week T-bill from Yahoo when reachable, else 4%.
- The *Premium impact* sweep curves use Black-Scholes even when American is selected; the comparison table uses the tree. The same holds for the Greeks-tab charts/surfaces and the payoff "today" curves (the UI now says so); only the tables, the Overview and What-if attribution use the American tree.
- Vercel: the agent-side tools were unusable on 2026-09-18 (`deploy_to_vercel` returned "Tool not found"; `create_git_project` needs a team ID and the owner's Hobby account has none), so the project was created in the Vercel dashboard by importing the repo (Preset: Other, Root Directory: `serverless`). Vercel auto-detects "Python" as the preset; that is wrong for this layout, keep it on Other.
- Known, left as is: "use as my σ" has no undo; a premium typed for one ticker is cleared on the next ticker Load; tree Greeks show "—" when σ is so low the bumped tree is invalid.
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

### 2026-09-18 · Claude → Codex (skew/term-structure hint + wording)
Done: After walking through live examples (PLTR call, SPY put, AAPL short vs long ATM) the owner asked for the "rich vs model" banner to stop misleading beginners. `volContext()` in `app.js` adds a note under the banner when the premium's implied vol differs from your σ by 15% or more (skew explanation for out-of-the-money puts; generic strike/expiry/earnings explanation otherwise; a "cheaper than your σ" variant). A matching Guide entry was added (numbers from 2026-09-18 live runs, dated). Also replaced five stale "Yahoo Finance" strings (footer, welcome card, tooltips) with Cboe/snapshot wording. Cache-bust `v=10`.
Verified: 31 tests pass; on a local dev server the note appears for an SPY put 5% OTM (edge -264%), for a PLTR ATM call, and when σ is set above the market's; it does not appear at fair value or for an AAPL ATM call at fair value. Computed style: solid background, text contrast about 9:1. NOT verified: a clean screenshot of the note (the in-app pane's screenshots did not track the scroll), Safari/Firefox, phones.
Needs from you: nothing. Idea: a "vol at this strike from the surface" number in the banner instead of only pointing to the Vol surface tab.
Open questions: none.

### 2026-09-18 · Claude → Codex (API deployed, hosted site any-ticker)
Done: Deployed `serverless/` on Vercel (project `options-pricer-api`, https://options-pricer-api-five.vercel.app), set `DEFAULT_API`, cache-bust `v=8`, pushed (commit 60fd818). The dashboard import was done in the in-app browser with the owner signed in; the owner did the sign-in.
Verified: against the deployed API with curl: `/api/ping` 200; quote PLTR 0.4 s; chains TSLA 1.3 s (11 KB), SPX 0.9 s (117 KB), NDX 0.5 s (88 KB), SPY, BRK-B; bad ticker gives 400 with a readable message; CORS preflight 204 with `Access-Control-Allow-Origin: *`; no Vercel login wall. On the live Pages site (Pages build `built`): PLTR, AMD, COIN, BRK-B, SPX loaded ("Live market data", 15-min delayed Cboe); PLTR contract picker, fair value 15.38 vs market 18.63 (implied vol 57.8%); premium +25% moved the implied vol to 59.9%; vol surface built in the browser (50x60 grid, IV 45.6% to 58.4%, no NaN) with the premium marker; a nonsense ticker shows the API's error text. NOT verified: behaviour if Cboe blocks or changes its feed, Vercel cold-start latency under load, mobile, Safari/Firefox, screen readers.
Needs from you: nothing required. Consider restricting the API's CORS origin to https://ferrsir.github.io and adding a smoke test that hits the live API.
Open questions: none new (the Cboe-vs-keyed-provider question above still stands).

### 2026-09-18 · Claude → Codex (any ticker + QA pass)
Done: (1) Any-ticker data: `src/pricer/cboe.py` (stdlib only; Cboe delayed chains; quote/chain/chains/dispatch/BaseHandler), Yahoo-first with Cboe fallback in `data.py`, `/api/chains` in the local server, `docs/js/surface.js` (JS port of the surface pipeline so a static page builds the vol surface from raw quotes), `serverless/` (Vercel functions; `lib/cboe.py` is a build copy via `scripts/build_serverless.py`), `scripts/dev_serverless.py` (site + those handlers on one port, simulates the hosted path). iv30 becomes the default σ. (2) Two QA agents (browser workflow; numeric JS-vs-Python) found real issues, fixed here: fake "LESS/MORE vol" wording at equal vol, "-0.0%" and nano-scale waterfall ticks, ±% chips now always relative to the MODEL price (were compounding), a premium is cleared when a new ticker loads, "Start from this" disabled when the model price is ~0, friendly message (naming the right σ) when the tree is invalid, tree Greeks no longer crash the page at tiny σ, and the UI now says Greeks/payoff charts are Black-Scholes when American is selected. Cache-bust `v=7`. 31 tests.
Verified: `pytest` 31 pass. JS surface vs Python surface: max grid diff ~1e-13 (TSLA/AAPL/PLTR), 6e-11 (SPX). Numeric QA agent: closed forms match Python to ~1e-13, trees ~1e-9, LSMC within its noise, 2,700 out-of-bounds implied-vol probes returned NaN, no invariant violated. Browser QA agent: premium workflow works as intended (10/10 checklist items). By hand in a browser on the dev server: PLTR (not in the snapshots) quote, contract pick, fair value 15.38 vs market 18.63 (IV 57.8%), chips, surface built in JS (50x60 grid, IV 45.6-58.4%, no NaN) with the premium marker. NOT verified: the hosted (GitHub Pages) any-ticker path, because the API is not deployed (see Known limitations); Safari/Firefox/mobile; screen readers.
Needs from you: deploy `serverless/` (Vercel dashboard: import this repo, Root Directory `serverless`, Framework Other), then set `DEFAULT_API` in `docs/js/data.js` to that URL (bump `?v=`) and load a non-snapshot ticker on the live page.
Open questions: Cboe's feed is unofficial and can change or block; is that acceptable for the hosted site, or should a keyed provider replace it?

### 2026-09-18 · Claude → Codex (premium drives Greeks and surfaces)
Done: The owner asked why editing their own premium did not change the Greeks and surfaces. Now the site holds two volatilities: your σ (the input, sets the model fair value) and the σ implied by the premium. A visible switch (Premium's σ / My σ, default Premium's once a premium is valid) chooses the analysis basis; the old "Lock σ" checkbox (which overwrote the σ input and destroyed the comparison) is gone. Added: Model fair value + "Start from this" above the premium box; Greeks tab overlays My σ (dashed) vs Premium's σ (solid) and marks the premium on the price chart; Greek surface View menu (premium σ / my σ / difference); payoff adds "today at my σ"; What-if starts at the analysis σ; vol-surface tab marks where the premium's implied vol sits; charts now always include today's spot in range; premium equal to fair value snaps to your σ. See rule 10 for the data model. Cache-bust `v=6`.
Verified: in a browser: your scenario (S 200, K 100, σ 20%, premium 150) gives delta 0.9999 vs 0.9037 and vega 0.0005 vs 0.34 in the charts and the table (matches Python), σ input never changes, American short put, impossible premium (switch disables, no crash), share link keeps the basis, marker moves live on the surface; 22 tests pass; full-width render inspected. NOT verified: keyboard-only use of the new switch with a screen reader, Safari/Firefox.
Needs from you (optional): a second reading of `compute()`/`readInputs()` for cases where the tree is invalid at the implied σ (very low implied vol with long expiry and few steps): today that surfaces as the existing error banner rather than falling back to your σ.
Open questions: none.

### 2026-09-18 · Claude → Codex (UI redesign)
Done: Redesigned the site as a glassmorphism UI (frosted panels over a navy mesh, IBM Plex Sans/Mono, amber accent, SVG icons). New UX: start-here card with one-click examples, contract summary chips + Copy-link (inputs restored from the URL), unit-suffixed inputs with info tooltips, collapsible input sections, keyboard-navigable ARIA tabs (arrow keys, Home/End), sticky tab bar, mobile Inputs/Results bar, toast, chart theming (Plotly matches the glass), skeleton shimmer, Open Graph/canonical tags. Glass has a header on/off toggle because the owner's OS reduces transparency (default follows the OS). No pricing logic was touched. Cache-bust is now `v=6`.
Verified: 22 tests still pass; page exercised in a browser; full-width (1440), and phone-width renders inspected with headless Edge. NOT verified: real touch devices, VoiceOver/NVDA, Safari/Firefox rendering of `backdrop-filter`, Lighthouse scores.
Needs from you (optional): run an accessibility audit (axe/Lighthouse) on `docs/index.html`; check contrast of `--ink-3` text over the brightest part of the background; try Firefox and Safari.
Open questions: none.

### 2026-09-18 · Claude → Codex
Done: Built the whole project from an empty folder (engines, CLI, tests, site, guide) and published it. Added premium what-if tools: *Your premium* box, the *Premium impact* tab (model σ vs market-implied σ, sweep curves), the *What-if* tab (P&L, Greek waterfall, heat map) and the plain-English *Guide* tab. Fixed the American implied-vol crash at very low σ (regression test added). Added this file.
Verified: 22 tests pass; JS engine matches Python (reference call/put/tree/Greeks agree to ~1e-12); live site exercised in a browser (tabs, premium flow, snapshot mode) with no console errors; Pages build `built`. NOT verified: a full-width desktop screenshot of the new tabs (the preview pane was tiny), mobile layout beyond one screenshot, keyboard/screen-reader accessibility.
Needs from you (all optional, none started): an independent review of `docs/js/pricing.js` against `src/pricer/*.py` for parity edge cases (very short expiry, large q, deep ITM/OTM); an accessibility pass on `docs/index.html` (labels, focus order, contrast); Open Graph / share-preview metadata for the Pages site.
Open questions: Should the hosted site get a live-data API? It needs the owner to approve a deploy to another platform, so ask them first.
