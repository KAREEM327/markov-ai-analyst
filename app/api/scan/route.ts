import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'

const execAsync = promisify(exec)

export const maxDuration = 300

// Full S&P 500 (sourced from the WMS universe table). The Python scanner fetches
// in parallel (8 workers), keeping a full scan inside the request timeout.
// ponytail: still a live scan per request — move to a cached background job if
// the timeout ever bites.
const UNIVERSE: string[] = JSON.parse(
  readFileSync(path.join(process.cwd(), 'scripts', 'sp500.json'), 'utf8')
)

// Edge verdict + backtested stats by regime (517-occurrence 4h backtest,
// tight stop + 2x target). Bull is the only real edge; Sideways marginal;
// Bear negative expectancy.
const REGIME_EDGE: Record<string, { verdict: string; win: number; expectancy: number; note: string }> = {
  Bull: { verdict: 'Confirmed', win: 66, expectancy: 0.65, note: 'Real edge — historically wins ~2 of 3 in this regime.' },
  Sideways: { verdict: 'Weak', win: 51, expectancy: 0.06, note: 'Marginal — close to a coin flip. Trade small or skip.' },
  Bear: { verdict: 'Avoid', win: 29, expectancy: -0.26, note: 'Negative edge — breakouts historically fail in this regime.' },
}

const env = {
  ...process.env,
  PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
}

async function currentRegime(): Promise<string> {
  const script = path.join(process.cwd(), 'scripts', 'markov_regime.py')
  const { stdout } = await execAsync(
    `uv run "${script}" --ticker SPY --json --no-hmm`,
    { timeout: 90000, env, maxBuffer: 1024 * 1024 * 8 }
  )
  const data = JSON.parse(stdout.trim())
  return data.current_regime ?? 'Sideways'
}

export async function POST() {
  const script = path.join(process.cwd(), 'scripts', 'breakout_4h.py')

  try {
    const [regime, scanOut] = await Promise.all([
      currentRegime(),
      execAsync(
        `uv run "${script}" --tickers ${UNIVERSE.join(',')} --only-passed --json`,
        { timeout: 280000, env, maxBuffer: 1024 * 1024 * 16 }
      ),
    ])

    const parsed = JSON.parse(scanOut.stdout.trim())
    const edge: Record<string, unknown> = { ...(REGIME_EDGE[regime] ?? REGIME_EDGE.Sideways) }

    // Blend the self-updating edge loop: if resolve_outcomes.py has scored enough
    // real breakouts in this regime, surface the live win rate next to the static
    // backtest stat. ponytail: gate on MIN_DECIDED so a handful of trades can't
    // masquerade as calibration; below that, the UI shows the backtest stat alone.
    const MIN_DECIDED = 20
    try {
      const oc = JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'outcomes.json'), 'utf8'))
      const lr = oc.regimes?.[regime]
      if (lr && lr.decided >= MIN_DECIDED && lr.live_win_rate != null) {
        edge.live = { winRate: lr.live_win_rate, decided: lr.decided }
      }
    } catch { /* no outcomes yet — backtest stat stands alone */ }

    let results = (parsed.results as Record<string, unknown>[])
      .filter((r) => r.passed)
      .map((r) => ({ ...r, regime, edge }) as Record<string, unknown>)
      .sort((a, b) => (b.rel_vol as number) - (a.rel_vol as number))

    // TimesFM forecast-confirmation pass — a SECOND opinion on survivors only,
    // never a standalone signal. Merged best-effort: a forecast failure or timeout
    // degrades to results without a `forecast` field, never blocks the scan.
    // ponytail: runs on ≤10 survivors so the ~30s model load is paid at most once.
    if (results.length) {
      try {
        const fcScript = path.join(process.cwd(), 'scripts', 'forecast_confirm.py')
        const payload = JSON.stringify(
          results.map((r) => {
            const tp = (r as Record<string, unknown>).trade_plan as Record<string, number>
            return { ticker: (r as Record<string, unknown>).ticker, entry: tp.entry, target: tp.target }
          })
        )
        const { stdout: fcOut } = await execAsync(
          `uv run "${fcScript}" --payload '${payload.replace(/'/g, "'\\''")}' --json`,
          { timeout: 180000, env, maxBuffer: 1024 * 1024 * 8 }
        )
        const fc = JSON.parse(fcOut.trim()).results as Record<string, unknown>[]
        const byTicker = new Map(fc.map((f) => [f.ticker, f]))
        results = results.map((r) => {
          const f = byTicker.get((r as Record<string, unknown>).ticker)
          return f && !f.error ? { ...r, forecast: f } : r
        })
        // Tie-break ranking: agreeing forecasts float above disagreeing ones
        // within the existing rel_vol order (stable on missing forecasts).
        results = results
          .map((r, i) => [r, i] as [typeof r, number])
          .sort((a, b) => {
            const fa = (a[0] as Record<string, unknown>).forecast as Record<string, unknown> | undefined
            const fb = (b[0] as Record<string, unknown>).forecast as Record<string, unknown> | undefined
            const aa = fa?.agrees ? 1 : 0
            const bb = fb?.agrees ? 1 : 0
            return bb - aa || a[1] - b[1]
          })
          .map(([r]) => r)
      } catch { /* forecast is confirmation only — never block the scan */ }
    }

    // Seed the self-updating edge loop: log each fired breakout so resolve_outcomes.py
    // can later score target/stop and recompute a live win rate. ponytail: append-only
    // JSONL, dedup happens at resolve time, not here.
    try {
      const logDir = path.join(process.cwd(), 'data')
      mkdirSync(logDir, { recursive: true })
      const lines = results.map((r) => {
        const tp = (r as Record<string, unknown>).trade_plan as Record<string, number>
        return JSON.stringify({
          logged_at: new Date().toISOString(),
          candle_time: (r as Record<string, unknown>).candle_time,
          ticker: (r as Record<string, unknown>).ticker,
          regime,
          entry: tp.entry, stop: tp.stop, target: tp.target,
        })
      })
      if (lines.length) appendFileSync(path.join(logDir, 'breakout_log.jsonl'), lines.join('\n') + '\n')
    } catch { /* logging is best-effort, never block the scan */ }

    const payload = {
      regime,
      edge,
      scanned_at: new Date().toISOString(),
      universe_size: UNIVERSE.length,
      results,
    }

    // Cache the last good scan so GET can serve it instantly — the live POST scan
    // is 60-70s (up to ~250s with the forecast pass) and risks the request timeout.
    // ponytail: a single JSON file, no DB; GET reads it, the UI shows it on load.
    try {
      const logDir = path.join(process.cwd(), 'data')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(path.join(logDir, 'last_scan.json'), JSON.stringify(payload))
    } catch { /* cache write is best-effort */ }

    return NextResponse.json(payload)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Scan failed: ${msg}` }, { status: 500 })
  }
}

// Serve the last cached scan instantly (no live work). Returns { cached: true } so
// the UI can flag staleness; 204 when no scan has run yet.
export async function GET() {
  try {
    const cached = readFileSync(path.join(process.cwd(), 'data', 'last_scan.json'), 'utf8')
    return NextResponse.json({ ...JSON.parse(cached), cached: true })
  } catch {
    return new NextResponse(null, { status: 204 })
  }
}
