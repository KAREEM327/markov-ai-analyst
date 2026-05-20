import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const { tickers } = await req.json()

  if (!Array.isArray(tickers) || tickers.length === 0 || tickers.length > 15) {
    return NextResponse.json({ error: 'Provide 1–15 tickers' }, { status: 400 })
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'markov_regime.py')
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
  }

  const results = await Promise.allSettled(
    tickers.map(async (raw: string) => {
      const t = raw.trim().toUpperCase()
      if (!/^[A-Z0-9\-\.=]{1,20}$/i.test(t)) throw new Error(`Invalid ticker: ${t}`)
      const { stdout } = await execAsync(
        `uv run "${scriptPath}" --ticker ${t} --json --no-hmm`,
        { timeout: 90000, env }
      )
      const data = JSON.parse(stdout.trim())
      if (data.error) throw new Error(data.error)
      return { ticker: t, ...data }
    })
  )

  const output = results.map((r, i) => {
    const t = tickers[i].trim().toUpperCase()
    if (r.status === 'fulfilled') return r.value
    return { ticker: t, error: (r.reason as Error)?.message ?? 'Failed' }
  })

  return NextResponse.json({ results: output })
}
