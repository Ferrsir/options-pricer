# Methodology: how every number in this repo is produced

Written so you can explain the work line by line. Section numbers match the code modules.
Notation: `S` spot, `K` strike, `T` years to expiry, `r` risk-free rate, `σ` volatility, `q` continuous dividend yield.

---

## 1. Why an option has a price at all (`bsm.py`)

An option is insurance on a price, so its premium is the cost of manufacturing that insurance.
The BSM insight is that the seller can *manufacture it out of the stock and cash*, so the premium must equal the cost of doing so, otherwise there is an arbitrage.

**Model.** The stock follows geometric Brownian motion: `dS = μS dt + σS dW`.
`μ` is the drift (expected return), `σ` the size of random shocks, and `dW` a Brownian increment with `(dW)² = dt`.
That last identity is the key: squared randomness behaves like *time*, so curvature earns money.

**Hedge away the randomness.** Short one option, hold `Δ = ∂V/∂S` shares:

```
Π = V − ΔS
dΠ = (∂V/∂t + ½σ²S² ∂²V/∂S²) dt          <- the dW term cancels
```

Nothing random is left, so no-arbitrage forces `dΠ = rΠ dt`, which rearranges to the **Black-Scholes PDE**

```
∂V/∂t + rS ∂V/∂S + ½σ²S² ∂²V/∂S² − rV = 0
```

`μ` has vanished: two traders who disagree about the stock's expected return still agree on the option price.

**Solution (with dividend yield `q`)**

```
d1 = [ ln(S/K) + (r − q + σ²/2) T ] / (σ √T)          d2 = d1 − σ √T
Call = S e^{−qT} N(d1) − K e^{−rT} N(d2)
Put  = K e^{−rT} N(−d2) − S e^{−qT} N(−d1)
```

Reading it: `N(d2)` is the risk-neutral probability of finishing in the money, `K e^{−rT} N(d2)` is the expected discounted strike you pay, and `S e^{−qT} N(d1)` is the discounted expected stock you receive *given* exercise.

**Put-call parity** `C − P = S e^{−qT} − K e^{−rT}` follows from a pure payoff identity (long call + short put = forward), so it holds with no model at all. It is our first test.

## 2. The Greeks (`bsm_greeks`)

| Greek | Definition | Formula (call) | Intuition |
|---|---|---|---|
| Delta | ∂V/∂S | `e^{−qT} N(d1)` | Hedge ratio; ≈ P(ITM) |
| Gamma | ∂²V/∂S² | `e^{−qT} φ(d1) / (Sσ√T)` | Convexity. Long options are long gamma |
| Vega | ∂V/∂σ | `S e^{−qT} φ(d1) √T` | Exposure to implied vol |
| Theta | ∂V/∂t | `−S e^{−qT}φ(d1)σ/(2√T) − rK e^{−rT}N(d2) + qS e^{−qT}N(d1)` | Time decay: rent paid for gamma |
| Rho | ∂V/∂r | `K T e^{−rT} N(d2)` | Exposure to rates |
| Vanna | ∂²V/∂S∂σ | `−e^{−qT} φ(d1) d2 / σ` | How delta moves when vol moves |
| Volga | ∂²V/∂σ² | `Vega · d1 d2 / σ` | Convexity in vol |

(`φ` is the standard normal density. Put versions differ by the usual `N(−·)` and sign flips, see the code.)

**Why theta and gamma are two sides of one trade.** Plug the Greeks into the PDE for the delta-hedged portfolio `V − ΔS`: `Θ + ½σ²S²Γ = r(V − ΔS)`.
If you are long gamma you pay theta, and the break-even daily move is exactly the one implied by σ.
That is the slide's "convexity is the product; theta is what you pay to hold it".

**Units.** The code returns raw derivatives. The CLI and site scale: vega ÷100 (per vol point), theta ÷365 (per calendar day), rho ÷100 (per 1% rate).

**Checked** against central finite differences in `tests/test_pricer.py::test_greeks_match_finite_differences` (relative error < 1e-5).

## 3. Implied volatility (`implied_vol`, `implied_vol_vec`)

Desks quote **σ, not dollars**: "bid at 12.3" is a BSM vol.
Given a market premium, implied vol is the σ satisfying `BSM(σ) = premium`.
`∂BSM/∂σ = vega > 0`, so BSM is strictly increasing in σ and the root is **unique**, so bisection always converges.
A premium outside the no-arbitrage bounds (`max(S e^{−qT} − K e^{−rT}, 0) ≤ C ≤ S e^{−qT}`) has no implied vol and the code returns `NaN` rather than a wrong number.

