// Local, single-process measurement harness. Admission and archive fixtures
// exercise the handler here only. This script is not a deployment entry point.
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { engineHandler } from '../server/engine/function'
import { cloudRequest, ending, sampleAdmission } from '../tests/cloudFixtures'
import { immortal, opera } from '../tests/fixtures'

const fixtures = { Bench001: opera, Bench002: immortal }
const modes = ['quick', 'standard'] as const
for (const mode of modes) {
  const records = Object.fromEntries(Object.entries(fixtures).map(([id, pgn]) => [id, mode === 'quick' ? pgn : ending(pgn, 4)]))
  const handle = engineHandler({
    admission: sampleAdmission(), enabled: () => true,
    request: async input => {
      const id = new URL(String(input)).pathname.split('/').at(-1)!
      return Response.json({ id, variant: 'standard', status: 'mate', pgn: records[id] })
    },
  })
  const server = createServer(async (request, response) => {
    const abort = new AbortController()
    response.on('close', () => abort.abort())
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const source = new Request(base + request.url, {
      method: request.method, headers: request.headers as HeadersInit,
      body: request.method === 'POST' ? Readable.toWeb(request) : undefined,
      duplex: 'half', signal: abort.signal,
    } as RequestInit)
    const reply = await handle(source)
    response.writeHead(reply.status, Object.fromEntries(reply.headers))
    response.flushHeaders()
    if (reply.body) Readable.fromWeb(reply.body as never).pipe(response)
    else response.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address() as { port: number }
    for (const [id, pgn] of Object.entries(records)) {
      const request = await cloudRequest(pgn, mode, id)
      const body = await request.text()
      const started = performance.now()
      const reply = await fetch('http://127.0.0.1:' + address.port + '/api/engine/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      })
      const ttfbMs = performance.now() - started
      const reader = reply.body!.getReader()
      const decoder = new TextDecoder()
      let pending = '', previewMs: number | undefined
      let final
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        pending += decoder.decode(part.value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop()!
        for (const line of lines) {
          const event = JSON.parse(line)
          if (event.type === 'progress' && event.progress.instant === event.progress.moves + 1) previewMs ??= performance.now() - started
          if (event.type === 'done' || event.type === 'error') final = event
        }
      }
      const reviews = final?.reviews ?? []
      const summary = ['w', 'b'].map(color => {
        const scored = reviews.filter((review: { color: string; forced: boolean }) => review.color === color && !review.forced)
        const average = (xs: number[]) => xs.length ? xs.reduce((a,b) => a + b, 0) / xs.length : null
        const accuracy = scored.map((review: { accuracy: number }) => review.accuracy)
        const arithmetic = average(accuracy)
        const harmonic = accuracy.includes(0) ? 0 : accuracy.length / accuracy.reduce((sum: number, v: number) => sum + 1 / v, 0)
        return { accuracy: arithmetic === null ? null : (arithmetic + harmonic) / 2,
          acpl: average(scored.flatMap((review: { cpLoss: number | null }) => review.cpLoss === null ? [] : [review.cpLoss])) }
      })
      console.log(JSON.stringify({ name: id === 'Bench001' ? 'Morphy' : 'Anderssen', mode, outcome: final?.type,
        previewMs, elapsedMs: performance.now() - started, ttfbMs, ...final?.metrics, summary,
        depths: reviews.map((review: { depth: number }) => review.depth) }))
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
}
