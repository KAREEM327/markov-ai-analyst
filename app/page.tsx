'use client'

import { useEffect, useRef, useState } from 'react'

type TradePlan = {
  entry: number; stop: number; target: number
  risk: number; reward: number; rr: number | null
}
type Edge = { verdict: string; win: number; expectancy: number; note: string }
type Forecast = { forecast_return: number; agrees: boolean; reaches_target: boolean }
type Result = {
  ticker: string; price: number; breakout_pct: number; breakout_size: number
  rel_vol: number; consolidation_high: number; consolidation_low: number
  range_pct: number; candle_time: string; trade_plan: TradePlan
  regime: string; edge: Edge; forecast?: Forecast
}
type ScanData = {
  regime: string; edge: Edge; scanned_at: string; universe_size: number; results: Result[]
}
type Candle = { t: string; o: number; h: number; l: number; c: number }

const REGIME_COLOR: Record<string, string> = {
  Bull: 'var(--green)', Sideways: '#f5a524', Bear: 'var(--red)',
}
const REGIME_LINE: Record<string, string> = {
  Bull: 'breakouts have a real edge right now',
  Sideways: 'breakouts are a coin flip right now — trade small or skip',
  Bear: 'breakouts historically fail right now — stand down',
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function CandleChart({ ticker, consHigh, consLow }: { ticker: string; consHigh: number; consLow: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let chart: { remove: () => void } | null = null
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/chart', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        if (cancelled || !ref.current) return
        const candles: Candle[] = data.candles ?? []

        const lib = await import('lightweight-charts')
        const c = lib.createChart(ref.current, {
          width: ref.current.clientWidth, height: 200,
          layout: { background: { color: 'transparent' }, textColor: '#6b7280' },
          grid: { vertLines: { color: 'rgba(0,212,255,0.05)' }, horzLines: { color: 'rgba(0,212,255,0.05)' } },
          timeScale: { borderColor: 'rgba(0,212,255,0.12)', timeVisible: true },
          rightPriceScale: { borderColor: 'rgba(0,212,255,0.12)' },
        })
        chart = c
        const series = c.addCandlestickSeries({
          upColor: '#00ff88', downColor: '#ff3366', borderVisible: false,
          wickUpColor: '#00ff88', wickDownColor: '#ff3366',
        })
        series.setData(candles.map((k) => ({
          time: Math.floor(new Date(k.t).getTime() / 1000) as never,
          open: k.o, high: k.h, low: k.l, close: k.c,
        })))
        series.createPriceLine({ price: consHigh, color: 'rgba(255,51,102,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'range hi' })
        series.createPriceLine({ price: consLow, color: 'rgba(255,51,102,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'range lo' })
        c.timeScale().fitContent()
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'chart failed')
      }
    })()
    return () => { cancelled = true; if (chart) chart.remove() }
  }, [ticker, consHigh, consLow])

  if (err) return <div className="text-xs" style={{ color: 'var(--muted)' }}>Chart unavailable: {err}</div>
  return <div ref={ref} style={{ width: '100%', height: 200 }} />
}

