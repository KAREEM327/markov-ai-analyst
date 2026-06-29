# Markov Analyst — Claude Code Context

## What This Is
Standalone web app that runs Markov regime analysis on any ticker (stocks, ETFs, crypto) and streams a plain-English AI breakdown via Claude. Also serves as a public-facing demo of the regime logic powering the Word Money System and Stock Hawk.

## Deployment
- **Platform:** Railway (auto-deploys on GitHub push to main)
- **Local dev:** `npm run dev` → `localhost:3000`
- **Config:** `.claude/launch.json`

## Stack
- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Recharts (charts + regime ribbon)
- Python via `uv run scripts/markov_regime.py` (called from API route)
- Anthropic SDK — `claude-sonnet-4-6` streaming

> ⚠️ This version of Next.js has breaking changes from training data. Read `node_modules/next/dist/docs/` before writing routing or API code. Heed deprecation notices. (See AGENTS.md)

## How It Works
1. User enters any ticker (e.g. AAPL, SPY, BTC-USD, GC=F)
2. API route calls Python script → runs HMM Markov analysis via yfinance
3. JSON output → Claude API → streams plain-English breakdown
4. UI renders: TL;DR + Full Breakdown (6 sections) + metric cards + regime chart

## Key Files
| File | Purpose |
|---|---|
| `app/page.tsx` | Full UI — all components including RegimeChart |
| `app/api/analyze/route.ts` | API route — calls Python, pipes to Claude streaming |
| `scripts/markov_regime.py` | Python: yfinance → HMM → JSON with chart_data |
| `.claude/launch.json` | Dev server config |

## UI Components (all in app/page.tsx)
- **Metric Cards:** Consistency Score, Worst-Case Drop, Uptrend/Uptrend Stickiness (plain English + dollar translation)
- **Direction Signal bar:** LONG BIAS / NEUTRAL / SHORT BIAS
- **Historical Regime Mix bar:** falling/flat/rising days out of 100
- **Regime Duration badge:** "X days in Bull"
- **RegimeChart:** Recharts LineChart + ReferenceArea for Bull(green)/Sideways(amber)/Bear(red) background bands, last 365 days
- **Portfolio Scanner:** up to 15 tickers in parallel → results table → click row → runs single-ticker analysis

## Python Script Output (scripts/markov_regime.py)
Returns JSON with:
- `current_regime` (Bull / Sideways / Bear)
- `regime_duration` (days)
- `persist_probability`
- `transition_matrix`
- `historical_mix` (% days in each state)
- `consistency_score`
- `worst_case_drop`
- `chart_data`: last 365 days as `[{date, close, regime}]`
- `current_price`

## Ticker Support
- Stocks + ETFs: standard symbols (AAPL, SPY)
- Crypto: `BTC-USD`, `ETH-USD` format
- Futures: `GC=F` format — auto-triggers futures roll cleaning (clips daily moves >10%)

## Architectural Constraints
- **Python via `uv run`** — do not switch to subprocess with system Python.
- **Streaming response** — the API route must stream; do not buffer Claude output.
- **No paid data APIs** — yfinance only.
- **RegimeChart uses ReferenceArea spans** — do not replace with a different charting approach without rebuilding the regime coloring logic.
- **Portfolio Scanner runs parallel** — do not serialize ticker fetches.

## WMS / Stock Hawk Relationship
- `scripts/markov_regime.py` shares the same HMM logic as `data/regime_markov.py` in WMS.
- Changes to regime parameters here should be mirrored in WMS and Stock Hawk's `signals/regime_markov.py`.

## Current Status (as of 2026-05-23)
v2 complete: single ticker + portfolio scanner + regime chart ribbon. Deployed and running.
Next (v3, no timeline): options flow overlay, alerts on regime transition.
