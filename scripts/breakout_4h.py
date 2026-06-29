# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pandas", "yfinance"]
# ///
"""
4h breakout scanner — live detection on the most recently completed 4h candle.

Aggregates 1h Yahoo data into 4h candles, then checks the latest completed
candle against the validated breakout condition. Returns the breakout stats,
the consolidation range, a trade plan (the +0.65R default: tight stop at the
breakout level, target = 2x the consolidation-range height), and the recent
candles for charting.

Regime tagging + edge verdict are attached upstream by the API route (which
already runs markov_regime.py) — this module stays pure breakout + plan.

CLI:
    uv run breakout_4h.py --tickers AAPL,MSFT,NVDA --json
    uv run breakout_4h.py --ticker NVDA --json --chart   # include candle array
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd

MAX_WORKERS = 8   # yfinance fetches are I/O-bound; threads cut a 500-ticker scan to ~1-2 min

LOOKBACK = 10          # prior completed 4h candles forming the consolidation
MAX_RANGE_PCT = 12.0   # consolidation must be tight
BREAKOUT_MULT = 1.02   # close >= consolidationHigh * 1.02
MIN_BREAKOUT_SIZE = 5.0
MIN_REL_VOL = 1.5
TARGET_MULT = 2.0      # validated default: target = entry + 2x range height
CHART_CANDLES = 40     # how many recent 4h candles to return for charting


def fetch_4h(ticker: str) -> pd.DataFrame:
    """Fetch 1h bars and aggregate every 4 into one 4h candle."""
    import yfinance as yf

    df = yf.download(ticker, interval="1h", period="730d",
                     progress=False, auto_adjust=False)
    if df is None or df.empty:
        raise ValueError("no data")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    o, h, l, c, v = [], [], [], [], []
    ts = []
    n = len(df) - (len(df) % 4)
    for i in range(0, n, 4):
        grp = df.iloc[i:i + 4]
        o.append(float(grp["Open"].iloc[0]))
        h.append(float(grp["High"].max()))
        l.append(float(grp["Low"].min()))
        c.append(float(grp["Close"].iloc[-1]))
        v.append(float(grp["Volume"].sum()))
        ts.append(grp.index[-1])
    return pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": v},
                        index=pd.DatetimeIndex(ts))


def scan_ticker(ticker: str, want_chart: bool = False) -> dict:
    """Evaluate the most recently completed 4h candle for a breakout."""
    candles = fetch_4h(ticker)
    if len(candles) < LOOKBACK + 1:
        raise ValueError("insufficient candles")

    i = len(candles) - 1                      # most recent completed 4h candle
    cur = candles.iloc[i]
    prior = candles.iloc[i - LOOKBACK:i]

    body_high = np.maximum(prior["open"], prior["close"])
    body_low = np.minimum(prior["open"], prior["close"])
    cons_high = float(body_high.max())
    cons_low = float(body_low.min())
    range_pct = (cons_high - cons_low) / cons_low * 100.0

    close = float(cur["close"])
    open_ = float(cur["open"])
    vol = float(cur["volume"])
    avg_vol = float(prior["volume"].mean())

    breakout_pct = (close - cons_high) / cons_high * 100.0
    breakout_size = abs(close - open_) / open_ * 100.0
    rel_vol = vol / avg_vol if avg_vol > 0 else 0.0

    checks = {
        "consolidation_tight": range_pct <= MAX_RANGE_PCT,
        "breakout_above_range": close >= cons_high * BREAKOUT_MULT,
        "breakout_size": breakout_size >= MIN_BREAKOUT_SIZE,
        "relative_volume": rel_vol >= MIN_REL_VOL,
    }
    passed = all(checks.values())

    # Trade plan (validated +0.65R default): tight stop at breakout level,
    # target = entry + 2x consolidation-range height.
    range_height = cons_high - cons_low
    entry = close
    stop = cons_high
    target = entry + TARGET_MULT * range_height
    risk = entry - stop
    reward = target - entry
    rr = round(reward / risk, 2) if risk > 0 else None

    out = {
        "ticker": ticker,
        "passed": passed,
        "checks": checks,
        "price": round(close, 2),
        "breakout_pct": round(breakout_pct, 2),
        "breakout_size": round(breakout_size, 2),
        "rel_vol": round(rel_vol, 2),
        "consolidation_high": round(cons_high, 2),
        "consolidation_low": round(cons_low, 2),
        "range_pct": round(range_pct, 2),
        "candle_time": candles.index[i].isoformat(),
        "trade_plan": {
            "entry": round(entry, 2),
            "stop": round(stop, 2),
            "target": round(target, 2),
            "risk": round(risk, 2),
            "reward": round(reward, 2),
            "rr": rr,
        },
    }

    if want_chart:
        tail = candles.iloc[-CHART_CANDLES:]
        out["candles"] = [
            {"t": t.isoformat(), "o": round(float(r.open), 2), "h": round(float(r.high), 2),
             "l": round(float(r.low), 2), "c": round(float(r.close), 2)}
            for t, r in tail.iterrows()
        ]
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="breakout_4h")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--tickers", help="comma-separated list, e.g. AAPL,MSFT")
    g.add_argument("--ticker", help="single symbol")
    p.add_argument("--json", action="store_true")
    p.add_argument("--chart", action="store_true", help="include candle array (single ticker)")
    p.add_argument("--only-passed", action="store_true", help="omit non-breakouts")
    args = p.parse_args(argv)

    if args.ticker:
        try:
            res = scan_ticker(args.ticker.upper(), want_chart=args.chart)
            print(json.dumps(res))
            return 0
        except Exception as exc:
            print(json.dumps({"ticker": args.ticker.upper(), "error": str(exc)}))
            return 1

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]

    def work(t: str):
        try:
            return scan_ticker(t)
        except Exception as exc:
            return {"ticker": t, "error": str(exc)}

    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(work, t): t for t in tickers}
        for fut in as_completed(futures):
            r = fut.result()
            if args.only_passed and (r.get("error") or not r.get("passed")):
                continue
            results.append(r)

    print(json.dumps({"results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