## 4. The binomial tree (`binomial.py`)

Split time into `n` steps of `Δt = T/n`. Each step the stock goes to `uS` or `dS`:

```
u = e^{σ√Δt}      d = 1/u                      (Cox-Ross-Rubinstein; matches the variance of GBM)
```

**Replication.** Hold `Δ` shares plus a bond `B`. Two states, two unknowns:

```
Δ·uS + B e^{rΔt} = V_up          Δ·dS + B e^{rΔt} = V_down
```

Solving and substituting gives

```
V = e^{−rΔt} [ q̃ V_up + (1 − q̃) V_down ]        with        q̃ = (e^{(r−q)Δt} − d) / (u − d)
```

`q̃` looks like a probability but **nothing about forecasts went into it**: it is whatever weight makes the stock's expected growth equal the risk-free carry. This is the risk-neutral measure in finite form.

**Why `d < e^{(r−q)Δt} < u`.** If growth ≥ `u`, the stock beats the bond in *every* state (buy stock, borrow cash: free money) and `q̃ > 1`. If growth ≤ `d` the reverse. So `q̃ ∈ (0,1)` exactly when there is no arbitrage. The code raises an error when it is violated (happens only if `n` is too small for a large `|r − q|` relative to `σ`).

**Implementation.** Terminal payoffs are one vectorised array; we step backward with `V[:-1]`, `V[1:]`. Node prices are `S u^{2j−i}` because `d = 1/u`, so the tree recombines and has `O(n²)` work, `O(n)` memory.

**Convergence to BSM.** The tree is a discrete approximation of the same lognormal distribution, so it converges (error ~ `1/n`, with a saw-tooth because the strike falls at different places relative to lattice nodes). See `convergence.png`.

