# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy", "yfinance", "timesfm[torch]>=2.0.0", "huggingface_hub"]
# ///
"""
TimesFM forecast-confirmation pass — a SECOND opinion on breakouts that already
passed the 8-check + regime gate. Never a standalone signal; only confirms or
disagrees with survivors the scanner already surfaced.

For each survivor it forecasts the next ~10 daily closes (≈ the 20×4h trade
horizon) and reports:
  forecast_return  predicted % change to end of horizon
  agrees           forecast points up (tailwind behind the breakout)
  reaches_target   forecast high over the horizon reaches the trade-plan target

Runs ONLY on survivors (usually 0-10), so the ~30s model load is paid once and
the whole pass is cheap against the 60-70s scan.

CLI:
    uv run forecast_confirm.py --payload '[{"ticker":"NVDA","entry":120.0,"target":135.0}]' --json
"""
from __future__ import annotations

import argparse
import glob
import json
import sys

import numpy as np

_CKPT_REPO = "google/timesfm-2.5-200m-pytorch"
_MAX_CONTEXT = 1024
_HORIZON = 10
_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    import timesfm
    from huggingface_hub import snapshot_download

    ckpt_dir = snapshot_download(_CKPT_REPO)
    ckpt_file = glob.glob(ckpt_dir + "/*.safetensors")[0]
    m = timesfm.TimesFM_2p5_200M_torch()
    m.load_checkpoint(ckpt_file)
    m.compile(
        timesfm.ForecastConfig(
            max_context=_MAX_CONTEXT,
            max_horizon=_HORIZON,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
        )
    )
    _model = m
    return _model


def _daily_closes(ticker: str) -> np.ndarray:
    import yfinance as yf

    df = yf.download(ticker, period="2y", interval="1d", progress=False, auto_adjust=False)
    if df is None or df.empty:
        raise ValueError("no data")
    arr = np.asarray(df["Close"].values, dtype=float).flatten()
    arr = arr[~np.isnan(arr)]
    if len(arr) < 2:
        raise ValueError("insufficient closes")
    return arr[-_MAX_CONTEXT:]


def confirm(ticker: str, entry: float, target: float) -> dict:
    closes = _daily_closes(ticker)
    model = _load_model()
    point_forecast, _ = model.forecast(horizon=_HORIZON, inputs=[closes])
    path = np.asarray(point_forecast[0], dtype=float)
    last_close = float(closes[-1])
    fwd_return = float(path[-1] / last_close - 1.0)
    return {
        "ticker": ticker,
        "forecast_return": round(fwd_return, 4),
        "agrees": bool(fwd_return > 0),
        "reaches_target": bool(float(path.max()) >= float(target)),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="forecast_confirm")
    p.add_argument("--payload", required=True,
                   help='JSON array of {ticker, entry, target}')
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    items = json.loads(args.payload)
    results = []
    for it in items:
        try:
            results.append(confirm(it["ticker"].upper(), float(it["entry"]), float(it["target"])))
        except Exception as exc:
            results.append({"ticker": it.get("ticker"), "error": str(exc)})

    print(json.dumps({"results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
