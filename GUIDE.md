# Plain-English guide: what is going on, and how to read every number and graph

Nothing here assumes you know finance. Every example uses one **reference case** so the numbers are easy to check:

> A stock trades at **$100**. You look at an option to buy or sell it at **$100**, expiring in **1 year**. A safe bank deposit pays **5%** a year. The stock's volatility is **20%**.

(These are the slide's numbers: a call is worth **$10.4506**, a European put **$5.5735**, an American put about **$6.09**.)

---

## 0. The one-minute version

* A stock price is unpredictable. An **option** is a contract whose payoff depends on where the price ends up. It costs money up front. That price is the **premium**.
* **The question of the whole course:** what is a *fair* premium, given that nobody can predict the stock?
* **Black-Scholes-Merton's answer:** the fair price is the **cost of building the same payoff yourself** by trading the stock and holding cash (this is called *replicating* or *hedging*). If the option sold for more or less than the cost of building it, someone could make free money. So the price is pinned down by *cost of construction*, not by anyone's opinion.
* **The surprising consequence:** the stock's expected return (whether it will go up or down on average) **does not appear in the price**. Only *how much it wiggles* (volatility) matters. Two people who disagree completely on direction must still agree on the option's price.
* **What this website/tool does:**
  1. computes the fair premium three different ways (formula, tree, random simulation),
  2. shows how sensitive that price is to everything (the **Greeks**),
  3. lets you type in a premium someone is offering and tells you whether it looks cheap or expensive, and what volatility it implies,
  4. shows what happens to your profit if the stock, the volatility or time moves (the **What-if** tab).

---

## 1. Words you need

| Word | Plain English | Reference case |
|---|---|---|
| **Underlying / stock** | The thing the option is written on (a stock, an index like the Nasdaq-100). | The $100 stock |
| **Spot, `S`** | Today's price of the underlying. ("On the spot" = right now.) | $100 |
| **Strike, `K`** | The fixed price written in the contract that you may buy or sell at. | $100 |
| **Expiry, `T`** | When the contract ends. The tool asks for *days*; the math uses *years* (days ÷ 365). | 1 year (365 days) |
| **Call** | The **right (not the obligation) to BUY** at the strike. You want the price to go **up**. | |
| **Put** | The **right (not the obligation) to SELL** at the strike. You want the price to go **down** (or you want insurance). | |
| **Premium** | What the option costs, **per share**. One standard contract covers **100 shares**, so multiply by 100 for dollars. | Call: $10.45 per share = **$1,045** per contract |
| **Long / Short** | Long = you **bought** the option (you paid premium). Short = you **sold** it (you collected premium, and you owe the payoff if it is exercised). | |
| **In / at / out of the money** | Call: in the money (ITM) if `S > K`. Put: ITM if `S < K`. At the money (ATM) if `S ≈ K`. Out of the money (OTM) otherwise. | Reference option is ATM |
| **Intrinsic value** | What the option would pay if exercised *right now*: `max(S − K, 0)` for a call, `max(K − S, 0)` for a put. | $0 (it is ATM) |
| **Time value** | Premium minus intrinsic value. You are paying for the *chance* the option ends up worth more. | All $10.45 |
| **Volatility, `σ` (sigma)** | How violently the price moves, in percent per year. 20% means the price typically ends the year within about ±20% of where it started (that is one standard deviation). Per day it is about 20% ÷ √252 ≈ 1.26%. | 20% |
| **Historical vol** | How much the stock *actually* moved in the past (the ticker box fills this in when the data source has price history; otherwise it uses the 30-day implied vol). | |
| **Implied vol** | The volatility you must plug into the formula for it to output the *market's price*. It is what the market is "saying" about future movement. | |
| **Risk-free rate, `r`** | What a safe deposit earns (we use the 13-week US T-bill). It matters because you pay the strike *later*, so its value today is discounted. | 5% |
| **Dividend yield, `q`** | Cash the stock pays out each year as a percent of price. Holders of options don't get dividends, so a higher `q` lowers call prices and raises put prices. | 0% |
| **European vs American** | European: can only be exercised **at expiry**. American: can be exercised **any time**. (Most listed stock options are American; index options like NDX are usually European.) | |
| **Model price vs market price** | Model price: what our formulas say it *should* cost. Market price: what someone is actually asking. The gap is your potential **edge**. | |
| **Risk-neutral** | A pretend world where every asset grows at the risk-free rate. We use it *only because* hedging makes prices identical to what they would be in that world. It is a calculation trick, not a forecast. Probabilities marked "risk-neutral" are not real-world odds. | |

---

## 2. How it works (three engines that should agree)

### Engine 1: the Black-Scholes-Merton formula (closed form)

You give it `S, K, T, r, σ, q`; it returns the premium in one line of math. The idea behind it:

1. Suppose you **sold** an option. You are now exposed to the stock moving.
2. Buy a certain number of shares, `Δ` ("delta"), so that a small stock move hurts the option and helps the shares equally. The random part cancels out.
3. What is left is **riskless**, so it must earn exactly the risk-free rate (otherwise there is free money).
4. Solve that condition and you get the price. The stock's expected return **cancelled out** along the way. That is why the price does not depend on your view of direction.

**What to remember:** the price depends on `σ` (how much it moves), not on where you think it is going. **Curvature is the product**: an option's payoff is a bent line (it has a "kink" at the strike), and randomness is worth more when a payoff is bent. That is why **higher volatility always raises an option's price**, calls and puts alike.

### Engine 2: the binomial tree (and how American options are priced)

Imagine time cut into many small steps. In each step the stock goes **up** by a fixed factor or **down** by a fixed factor. With hundreds of steps this builds a "tree" of possible prices.

* At expiry, every branch has a known payoff.
* Walk **backwards** to today. At each spot on the tree, the option's value is the discounted average of its two children, using a special weight `q̃` (the *risk-neutral probability*). That weight is not a forecast: it is whatever number makes the stock earn the risk-free rate on average.
* **American options:** at every spot, also compare "exercise right now" with "keep waiting" and take the **larger**. That single comparison is the only difference from the European tree.
* As you add steps, the tree price converges to the Black-Scholes price. That is how we **verify** the tree.

### Engine 3: Longstaff-Schwartz Monte Carlo (LSMC)

Instead of a tree, simulate thousands of random price paths. To decide "exercise or wait?" at each date, fit a curve (a regression) that estimates what waiting is worth from the current price, then exercise if the payoff beats that estimate. It is slightly **biased low** because the fitted curve is only an estimate. This is the method that scales to hard problems, and the regression step is exactly what the RKHS project generalises.

---

## 3. Reading the numbers, top to bottom

### The "Your premium" box (left panel)

Type any premium (per share) you want to test, or drag the slider.

* **= model, ±10%, ±25%** buttons: jump to the model price, or a price that much above or below it.
* **Implied vol:** the volatility that would make the formula produce *exactly your premium*. Compare it to your σ input: if implied vol is higher, your premium is pricing in **more** movement than you assumed.
* **Model fair value / "Start from this":** the box at the top shows what the model says the option *should* cost at **your** σ. Press it to copy that number into the premium field, then edit it (type, drag the slider, use the arrow keys or the % chips) and watch everything update.
* **Greeks, surfaces and scenarios use: Premium's σ / My σ.** A premium different from the model price implies a different volatility. This switch chooses whether the Greeks tab, the 3-D Greek surface, the payoff "today" curve and the What-if tab are computed at that implied volatility (the default once you enter a premium) or at your own σ. The fair value always uses your σ. Your σ box is never overwritten. This is how desks work: **they quote volatility, not dollars.** When a desk says "bid at 12.3", that is a volatility. On the reference option 12.3% vol is $7.61.

### The banner that appears when you enter a premium

| Cell | Meaning | Example (long call, premium $12) |
|---|---|---|
| **Your premium** | What you pay (long) or collect (short), per share and per contract. | $12.00 → $1,200 per contract |
| **Edge vs model** | *Your side's* advantage: model price minus premium if you are long; premium minus model if you are short. Green = you are getting a good deal by the model, red = a bad one. | −$1.55 (−14.8%): the premium is rich for the buyer |
| **Implied vol** | Vol that makes the model equal your premium. | 24.1% vs your 20% |
| **Breakeven** | Where the stock must be at expiry for you to make zero. Call: `K + premium`. Put: `K − premium`. | 112.00 |
| **P(profit)** | Chance of ending profitable **under the risk-neutral measure**. This is a model quantity, not a real-world forecast. | 33.8% |
| **Max loss / gain** | Long option: lose at most the premium; a long call can gain without limit. Short option: the reverse. | 12.00 / unbounded |

"Edge" is not a guarantee: it says the *model, at your σ*, thinks the price is off. If your σ is wrong, so is the edge. This is why the What-if tab and the implied vol matter.

### Premium impact: what changes when the market price is not the model price

This is the tab (and the "Your premium vs the model" card on Overview) for the question *"the model says 102 but it is really trading at 150: what does that change?"*

**The key fact.** For everything else fixed (stock, strike, days, rate), an option's price rises with volatility and only with volatility. So if the market's price differs from your model's price, the market must be using a **different volatility**. The tool finds that volatility (the **implied vol**) and recomputes every Greek at it. Your premium changes the Greeks *through* the volatility it implies.

**Worked example.** Stock 200, strike 100, 1 year, 5% rate, your vol 20% (a deep in-the-money call). The model price is **104.88**. Suppose the market asks **150**:

| | Model (your σ = 20%) | Market (σ implied by 150) | Change |
|---|---|---|---|
| Volatility | 20.00% | **176.18%** | +156 pts |
| Edge vs your premium (long) | −45.12 | 0.00 | |
| Delta | 0.9999 | 0.9037 | −0.096 |
| Gamma | 0.00001 | 0.00048 | up |
| Vega (per vol pt) | 0.0005 | **0.3415** | up hundreds of times |
| Theta (per day) | −0.0130 | −0.0866 | 7× more decay |
| Rho (per 1%) | 0.951 | 0.307 | down |
| P(finish ITM) | 100.0% | 32.3% | −68 pts |
| Breakeven | 250.00 | 250.00 | **unchanged** |

How to read it:

* **Volatility:** 150 is only justifiable if the market expects a *wild* stock (176% a year). Ask yourself whether that is believable. If not, the option is expensive (or you have the inputs wrong: a wrong strike, wrong days, a dividend you forgot).
* **Delta/gamma/vega/theta/rho changed** because at 20% vol a deep in-the-money option is basically the stock (delta 1, nothing sensitive to volatility), but at 176% vol it is a lottery ticket with a lot of time value, so it suddenly cares about volatility (vega) and bleeds time value (theta).
* **Breakeven, max loss and max gain did not change**: they depend only on the premium you pay and the strike, not on any model. Paying 150 means you need the stock at 250 at expiry, whatever anyone's volatility says.
* **Edge:** at your σ you'd overpay by 45. At the market's σ the "edge" is zero *by construction*. The decision is whether the market's σ is reasonable.

**The six curves** below the table show the same idea continuously: the horizontal axis is the premium, and every point re-solves the implied vol and recomputes the Greeks at it. The white dashed line is the model price at your σ; the orange line is your premium. You can watch delta, gamma, vega, theta and P(profit) slide as the premium moves from cheap to expensive. (For extremely high premiums the implied vol explodes because the premium approaches its upper bound, the stock price itself; the charts stop before that.)

**A more ordinary example.** Stock 100, strike 100, 1 year, 5%, your vol 20% (model 10.45). If the market is asking **14**, the implied vol is **29.4%**: delta 0.637 → 0.624, gamma 0.0188 → 0.0129, vega 0.375 → 0.379, theta −0.0176 → −0.0219 per day. The bigger the premium relative to the model, the more the whole risk profile shifts.

**What changes when you edit the premium.** With the switch on *Premium's σ* (the default), the **Greeks** tab overlays two sets of lines: dashed = your σ, solid = the σ your premium implies, so the gap is exactly what the premium changes. The **3-D Greek surface** has a *View* menu: at the premium's σ, at your σ, or their **difference** (red = the premium lowers that Greek, green = raises it). The **payoff** adds a dashed "today at my σ" curve, **What-if** values the scenarios at the premium's σ, and the **Vol surface** tab drops a marker where your premium's implied vol sits on the market surface (compare only if your inputs describe the same stock or index). Switch to *My σ* to put all of that back on your own view.

### The five price cards

| Card | Meaning |
|---|---|
| **Premium** (big orange) | The model price for the style you selected (European = BSM, American = tree). |
| **Intrinsic value** | Worth if exercised now. Zero for out-of-the-money. |
| **Time value** | Everything above intrinsic. It shrinks to zero as expiry arrives (**time decay**). |
| **Breakeven** | As above, using the model premium. |
| **P(finish ITM)** | Risk-neutral chance the option ends in the money, `N(d2)`. For the reference call: 56.0%. |

### The "Pricing models" table

| Row | Meaning | Reference call | Reference put |
|---|---|---|---|
| Black-Scholes-Merton | The formula. European. The benchmark. | 10.4506 | 5.5735 |
| European tree | Tree with no early exercise. Should be within a cent or so of BSM. | 10.4466 (500 steps) | ≈ 5.57 |
| American tree | Tree with early exercise. For a call with no dividends, **identical to European**. For a put, **higher**. | 10.4466 | 6.09 |
| Early-exercise premium | American minus European. | 0.0000 | ≈ 0.52 |
| LSMC | Simulation. Slightly *below* the tree (biased low). ± is a 95% margin. | | 6.06 ± 0.04 |

### The Greeks table: "if X changes by one unit, my option changes by…"

The Greeks are just **slopes** of the premium. They come in pairs (BSM formula, and the American tree). Long positions show as-is; short positions flip the signs.

| Greek | Question it answers | Reference call | Example |
|---|---|---|---|
| **Delta Δ** | If the stock rises **$1**, how much does the option gain? Also your **hedge ratio** (shares to hold against a short option) and a rough stand-in for P(ITM). Call: 0 to +1. Put: −1 to 0. | 0.637 | Stock $100→$101 changes the call 10.45→11.10 |
| **Gamma Γ** | How fast **delta itself** changes per $1 move. It is the **curvature**, and it is what you are actually buying with an option. Largest **at the money and close to expiry**. Same for calls and puts. | 0.0188 | Delta moves from 0.637 to about 0.656 after a $1 rise |
| **Vega** | If implied volatility rises **1 point** (say 20%→21%), how much does the option gain? Biggest for at-the-money, long-dated options. Same for calls and puts. | 0.375 | 20%→21% vol: call 10.45→10.83 |
| **Theta Θ** | How much value **bleeds away per day** just from time passing. Usually negative for long options: it is the **rent you pay for gamma**. | −0.0176 per day (1-year option). A 30-day ATM call bleeds about −0.045 per day | |
| **Rho ρ** | If the interest rate rises **1 point**, how much does the option gain? Usually small for short-dated options. Positive for calls, negative for puts. | 0.532 | 5%→6%: call 10.45→10.99 |

**Gamma and theta are one trade seen from two sides.** If you own an option (long gamma), you profit when the stock moves a lot and you pay theta every day it doesn't. A delta-hedged long option makes money when the stock's **realised** volatility is bigger than the **implied** volatility you paid for, and loses when it is smaller. That one sentence is the entire "gamma scalping" business.

---

## 4. Reading the graphs

### Payoff tab: "what do I make or lose?"

* **Orange line, "At expiry"**: the hockey stick. Flat until the strike, then rising (call) or falling (put), shifted down by the premium. Below the zero line you are losing money.
* **Blue line, "Today"**: what the position is worth *right now* if the stock jumps to the price on the x-axis. It is smooth and above the orange line: that gap is **time value**.
* **Green dotted line, "Halfway to expiry"**: the blue curve sliding down onto the orange one as time passes.
* **Red dashed vertical**: today's stock price. **Green dotted vertical**: your breakeven.
* Toggle **Short** and the picture flips upside down: capped gain (the premium), possibly huge loss.

### What-if tab: "what happens if…?"

* **Sliders**: move the stock (±30%), volatility (±20 points), and the days that go by. The four cards show the option's new value and your profit or loss, per share and per contract.
* **Waterfall chart**: breaks your profit into pieces.
  * **Edge at entry**: how much you gained or lost just by the premium you got versus the model.
  * **Delta**: gain from the stock's move, to first order.
  * **Gamma**: the extra from curvature (positive for long options if the stock moves a lot in either direction).
  * **Vega**: gain or loss from volatility changing.
  * **Theta**: what time decay cost you.
  * **Other**: what those first-order pieces miss (higher-order effects).
  * **Total** (orange) is your actual P&L.
* **Heat map**: green = profit, red = loss. The horizontal axis is the stock's move, the vertical axis is days passed (or volatility change, if you switch it). The yellow dot is where the sliders are now. Notice how, for a call, the green region shrinks and its left edge slides to the right as more days pass: time decay eats the value, so the stock has to go further to break even.

### Greeks tab

Six small charts, each showing one Greek across a range of stock prices. Each line is a different time to expiry; the red dashed line is the strike.

* **Delta**: an S-shaped curve. Flat near 0 (deep out of the money), rising through 0.5 near the strike, flat near 1 (deep in the money). The shorter the time left, the **steeper** the S.
* **Gamma**: a bell, tallest right at the strike. It gets **taller and narrower** as expiry approaches, which is why an at-the-money option about to expire is so twitchy.
* **Vega**: also a bell at the strike, but **larger for long-dated** options.
* **Theta**: a dip at the strike. It gets **much deeper as expiry nears**: at-the-money options lose value fastest in the last few weeks.
* **Rho**: a step, flat far from the strike, changing across it.
* **Premium**: the option's price curve. It is smoothly curved above the hockey stick, and it converges to it as time runs out.
* **X axis** dropdown: switch the chart to be against **days to expiry** or against **volatility**.
* **Greek surface (3-D)**: the same information over two variables at once (stock price and time). The tall ridge of **gamma** rushing up at the strike as time approaches zero is the picture to remember: "gamma spiking at the money as expiry approaches."

### Tree & LSMC tab

* **Convergence chart**: left axis is the price, horizontal is the number of tree steps (log scale). The blue European tree line closes in on the green dashed Black-Scholes line as steps increase. The dotted line (right axis) is the **error**, which zig-zags because of where the strike falls between tree levels. *That zigzag is correct and expected*; if it were perfectly smooth you should be suspicious. The orange American line sits **above** the blue one for the puts by the early-exercise premium.
* **Early-exercise boundary**: for an American put, the curve is the stock price **below which exercising immediately is better than waiting.** It starts well below the strike and rises to meet the strike at expiry. Why: deep in the money, the option has little "insurance value" left, and getting the strike in cash **now** lets you earn interest on it. For a call with no dividends the chart says "early exercise is never optimal": Merton's theorem (selling the option always beats exercising it, because exercising early throws away the time value and gives up the interest on the strike).

### Vol surface tab

This is the picture from your slide reference, and it is the most important idea after the formula itself.

* Each option on the same stock has a **different implied volatility** depending on its strike and expiry, even though Black-Scholes says there should be one number. The surface plots them all.
* **Horizontal axis, "log-moneyness" `ln(K/S)`:** a way of saying "how far the strike is from today's price". **0 = at the money.** Negative = strikes *below* the price (puts that insure against crashes). Positive = strikes above.
* **Depth axis, "time to expiry":** how many years until each option expires.
* **Height and color:** implied volatility. Blue = low, green = medium, yellow/orange = high.
* **The red dashed line** runs through the at-the-money options across all expiries.
* **The skew:** the surface is almost always **higher on the left** (strikes below the price). Since the crash of **October 1987** (S&P 500 down 20.5% in a day, a move the model calls essentially impossible), crash insurance is permanently more expensive. Traders use the volatility as a dial to make the formula output the price they actually want to charge. **Each strike has its own σ, and the surface is a map of where the market's fear lives and what it costs.**
* **Smile chart (below the 3-D plot):** three slices of the surface for short, medium and long expiry. Down and to the right = skew. A U-shape = smile.
* **Rough patches/spikes:** real quotes are noisy and illiquid far from the money. The pipeline (log-moneyness → Savitzky-Golay smoothing → PCHIP interpolation) smooths them but never removes all of it.

### Sanity checks tab

Nine automatic tests from the homework, run live on your current inputs. **"If one fails, stop and find out why."** They test: the reference price (10.4506), put-call parity (call − put = stock − discounted strike, which must hold to machine precision), tree vs formula, American call = European call (no dividends), American put > European put, deep in-the-money ≈ intrinsic, deep out-of-the-money ≈ 0, higher vol ⇒ higher price, and rate → 0 removes the put's early-exercise edge.

---

## 5. Ten experiments (with what you should see)

1. **Change nothing but volatility**: 10% → 20% → 30%. Call goes 6.80 → 10.45 → 14.23. Higher vol = a more valuable option, always.
2. **Cut days to expiry** from 365 to 30 to 1. The premium shrinks; the time value goes to zero; theta gets steeper.
3. **Switch to Put + American**: American 6.09 vs European 5.57. Open the Tree tab to see the early-exercise curve.
4. **Set the rate to 0** with an American put: the two prices become identical. No interest to earn, so no reason to exercise early.
5. **American call, dividend 0**: American = European exactly. Now set the dividend yield to 8%: the American call is now worth more.
6. **Type 12 as your premium** (long call): the implied vol is about 24% vs your 20%. Edge is red. Drag the slider down and watch the edge turn green once the premium drops below 10.45.
7. **Type a premium, then open the Greeks tab**: dashed lines = your σ, solid = the premium's σ. Open the 3-D Greek surface and change *View* to **Difference** to see where in (spot, time) the premium changes each Greek most.
8. **What-if with the call**: spot +10%, days passed 0: the profit is roughly delta × $10 plus a bit of gamma. Now move days passed to 90: watch theta pull it down in the waterfall.
9. **Short a put** (Short + Put): banner says max gain = premium, max loss = strike minus premium. In the What-if tab drag the spot to −20%: a huge loss compared with the small premium you collected. That is what "selling insurance" means.
10. **Load a ticker (NDX, SPY, AAPL)** and open **Vol surface**: find the skew (higher on the left) and the ATM line.

---

## 6. Cheat sheet: the four basic positions (from your slide)

| Position | View | Cash | Max gain | Max loss | Breakeven | Greeks |
|---|---|---|---|---|---|---|
| **Long call** | Bullish | Pay premium | Unbounded | The premium | `K + premium` | +Δ, +Γ, +vega, −Θ |
| **Short call** | Neutral to bearish | Collect premium | The premium | Unbounded | `K + premium` | −Δ, −Γ, −vega, +Θ |
| **Long put** | Bearish, or hedging | Pay premium | `K − premium` | The premium | `K − premium` | −Δ, +Γ, +vega, −Θ |
| **Short put** | Neutral to bullish | Collect premium | The premium | `K − premium` | `K − premium` | +Δ, −Γ, −vega, +Θ |

Rule of thumb: **long options = long gamma and long vega, and they pay theta.** Short options are the mirror image: they **collect** theta and are exposed to big moves.

---

## 7. Where each slide shows up

| Slide | Idea | Where in the tool |
|---|---|---|
| 3 · Puts and calls | Payoffs, kink, convexity, put-call parity | Payoff tab; parity check |
| 4 · Strategies | Long/short signs and max gain/loss | Banner, Payoff, cheat sheet above |
| 6 · Bachelier and Thorp | Edge, hedge, size | Edge cell in the banner; Delta = hedge ratio |
| 8 · Geometric Brownian motion | `dS = μS dt + σS dW`; `(dW)² = dt` | LSMC simulates exactly this |
| 9 · Hedge away randomness | The BSM PDE; μ vanishes | `bsm.py`; "How it works" tab |
| 10 · Rational option pricing | American call = European; early exercise | Sanity checks; exercise-boundary chart |
| 11 · Discretization | The tree, `q̃`, backward induction | Tree tab; `binomial.py` |
| 12 · BSM failure | Black Monday, the skew | Vol-surface tab |
| 13 · What desks run | Implied vol as the language; the surface | Implied-vol box; Vol-surface tab |
| 15 · Reading the Greeks | Delta, gamma, theta, vega | Greeks table, Greeks tab, What-if waterfall |
| 16 · Takeaways | Quote in vol; convexity is the product | Premium's σ switch, What-if |
| Homework | BSM, tree, American, LSMC, Greeks | The whole thing |

---

## 8. Common confusions

* **"If I don't know where the stock is going, how can it have a price?"** Because the option can be *replicated* with the stock and cash. The price is the cost of that replication. Direction cancels out; movement (volatility) is what you are pricing.
* **"Why do both calls and puts get more expensive when volatility rises?"** Both have a kink (a floor at zero). More randomness gives the upside more room while the floor caps the downside. This is Jensen's inequality: for a curved payoff, spreading the outcomes raises the average payoff.
* **"Is P(profit) the chance I actually make money?"** Not exactly. It uses the risk-neutral world (stock drifting at the risk-free rate). Real-world odds depend on the stock's true drift, which nobody knows. Treat it as a comparison tool between contracts.
* **"Why is theta negative?"** Every day that passes gives the option less time to move in your favour, so less time value. It is not a fee anyone charges; it is the price of holding curvature.
* **"Why does implied vol differ from what the ticker box says (historical vol)?"** Historical vol is the past. Implied vol is the market's *price* for the future, including fear and demand for insurance. The gap between them is a big part of what options traders trade.
* **"The tree and the formula don't match exactly."** They don't have to. The tree converges as steps increase and the small zigzag is a known feature of the method.
* **"The website says 'bundled snapshot' instead of live."** Yahoo does not allow browser pages to call it directly, so a web page needs a small server in the middle. The site looks for one in this order: your own (`python -m pricer serve`, Yahoo first with Cboe as backup), then the public data API connected to the hosted site, then the 11 bundled snapshots. Run `python -m pricer serve` locally for any ticker, live.
* **"What does 'live, 15-min delayed (Cboe)' mean, and can I trust it?"** Cboe publishes free, delayed option chains for every optionable US stock, ETF and index. Any ticker that has listed options works. What is *missing* from that feed, and how the site fills it: no company name (the ticker is shown instead); no historical volatility (the σ box starts from the 30-day **implied** vol, which is what the market is pricing today); no dividend yield (the site **estimates** it from put-call parity, and for low-dividend stocks it often comes out as 0%, so check it against the company's actual yield if you need precision). The vol surface for these tickers is built inside your browser from the raw bid/ask quotes, using the same steps as the Python version.
* **"Is it advice?"** No. It is an educational pricing tool, not a recommendation to buy or sell anything.