**Tree Greeks.** Delta, gamma and theta come free from nodes at steps 1 and 2 (Hull's method). Vega and rho are finite-difference bumps of the whole tree.

## 5. American options: exercise or wait?

At each node compute `continuation = discounted expectation` and `exercise = payoff now`, keep the larger. That single `np.maximum` is the entire difference from the European code. It is dynamic programming on the lattice, solving an **optimal stopping problem**: the option's value is the best you can do over all exercise rules.

**Facts to expect from the code (all are tests):**

* **American call, `q = 0`: premium over European is exactly 0** (Merton 1973). Selling the option always beats exercising: exercising forfeits the option's time value *and* pays K early (losing interest on K).
* **American put, `r > 0`: strictly more valuable than European.** Deep in the money you would rather receive K now and earn interest than wait. Reference: `S=K=100, T=1, r=5%, σ=20%`: European put 5.5735, American put **6.0896** (early-exercise premium ≈ 0.52).
* **`r → 0` kills the put's edge**: no interest to earn by exercising early, so waiting is free.
* **Calls on dividend payers** *can* be exercised early (just before the ex-dividend date). With `q` continuous in this model, an American call is worth more than the European when `q` is large relative to `r`.
* **Deep ITM ≈ intrinsic, deep OTM ≈ 0, vol up ⇒ price up**: the slide's sanity checks, all in `checks.py`.

**Early-exercise boundary** (`plot_boundary`): at each time, the critical spot below which a put should be exercised immediately. It rises toward `K` as expiry nears. The raw lattice boundary is a staircase (spot levels are discrete), so we smooth it for display only.

## 6. Longstaff-Schwartz Monte Carlo (`lsmc.py`)

The tree cannot handle many state variables, which is why LSMC matters (and why the RKHS project cares).

1. Simulate `N` risk-neutral paths `S_t = S exp((r − q − σ²/2)t + σW_t)` (antithetic pairs `±Z` halve the noise).
2. Start with cash flow = payoff at expiry.
3. Step back. Discount cash flows one step. Among **in-the-money** paths only, **regress the discounted future cash flow on basis functions of `S_t`** (weighted Laguerre polynomials). The fitted curve `Ĉ(S)` estimates the *continuation value* `E[V_{t+Δt} | S_t]`.
4. If `payoff > Ĉ(S_t)` exercise on that path (cash flow ← payoff), otherwise keep the future cash flow.
5. Price = average of discounted cash flows.

**Why regress only ITM paths:** exercise is only a question when the option pays something, and it concentrates the fit where the decision boundary is.
**Bias:** the estimated `Ĉ` sometimes makes a suboptimal exercise decision, and a suboptimal policy can only earn *less* than the optimum, so LSMC is biased **low** (we see 6.06 ± 0.04 vs tree 6.09). Also the exercise dates are a finite grid (Bermudan), another small downward bias.
**RKHS connection:** step 3 is a regression on a *fixed, finite* basis. Replace it with kernel ridge regression (an infinite-dimensional basis in a reproducing kernel Hilbert space) and the same algorithm learns the continuation value non-parametrically.

## 7. The implied-volatility surface (`surface.py`)

BSM predicts one σ for all strikes. Markets disagree: since Black Monday (S&P −20.5% in a day, a >20σ event under lognormality) out-of-the-money puts trade at premium vols permanently, the **skew**. Each `(K, T)` has its own implied vol; the full grid is the **surface**.

Pipeline (same as the footer of the reference picture):

1. **Log-moneyness `k = ln(K/S)`.** Puts strikes/underlyings on a comparable, roughly symmetric axis.
2. **Quotes → vols.** Use *out-of-the-money* options only (puts below the forward, calls above): they are the liquid ones and carry negligible early-exercise value, which matters because we invert a *European* formula. Drop quotes with `bid ≤ 0` or spread > 60% of mid. Invert BSM (vectorised bisection).
   The dividend yield per expiry is not assumed: it is backed out of put-call parity `F = K + e^{rT}(C − P)`, `q = r − ln(F/S)/T`, using the six strikes nearest the money (works for indexes such as NDX where no clean yield exists).
3. **Savitzky-Golay conditioning.** Reject outliers vs a rolling median (MAD-based), then fit a local quadratic in a 7-point sliding window. It removes quote noise while preserving the smile's curvature (a moving average would flatten the ends).
4. **Two-stage PCHIP.** (a) Interpolate across strike inside each expiry; (b) then across time at each fixed strike. PCHIP (piecewise cubic Hermite) is **monotone-preserving and never overshoots**, unlike a natural cubic spline that rings between points. Stage (b) is done on **total variance `w = σ²T`**, which must be non-decreasing in `T` (else a calendar spread is a free lunch), and we enforce that with a running maximum.
5. Beyond an expiry's quoted strikes we extrapolate linearly with half the edge slope, clipped to a sane vol band (avoids vertical cliffs on short-dated expiries with narrow strike ranges).

**Known limitations (state these before someone asks):** equity options are American, we invert with the European formula on OTM options (fine for OTM, imperfect for ITM); the interpolation removes butterfly arbitrage only approximately (a production desk fits SVI or arbitrage-free splines); rate = 13-week T-bill proxy; Yahoo quotes can be stale after hours.

## 8. Verification results

| Check | Result |
|---|---|
| BSM `C(100,100,1,5%,20%,0)` | 10.4506 (reference 10.4506) |
| BSM put | 5.5735 |
| Put-call parity gap | < 1e-10 |
| European tree, 2000 steps vs BSM | error < 5e-3, shrinking with n |
| American call (`q=0`) − European call | 0 (to 1e-9) |
| American put, 2000 steps | 6.0896 (≈ widely quoted 6.09) |
| American put − European put at `r=0` | 0 |
| LSMC put, 100k paths | 6.06 ± 0.04 (95%), below tree as expected |
| Greeks vs finite differences | rel. error < 1e-5 |
| Implied vol round-trip (σ from 5% to 150%) | error < 1e-6 |
| Surface recovery of a known vol function | within 1 vol point; implied `q` within 0.2% |
| JS engine (website) vs Python | agree to ~1e-12 |

Run them: `python -m pytest -q` and `python -m pricer checks`.

## 9. Questions you might get, and short answers

* **Why doesn't μ appear?** The hedge removes all dependence on the stock's expected return; only σ, r, q matter.
* **What is `q̃`?** The weight that makes the stock earn the risk-free rate on average. Not a forecast.
* **Why is an American call on a non-dividend stock never exercised early?** Exercising early throws away time value and interest on the strike; selling the option is always better. So its price equals the European price.
* **Why is LSMC biased low?** Suboptimal exercise policy from an estimated continuation value.
* **Why does the tree error oscillate?** Where the strike sits relative to the final-step nodes changes with `n`.
* **Why gamma spikes at expiry ATM?** Delta flips from 0 to 1 over a tiny price range, so its slope is huge; theta is largest there for the same reason.
* **Why a skew if BSM says flat?** Crash risk is priced: fat left tail, leverage effect, demand for portfolio insurance.
* **What breaks BSM?** Constant vol, continuous hedging, lognormality, no jumps (Black Monday); liquidity (LTCM 1998).
