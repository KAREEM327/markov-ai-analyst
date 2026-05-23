'use client'

import { useState, useRef, useCallback, KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea,
} from 'recharts'

interface ChartPoint {
  date: string
  close: number
  regime: string
}

interface AnalysisData {
  source: string
  current_regime: string
  current_price: number
  regime_duration_days: number
  signal: number
  stationary_distribution: { bear: number; sideways: number; bull: number }
  walk_forward: { sharpe: number; max_drawdown: number; n_trades: number }
  persistence_diagonal: { bear: number; sideways: number; bull: number }
  next_state_probabilities: { bear: number; sideways: number; bull: number }
  date_start: string
  date_end: string
  rows: number
  chart_data?: ChartPoint[]
}

interface ScanResult {
  ticker: string
  current_price?: number
  current_regime?: string
  regime_duration_days?: number
  signal?: number
  stationary_distribution?: { bear: number; sideways: number; bull: number }
  walk_forward?: { sharpe: number; max_drawdown: number }
  error?: string
}

type Stage = 'idle' | 'loading' | 'streaming' | 'done'
type Mode = 'single' | 'portfolio'

function formatPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (p >= 1) return `$${p.toFixed(2)}`
  return `$${p.toFixed(4)}`
}

function regimeColors(regime: string) {
  const map: Record<string, { badge: string; dot: string; text: string }> = {
    Bull:     { badge: 'bg-green-500/15 text-green-400 border-green-500/30', dot: 'bg-green-400', text: 'text-green-400' },
    Bear:     { badge: 'bg-red-500/15 text-red-400 border-red-500/30',       dot: 'bg-red-400',   text: 'text-red-400'   },
    Sideways: { badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30', dot: 'bg-amber-400', text: 'text-amber-400' },
  }
  return map[regime] ?? { badge: 'bg-zinc-800 text-zinc-400 border-zinc-700', dot: 'bg-zinc-400', text: 'text-zinc-400' }
}

function RegimeBadge({ regime }: { regime: string }) {
  const c = regimeColors(regime)
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-semibold ${c.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {regime}
    </span>
  )
}

function SignalChip({ signal }: { signal: number }) {
  const isLong = signal >= 0
  const isNeutral = Math.abs(signal) < 0.05
  const color = isNeutral ? 'text-zinc-500' : isLong ? 'text-green-400' : 'text-red-400'
  const label = isNeutral ? 'Neutral' : isLong ? '▲' : '▼'
  return (
    <span className={`font-mono text-sm font-semibold ${color}`}>
      {label} {signal >= 0 ? '+' : ''}{signal.toFixed(2)}
    </span>
  )
}

function SignalBar({ signal }: { signal: number }) {
  const pct = Math.round(Math.abs(signal) * 100)
  const isLong = signal >= 0
  const isNeutral = Math.abs(signal) < 0.05
  const label = isNeutral ? 'NEUTRAL' : isLong ? 'LONG BIAS' : 'SHORT BIAS'
  const color = isNeutral ? 'bg-zinc-600' : isLong ? 'bg-green-500' : 'bg-red-500'
  const textColor = isNeutral ? 'text-zinc-400' : isLong ? 'text-green-400' : 'text-red-400'
  const explain = isNeutral
    ? 'No clear edge — math sees roughly equal chance of up or down days next'
    : isLong
    ? 'Math sees more up days likely than down days in the near term'
    : 'Math sees more down days likely than up days in the near term'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500 uppercase tracking-wide">Direction Signal</span>
        <span className={`text-xs font-semibold ${textColor}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
        <span className="text-sm font-mono font-semibold text-zinc-300 w-12 text-right">
          {signal >= 0 ? '+' : ''}{signal.toFixed(2)}
        </span>
      </div>
      <p className="text-xs text-zinc-600 leading-snug">{explain}</p>
    </div>
  )
}

function MetricCard({ label, value, sub, explain }: { label: string; value: string; sub?: string; explain: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-zinc-400 mt-0.5">{sub}</p>}
      <p className="text-xs text-zinc-600 mt-2 leading-snug">{explain}</p>
    </div>
  )
}

function StatDist({ dist }: { dist: AnalysisData['stationary_distribution'] }) {
  const total = dist.bear + dist.sideways + dist.bull
  const bearPct = Math.round((dist.bear / total) * 100)
  const sidePct = Math.round((dist.sideways / total) * 100)
  const bullPct = 100 - bearPct - sidePct

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Historical Regime Mix</p>
      <p className="text-xs text-zinc-600 mb-3 leading-snug">Out of every 100 days over the past decade, how many were rising vs. falling vs. flat</p>
      <div className="flex h-2 rounded-full overflow-hidden gap-0.5 mb-3">
        <div className="bg-red-500/70 rounded-l-full" style={{ width: `${bearPct}%` }} />
        <div className="bg-amber-500/70" style={{ width: `${sidePct}%` }} />
        <div className="bg-green-500/70 rounded-r-full" style={{ width: `${bullPct}%` }} />
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-red-400">{bearPct} falling</span>
        <span className="text-amber-400">{sidePct} flat</span>
        <span className="text-green-400">{bullPct} rising</span>
      </div>
    </div>
  )
}

function RegimeChart({ data }: { data: ChartPoint[] }) {
  if (!data || data.length === 0) return null

  // Group consecutive same-regime runs into ReferenceArea spans
  const spans: { x1: string; x2: string; regime: string }[] = []
  let i = 0
  while (i < data.length) {
    const r = data[i].regime
    let j = i
    while (j < data.length && data[j].regime === r) j++
    spans.push({ x1: data[i].date, x2: data[j - 1].date, regime: r })
    i = j
  }

  const regimeFill = (r: string) =>
    r === 'Bull' ? '#22c55e18' : r === 'Bear' ? '#ef444418' : '#f59e0b12'

  const prices = data.map(d => d.close)
  const minP   = Math.min(...prices) * 0.994
  const maxP   = Math.max(...prices) * 1.006

  // Thin x-axis labels: show ~6 evenly spaced dates
  const step  = Math.max(1, Math.floor(data.length / 6))
  const ticks = data.filter((_, idx) => idx % step === 0).map(d => d.date)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-500 uppercase tracking-wide">Price + Regime History (1 yr)</p>
        <div className="flex gap-3">
          {(['Bull', 'Sideways', 'Bear'] as const).map(r => (
            <span key={r} className={`text-xs ${
              r === 'Bull' ? 'text-green-400' : r === 'Bear' ? 'text-red-400' : 'text-amber-400'
            }`}>
              ■ {r}
            </span>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          {spans.map((s, idx) => (
            <ReferenceArea key={idx} x1={s.x1} x2={s.x2} fill={regimeFill(s.regime)} ifOverflow="visible" />
          ))}
          <XAxis
            dataKey="date"
            ticks={ticks}
            tick={{ fill: '#52525b', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis domain={[minP, maxP]} hide />
          <Tooltip
            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11, padding: '6px 10px' }}
            labelStyle={{ color: '#a1a1aa', marginBottom: 2 }}
            formatter={(val: unknown) => [`$${(val as number).toFixed(2)}`, 'Close']}
          />
          <Line
            dataKey="close"
            stroke="#a1a1aa"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function ScanTable({ results, onSelect }: { results: ScanResult[]; onSelect: (ticker: string) => void }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-2.5 border-b border-zinc-800 text-xs text-zinc-600 uppercase tracking-wide">
        <span>Ticker</span>
        <span className="text-right">Price</span>
        <span>Regime</span>
        <span className="text-right">Duration</span>
        <span className="text-right">Signal</span>
        <span className="text-right">Bear Risk</span>
      </div>

      {results.map((r) => {
        if (r.error) {
          return (
            <div key={r.ticker} className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-3 border-b border-zinc-800/50 last:border-0">
              <span className="font-mono text-sm text-zinc-400">{r.ticker}</span>
              <span className="text-xs text-red-400 col-span-5 text-right">{r.error}</span>
            </div>
          )
        }

        const bearPct = r.stationary_distribution
          ? Math.round(r.stationary_distribution.bear * 100)
          : null

        return (
          <button
            key={r.ticker}
            onClick={() => onSelect(r.ticker)}
            className="w-full grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-3 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/40 transition-colors text-left group"
          >
            <span className="font-mono text-sm font-semibold text-white group-hover:text-zinc-200">
              {r.ticker}
            </span>
            <span className="font-mono text-sm text-zinc-300 text-right">
              {typeof r.current_price === 'number' ? formatPrice(r.current_price) : '—'}
            </span>
            <span>
              {r.current_regime ? <RegimeBadge regime={r.current_regime} /> : '—'}
            </span>
            <span className="text-sm text-zinc-500 text-right tabular-nums">
              {r.regime_duration_days != null ? `${r.regime_duration_days}d` : '—'}
            </span>
            <span className="text-right">
              {typeof r.signal === 'number' ? <SignalChip signal={r.signal} /> : '—'}
            </span>
            <span className={`text-sm font-mono text-right tabular-nums ${bearPct != null && bearPct >= 30 ? 'text-red-400' : bearPct != null && bearPct >= 15 ? 'text-amber-400' : 'text-zinc-400'}`}>
              {bearPct != null ? `${bearPct}%` : '—'}
            </span>
          </button>
        )
      })}

      <div className="px-4 py-2 text-xs text-zinc-700 border-t border-zinc-800">
        Click any row for the full analysis · Bear Risk = % of historical days spent falling
      </div>
    </div>
  )
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('single')

  // Single ticker state
  const [ticker, setTicker] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [status, setStatus] = useState('')
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)
  const [claudeText, setClaudeText] = useState('')
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  // Portfolio scan state
  const [scanInput, setScanInput] = useState('')
  const [scanLoading, setScanLoading] = useState(false)
  const [scanResults, setScanResults] = useState<ScanResult[] | null>(null)
  const [scanError, setScanError] = useState('')

  const analyze = useCallback(async (overrideTicker?: string) => {
    const t = (overrideTicker ?? ticker).trim().toUpperCase()
    if (!t || stage === 'loading' || stage === 'streaming') return

    // Switch to single mode if coming from portfolio
    setMode('single')
    setTicker(t)

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    setStage('loading')
    setStatus('Starting…')
    setAnalysisData(null)
    setClaudeText('')
    setError('')

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t }),
        signal: abort.signal,
      })

      if (!res.ok) throw new Error(`Server error ${res.status}`)
      if (!res.body) throw new Error('No response stream')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(part.slice(6))
            if (ev.type === 'status' && ev.message) setStatus(ev.message)
            if (ev.type === 'analysis') { setAnalysisData(ev.data); setStage('streaming') }
            if (ev.type === 'text') setClaudeText(prev => prev + ev.text)
            if (ev.type === 'error') { setError(ev.message); setStage('idle') }
            if (ev.type === 'done') setStage('done')
          } catch { /* malformed chunk */ }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message ?? 'Request failed')
      setStage('idle')
    }
  }, [ticker, stage])

  const scanPortfolio = useCallback(async () => {
    const tickers = scanInput
      .split(/[\n,]+/)
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && /^[A-Z0-9\-\.=]{1,20}$/i.test(t))

    if (tickers.length === 0) return
    if (tickers.length > 15) { setScanError('Max 15 tickers at once'); return }

    setScanLoading(true)
    setScanResults(null)
    setScanError('')

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      setScanResults(json.results)
    } catch (err: unknown) {
      setScanError((err as Error).message ?? 'Scan failed')
    } finally {
      setScanLoading(false)
    }
  }, [scanInput])

  const reset = () => {
    abortRef.current?.abort()
    setStage('idle')
    setAnalysisData(null)
    setClaudeText('')
    setError('')
    setStatus('')
    setTicker('')
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') analyze() }

  const isRunning = stage === 'loading' || stage === 'streaming'
  const sharpe = analysisData?.walk_forward.sharpe
  const maxDD = analysisData?.walk_forward.max_drawdown

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400">M</div>
          <span className="text-sm font-semibold text-zinc-300">Markov Regime Analyst</span>
        </div>
        {(stage !== 'idle' && mode === 'single') && (
          <button onClick={reset} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            New analysis
          </button>
        )}
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* Mode tabs */}
        <div className="flex gap-1 mb-8 bg-zinc-900 border border-zinc-800 rounded-xl p-1 w-fit">
          {(['single', 'portfolio'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
                mode === m ? 'bg-white text-black' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {m === 'single' ? 'Single Ticker' : 'Portfolio Scan'}
            </button>
          ))}
        </div>

        {/* ── SINGLE MODE ── */}
        {mode === 'single' && (
          <>
            <div className="mb-10">
              {stage === 'idle' && (
                <div className="mb-6">
                  <h1 className="text-3xl font-bold text-white mb-2">What regime is it in?</h1>
                  <p className="text-zinc-500 text-sm">Enter any ticker. Get a Markov regime analysis + Claude&apos;s plain-English breakdown.</p>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ticker}
                  onChange={e => setTicker(e.target.value.toUpperCase())}
                  onKeyDown={onKey}
                  placeholder="SPY, BTC-USD, GC=F…"
                  disabled={isRunning}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 text-sm font-mono focus:outline-none focus:border-zinc-600 disabled:opacity-50 transition-colors"
                />
                <button
                  onClick={() => analyze()}
                  disabled={!ticker.trim() || isRunning}
                  className="px-5 py-3 bg-white text-black text-sm font-semibold rounded-xl hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isRunning ? 'Running…' : 'Analyze'}
                </button>
              </div>
              {error && <p className="mt-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">{error}</p>}
            </div>

            {isRunning && !analysisData && status && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
                <span className="text-sm text-zinc-500">{status}</span>
              </div>
            )}

            {analysisData && (
              <div className="space-y-4 mb-8">
                {/* Regime + price + duration */}
                <div className="flex items-center gap-3 flex-wrap">
                  <RegimeBadge regime={analysisData.current_regime} />
                  <span className="text-sm text-zinc-500 font-mono">{analysisData.source}</span>
                  {typeof analysisData.current_price === 'number' && (
                    <span className="text-lg font-bold text-white font-mono">
                      {formatPrice(analysisData.current_price)}
                    </span>
                  )}
                  {typeof analysisData.regime_duration_days === 'number' && (
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${regimeColors(analysisData.current_regime).badge}`}>
                      {analysisData.regime_duration_days} day{analysisData.regime_duration_days !== 1 ? 's' : ''} in {analysisData.current_regime}
                    </span>
                  )}
                  <span className="text-xs text-zinc-700 ml-auto">{analysisData.date_end}</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <MetricCard
                    label="Consistency Score"
                    value={typeof sharpe === 'number' && isFinite(sharpe) ? sharpe.toFixed(2) : 'N/A'}
                    explain="How reliably the strategy made money vs. how bumpy the ride was. Above 1.0 = solid. Above 2.0 = excellent. Below 0.5 = weak."
                  />
                  <MetricCard
                    label="Worst-Case Drop"
                    value={typeof maxDD === 'number' && isFinite(maxDD) ? `${(maxDD * 100).toFixed(1)}%` : 'N/A'}
                    explain={typeof maxDD === 'number' && isFinite(maxDD) ? `A $10,000 investment would have fallen to ~$${Math.round(10000 * (1 + maxDD)).toLocaleString()} at its worst before recovering.` : 'The biggest peak-to-bottom drop seen in the backtest.'}
                  />
                  <MetricCard
                    label="Uptrend Stickiness"
                    value={`${(analysisData.persistence_diagonal.bull * 100).toFixed(0)}%`}
                    sub="when rising → stays rising"
                    explain={`On any given up day, there's a ${(analysisData.persistence_diagonal.bull * 100).toFixed(0)}% chance tomorrow is also an up day. High = momentum tends to continue.`}
                  />
                  <MetricCard
                    label="Downtrend Stickiness"
                    value={`${(analysisData.persistence_diagonal.bear * 100).toFixed(0)}%`}
                    sub="when falling → keeps falling"
                    explain={`On any given down day, there's a ${(analysisData.persistence_diagonal.bear * 100).toFixed(0)}% chance tomorrow is also a down day. High = drops tend to keep dropping.`}
                  />
                </div>

                {analysisData.chart_data && analysisData.chart_data.length > 0 && (
                  <RegimeChart data={analysisData.chart_data} />
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                    <SignalBar signal={analysisData.signal} />
                  </div>
                  <StatDist dist={analysisData.stationary_distribution} />
                </div>
              </div>
            )}

            {(claudeText || (isRunning && analysisData && status)) && (
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6">
                {status && isRunning && !claudeText && (
                  <div className="flex items-center gap-2 text-sm text-zinc-500">
                    <div className="w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
                    {status}
                  </div>
                )}
                {claudeText && (
                  <div className={`prose-analysis ${stage === 'streaming' ? 'cursor' : ''}`}>
                    <ReactMarkdown>{claudeText}</ReactMarkdown>
                  </div>
                )}
              </div>
            )}

            {stage === 'idle' && (
              <p className="text-center text-xs text-zinc-800 mt-16">
                Framework: Roan (@RohOnChain) · Backtests are historical, not forward-looking
              </p>
            )}
          </>
        )}

        {/* ── PORTFOLIO MODE ── */}
        {mode === 'portfolio' && (
          <>
            <div className="mb-6">
              <h1 className="text-3xl font-bold text-white mb-2">Portfolio Scanner</h1>
              <p className="text-zinc-500 text-sm">Enter up to 15 tickers — one per line or comma-separated. All run in parallel.</p>
            </div>

            <div className="mb-4">
              <textarea
                value={scanInput}
                onChange={e => setScanInput(e.target.value.toUpperCase())}
                placeholder={'SPY\nAAPL\nBTC-USD\nGC=F'}
                rows={5}
                disabled={scanLoading}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 text-sm font-mono focus:outline-none focus:border-zinc-600 disabled:opacity-50 transition-colors resize-none"
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-zinc-600">
                  {scanInput.split(/[\n,]+/).filter(t => t.trim().length > 0).length} tickers
                </span>
                <button
                  onClick={scanPortfolio}
                  disabled={scanLoading || !scanInput.trim()}
                  className="px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-xl hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {scanLoading ? 'Scanning…' : 'Scan All'}
                </button>
              </div>
              {scanError && <p className="mt-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">{scanError}</p>}
            </div>

            {scanLoading && (
              <div className="flex items-center gap-3 py-12 justify-center">
                <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
                <span className="text-sm text-zinc-500">Running all tickers in parallel…</span>
              </div>
            )}

            {scanResults && !scanLoading && (
              <ScanTable results={scanResults} onSelect={(t) => analyze(t)} />
            )}

            {!scanResults && !scanLoading && (
              <p className="text-center text-xs text-zinc-800 mt-16">
                Framework: Roan (@RohOnChain) · Backtests are historical, not forward-looking
              </p>
            )}
          </>
        )}

      </div>
    </main>
  )
}
