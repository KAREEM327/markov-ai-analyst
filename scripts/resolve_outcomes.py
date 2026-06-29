# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pandas", "yfinance"]
# ///
"""
Resolve logged breakouts into outcomes — the second half of the self-updating
edge loop.

Reads data/breakout_log.jsonl (written by the scan route on every scan), and for
each fired breakout fetches the 4h candle path AFTER the signal to decide whether
the trade-plan TARGET or STOP was hit first (within a 20-candle window, the same
horizon the backtest used). Pessimistic on ties (stop counts first). Writes
data/outcomes.json: per-regime live win rate + sample count, to blend with the
static backtest stats as real data accrues.

Run manually for now; wire to a weekly cron once the log has volume.

    uv run resolve_outcomes.py            # resolve + print summary
    uv run resolve_outcomes.py --json     # machine-readable summary to stdout
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HORIZON = 20  # 4h candles to wait for target/stop, matching the backtest

DATA = Path(__file__).resolve().parent.parent / "data"
LOG = DATA / "breakout_log.jsonl"
OUT = DATA / "outcomes.json"


def fetch_4h(ticker: str) -> pd.DataFrame:
    import yfinance as yf
    df = yf.download(ticker, interval="1h", period="730d",
                     progress=False, auto_adjust=False)
    if df is None or df.empty:
        raise ValueError("no data")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    h, l, ts = [], [], []
    n = len(df) - (len(df) % 4)
    for i in range(0, n, 4):
        grp = df.iloc[i:i + 4]
        h.append(float(grp["High"].max()))
        l.append(float(grp["Low"].min()))
        ts.append(grp.index[-1])
    return pd.DataFrame({"high": h, "low": l}, index=pd.DatetimeIndex(ts))


def resolve_one(entry: dict, candles: pd.DataFrame) -> str:
    """Return 'target' | 'stop' | 'open' for one logged breakout."""
    ct = pd.to_datetime(entry["candle_time"])
    # candles strictly after the signal candle
    future = candles[candles.index > ct.tz_convert(candles.index.tz) if candles.index.tz else ct.tz_localize(None)]
    future = future.iloc[:HORIZON]
    if future.empty:
        return "open"
    target, stop = entry["target"], entry["stop"]
    for _, row in future.iterrows():
        hit_stop = row["low"] <= stop
        hit_tgt = row["high"] >= target
        if hit_stop:
            return "stop"        # pessimistic on tie
        if hit_tgt:
            return "target"
    # not resolved within horizon, and horizon has fully elapsed?
    return "timeout" if len(future) >= HORIZON else "open"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="resolve_outcomes")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    if not LOG.exists():
        out = {"error": "no breakout log yet", "regimes": {}, "total": 0}
        print(json.dumps(out) if args.json else "No breakout log yet — nothing to resolve.")
        return 0

    rows = [json.loads(ln) for ln in LOG.read_text().splitlines() if ln.strip()]
    # dedup by (ticker, candle_time) — same breakout can be logged on repeated scans
    seen, uniq = set(), []
    for r in rows:
        k = (r["ticker"], r["candle_time"])
        if k not in seen:
            seen.add(k); uniq.append(r)

    # group fetches by ticker to avoid refetching
    by_ticker: dict[str, list[dict]] = {}
    for r in uniq:
        by_ticker.setdefault(r["ticker"], []).append(r)

    resolved = []
    for ticker, entries in by_ticker.items():
        try:
            candles = fetch_4h(ticker)
        except Exception:
            continue
        for e in entries:
            try:
                e["outcome"] = resolve_one(e, candles)
                resolved.append(e)
            except Exception:
                continue

    # per-regime live win rate over decided (target|stop) outcomes
    regimes: dict[str, dict] = {}
    for reg in ("Bull", "Sideways", "Bear"):
        sub = [e for e in resolved if e["regime"] == reg]
        decided = [e for e in sub if e["outcome"] in ("target", "stop")]
        wins = sum(1 for e in decided if e["outcome"] == "target")
        regimes[reg] = {
            "logged": len(sub),
            "decided": len(decided),
            "wins": wins,
            "live_win_rate": round(wins / len(decided) * 100, 1) if decided else None,
        }

    out = {
        "updated_at": pd.Timestamp.now("UTC").isoformat(),
        "total_logged": len(uniq),
        "total_resolved": len(resolved),
        "regimes": regimes,
    }
    OUT.write_text(json.dumps(out, indent=2))

    if args.json:
        print(json.dumps(out))
    else:
        print(f"Resolved {len(resolved)} of {len(uniq)} logged breakouts.")
        for reg, s in regimes.items():
            wr = f"{s['live_win_rate']}%" if s["live_win_rate"] is not None else "n/a"
            print(f"  {reg:<9} logged={s['logged']:<4} decided={s['decided']:<4} live win rate={wr}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