export default function Home() {
  const [scanning, setScanning] = useState(false)
  const [data, setData] = useState<ScanData | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  async function scan() {
    setScanning(true); setError(''); setOpen(null)
    try {
      const res = await fetch('/api/scan', { method: 'POST' })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'scan failed')
    } finally {
      setScanning(false)
    }
  }

  const regime = data?.regime ?? ''
  const regimeColor = REGIME_COLOR[regime] ?? 'var(--muted)'

  return (
    <>
      <div id="hero-bg" />
      <div id="bg-overlay" />
      <main style={{ position: 'relative', zIndex: 2, maxWidth: 760, margin: '0 auto', padding: '0 16px 48px', width: '100%' }}>

        <nav style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64, position: 'sticky', top: 0, zIndex: 50, backdropFilter: 'blur(20px)', background: 'rgba(5,5,8,.55)', borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 600, letterSpacing: '.14em', color: 'var(--cyan)', fontSize: 16, textShadow: '0 0 20px rgba(0,212,255,.5)' }}>
            STOCK HAWK
          </div>
          <button onClick={scan} disabled={scanning}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#050508', background: 'linear-gradient(90deg,#00d4ff,#00ff88)', padding: '9px 20px', borderRadius: 22, border: 'none', cursor: scanning ? 'wait' : 'pointer', opacity: scanning ? 0.7 : 1 }}>
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
        </nav>

        {error && <div style={{ padding: 14, borderRadius: 10, background: 'rgba(255,51,102,.08)', border: '1px solid rgba(255,51,102,.3)', color: 'var(--red)', fontSize: 14, marginBottom: 16 }}>{error}</div>}

        {!data && !scanning && !error && (
          <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--muted)' }}>
            <div style={{ fontSize: 17, color: 'var(--text)', marginBottom: 8 }}>Find breakouts that actually have an edge</div>
            <div style={{ fontSize: 14 }}>Hit “Scan now” to check the market for 4-hour breakouts, graded by whether they historically work in today’s regime.</div>
          </div>
        )}

        {scanning && (
          <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--muted)', fontSize: 14 }}>
            Scanning the market for breakouts… this takes a moment.
          </div>
        )}

        {data && (
          <>
            <div style={{ margin: '0 0 18px', padding: '14px 18px', borderRadius: 12, background: regime === 'Bull' ? 'rgba(0,255,136,.07)' : regime === 'Bear' ? 'rgba(255,51,102,.07)' : 'rgba(245,165,36,.07)', border: `1px solid ${regimeColor}40`, display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: '50%', background: `${regimeColor}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: regimeColor, fontSize: 22, fontWeight: 700 }}>
                {regime === 'Bull' ? '↑' : regime === 'Bear' ? '↓' : '→'}
              </div>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 2 }}>Market regime today</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: regimeColor }}>{regime.toUpperCase()} — {REGIME_LINE[regime]}</div>
                <div style={{ fontSize: 12, color: '#8b95a5', marginTop: 2 }}>{data.edge.note}</div>
              </div>
            </div>

            <div style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', margin: '4px 0 10px' }}>
              {data.results.length} breakout{data.results.length === 1 ? '' : 's'} found · scanned {data.universe_size} stocks · tap one for the plan
            </div>

            {data.results.length === 0 && (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 14, border: '1px solid var(--border)', borderRadius: 12 }}>
                No breakouts found right now — try scanning again later.
              </div>
            )}

            {data.results.map((r) => {
              const isOpen = open === r.ticker
              const v = r.edge.verdict
              const vColor = v === 'Confirmed' ? 'var(--green)' : v === 'Avoid' ? 'var(--red)' : '#f5a524'
              const tp = r.trade_plan
              return (
                <div key={r.ticker} style={{ marginBottom: 8 }}>
                  <div onClick={() => setOpen(isOpen ? null : r.ticker)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: isOpen ? 'rgba(0,212,255,.07)' : 'rgba(255,255,255,.02)', border: `1px solid ${isOpen ? 'rgba(0,212,255,.35)' : 'var(--border)'}`, borderRadius: isOpen ? '10px 10px 0 0' : 10, padding: '13px 15px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ color: isOpen ? 'var(--cyan)' : 'var(--muted)', fontSize: 15 }}>{isOpen ? '▾' : '▸'}</span>
                      <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: '.03em' }}>{r.ticker}</span>
                      <span className="font-mono" style={{ color: '#8b95a5', fontSize: 13 }}>${fmt(r.price)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <span className="font-mono" style={{ fontSize: 11, color: 'var(--muted)' }}>+{r.breakout_pct}% · {r.rel_vol}× vol</span>
                      {r.forecast && (
                        <span title={r.forecast.agrees ? 'Forecast agrees — model sees upside over the trade horizon' : 'Forecast disagrees — model does not see upside'}
                          style={{ fontSize: 11, color: r.forecast.agrees ? 'var(--green)' : '#8b95a5' }}>
                          {r.forecast.agrees ? '✓ forecast' : '~ forecast'}
                        </span>
                      )}
                      <span style={{ fontSize: 11, fontWeight: 600, color: vColor, background: `${vColor}1f`, padding: '3px 9px', borderRadius: 5 }}>{v}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div style={{ background: 'rgba(13,13,26,.6)', border: '1px solid rgba(0,212,255,.2)', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: 16 }}>
                      <CandleChart ticker={r.ticker} consHigh={r.consolidation_high} consLow={r.consolidation_low} />

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, margin: '14px 0' }}>
                        <div style={{ textAlign: 'center', padding: '11px 4px', background: 'rgba(255,255,255,.02)', borderRadius: 8 }}>
                          <div style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Entry</div>
                          <div className="font-mono" style={{ fontSize: 17, fontWeight: 600 }}>${fmt(tp.entry)}</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '11px 4px', background: 'rgba(255,51,102,.05)', borderRadius: 8 }}>
                          <div style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Stop</div>
                          <div className="font-mono" style={{ fontSize: 17, fontWeight: 600, color: 'var(--red)' }}>${fmt(tp.stop)}</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '11px 4px', background: 'rgba(0,255,136,.05)', borderRadius: 8 }}>
                          <div style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Target</div>
                          <div className="font-mono" style={{ fontSize: 17, fontWeight: 600, color: 'var(--green)' }}>${fmt(tp.target)}</div>
                        </div>
                      </div>

                      <div style={{ fontSize: 13, lineHeight: 1.6, color: '#b4bcc8', borderTop: '1px solid rgba(0,212,255,.1)', paddingTop: 12 }}>
                        {r.ticker} broke out of its consolidation on {r.rel_vol}× volume, in a {regime} regime. Risk{' '}
                        <span className="font-mono" style={{ color: 'var(--red)' }}>${fmt(Math.abs(tp.risk))}</span> to make{' '}
                        <span className="font-mono" style={{ color: 'var(--green)' }}>${fmt(tp.reward)}</span>
                        {tp.rr ? <> — about {tp.rr}:1.</> : '.'}{' '}
                        {v === 'Confirmed' ? 'Roughly 2 of 3 of these reach target.' : v === 'Avoid' ? 'But this regime has negative edge — caution.' : 'Edge is marginal here — size small.'}{' '}
                        Exit if it closes back below ${fmt(tp.stop)}.
                      </div>

                      <div style={{ fontSize: 11, color: '#5a6472', marginTop: 12 }}>
                        Why this grade: {r.edge.win}% historical win rate, {r.edge.expectancy >= 0 ? '+' : ''}{r.edge.expectancy}R per trade ({regime} regime, 517 backtested 4h breakouts).
                        {r.forecast && (
                          <> {' '}TimesFM forecast {r.forecast.agrees ? 'agrees' : 'disagrees'} ({r.forecast.forecast_return >= 0 ? '+' : ''}{(r.forecast.forecast_return * 100).toFixed(1)}% over ~10 days){r.forecast.agrees && r.forecast.reaches_target ? ' and reaches target' : r.forecast.agrees ? ' but stalls below target' : ''} — a second opinion, not a trade signal.</>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            <div style={{ textAlign: 'center', fontSize: 11, color: '#4a525e', padding: '24px 0 0' }}>
              For research and education only. Not financial advice.
            </div>
          </>
        )}
      </main>
    </>
  )
}
