import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

export const maxDuration = 120

const env = {
  ...process.env,
  PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
}

export async function POST(req: NextRequest) {
  const { ticker } = await req.json()
  const t = String(ticker ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9\-\.=]{1,20}$/.test(t)) {
    return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 })
  }

  const script = path.join(process.cwd(), 'scripts', 'breakout_4h.py')
  try {
    const { stdout } = await execAsync(
      `uv run "${script}" --ticker ${t} --chart --json`,
      { timeout: 90000, env, maxBuffer: 1024 * 1024 * 8 }
    )
    const data = JSON.parse(stdout.trim())
    if (data.error) throw new Error(data.error as string)
    return NextResponse.json(data)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Chart failed: ${msg}` }, { status: 500 })
  }
}
