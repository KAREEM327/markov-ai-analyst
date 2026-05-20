import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import path from 'path'

export const maxDuration = 120

const buildPrompt = (ticker: string, data: Record<string, unknown>) => `
You are explaining a market analysis to someone who has never traded or invested before. Use plain, everyday language throughout. No jargon whatsoever. If you must use a term like "Bull" or "Bear," explain it immediately in the same sentence — like you're talking to a curious friend, not a Wall Street analyst.

Here's what this analysis actually measured (so you can explain it in simple terms):
- Every trading day over the last 10 years was labeled one of three things: going up (Bull), going down (Bear), or drifting with no clear direction (Sideways)
- We counted how often the market switches between those states to build a probability map
- The "signal" is a score from -1 to +1 — positive means the math leans toward more up days ahead, negative means more down days, near zero means no clear edge either way
- "Persistence" numbers show how sticky each state is — if Bull persistence is 72%, it means on any given up day, there's a 72% chance tomorrow is also an up day
- The long-run mix shows what this asset looks like on average over years — how much time it spends going up vs. down vs. drifting
- The backtest tested this strategy on 10 years of real history without ever peeking at future data

Complete analysis for ${ticker}:
${JSON.stringify(data, null, 2)}

Respond in exactly TWO sections with these exact headers:

## TL;DR
2–3 sentences max. Write like you're texting someone who just asked "so should I buy ${ticker} right now?" Tell them what mode it's in, what the numbers lean toward, and one specific thing to watch out for. Zero jargon. Be honest and direct.

## Full Breakdown

### What's happening right now
Explain the current regime in plain English. What does it actually mean that ${ticker} is in this state? What would someone watching the price chart see and feel right now — is it bouncing around, grinding quietly, or falling hard?

### Will this keep going or change soon?
Explain the stickiness numbers in plain English. Once the market gets into this mode, how long does it typically stay? Use simple comparisons — like "roughly 9 out of 10 days it stays put" rather than "93% persistence." What does it usually flip into next, and how quickly does that happen?

### How risky is this asset to hold?
Look at the long-run mix numbers. Out of every 100 days over the last decade, how many was this asset falling or drifting vs. actually climbing? Use that to paint a realistic picture of what holding it actually feels like over years — the good stretches and the rough ones.

### What should you actually do?
This is the most important section. Give a specific, plain-English recommendation. Based on the signal score of ${typeof data.signal === 'number' ? (data.signal as number).toFixed(3) : 'N/A'} and everything above:
- Should someone be buying, holding, trimming their position, or staying out right now? Say it directly.
- If someone already owns ${ticker}, what's the smart move?
- If someone is thinking about buying, is now a good entry or should they wait? For what?
- How much of their portfolio makes sense to put here given how risky this asset is historically?
- What specific thing would change this recommendation — what would have to happen for you to flip from this view?

Write this like you're giving honest advice to a friend who just handed you their phone and said "just tell me what to do."

### Track record check
Explain the backtest results without using financial jargon. Translate the performance numbers into something real — like "if you had put in $10,000 and followed this strategy for 10 years, the worst stretch would have dropped your account to roughly $X before recovering." Be honest about whether this is a strong signal or a weak one.

### What this means if you're thinking about options
Options are contracts that let you bet on which direction a price will move — "calls" are a bet it goes up, "puts" are a bet it goes down. Based on what this analysis shows:
- Given the signal of ${typeof data.signal === 'number' ? (data.signal as number).toFixed(3) : 'N/A'}, does the math lean toward calls (betting on more up days) or puts (betting on more down days)? If the signal is near zero, say so plainly.
- Look at how sticky the current regime is. Sticky regimes mean prices tend to keep drifting in one direction without big sudden moves — which favors selling options (collecting premium from people who think a big move is coming). Unstable regimes with lots of flipping favor buying options (because big moves are more likely). Explain which situation ${ticker} is in right now.
- What would have to change in the regime data for the options direction to flip? Be specific — e.g. "if the signal drops below -0.3 and the regime flips to Bear, that's when puts become interesting."

Keep this section beginner-friendly. Explain calls and puts in plain English as if the reader has never heard those words before.

Use real numbers throughout. Write every sentence so a smart 16-year-old could understand it.
`.trim()

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { ticker } = body

  if (!ticker || typeof ticker !== 'string' || !/^[A-Z0-9\-\.=]{1,20}$/i.test(ticker.trim())) {
    return new Response(JSON.stringify({ error: 'Invalid ticker' }), { status: 400 })
  }

  const clean = ticker.trim().toUpperCase()
  const scriptPath = path.join(process.cwd(), 'scripts', 'markov_regime.py')
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }

      try {
        send({ type: 'status', message: `Running Markov analysis on ${clean}…` })

        let analysisData: Record<string, unknown>
        try {
          const output = execSync(`uv run "${scriptPath}" --ticker ${clean} --json --no-hmm`, {
            timeout: 90000,
            encoding: 'utf8',
            cwd: process.cwd(),
            env: {
              ...process.env,
              PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
            },
          })
          analysisData = JSON.parse(output.trim())
          if (analysisData.error) throw new Error(analysisData.error as string)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          send({ type: 'error', message: `Analysis failed: ${msg}` })
          controller.close()
          return
        }

        send({ type: 'analysis', data: analysisData })
        send({ type: 'status', message: 'Claude is reading the data…' })

        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

        const response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          stream: true,
          messages: [{ role: 'user', content: buildPrompt(clean, analysisData) }],
        })

        send({ type: 'status', message: '' })

        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            send({ type: 'text', text: event.delta.text })
          }
        }

        send({ type: 'done' })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        send({ type: 'error', message: msg })
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
