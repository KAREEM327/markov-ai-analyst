import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
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
    const edge = REGIME_EDGE[regime] ?? REGIME_EDGE.Sideways

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

    return NextResponse.json({
      regime,
      edge,
      scanned_at: new Date().toISOString(),
      universe_size: UNIVERSE.length,
      results,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Scan failed: ${msg}` }, { status: 500 })
  }
}
