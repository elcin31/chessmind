import { Chess } from 'chess.js'
import type { Admission } from '../server/engine/function'
import { cloudLimits, gameFingerprint, type CloudMode } from '../src/cloudProtocol'
import { readGame } from '../src/game'

export function sampleAdmission(cpuMs: number = cloudLimits.monthCpuMs) {
  const jobs = new Set<string>()
  let busy = false
  const admission: Admission = {
    async status() { return { remainingCpuMs: cpuMs, busy } },
    async reserve(key, cost) {
      if (jobs.has(key)) return 'duplicate'
      if (cpuMs < cost || jobs.size >= cloudLimits.jobsPerMonth) return 'quota'
      if (busy) return 'busy'
      cpuMs -= cost
      jobs.add(key)
      busy = true
      return { async release() { busy = false } }
    },
  }
  return admission
}

export function ending(pgn: string, plies: number) {
  const board = new Chess()
  board.loadPgn(pgn)
  const headers = board.getHeaders()
  const moves = board.history({ verbose: true }).slice(-plies)
  const head = Object.entries({ ...headers, SetUp: '1', FEN: moves[0].before }).map(([key, value]) => '[' + key + ' "' + value + '"]')
  const body = moves.map(move => move.before.split(' ')[5] + (move.color === 'w' ? '. ' : '... ') + move.san)
  return head.join('\n') + '\n\n' + [...body, headers.Result].join(' ')
}

export async function cloudRequest(pgn: string, mode: CloudMode, id = 'Abcdef12', signal?: AbortSignal) {
  const game = await readGame(pgn, async () => ({}))
  const fingerprint = await gameFingerprint(game)
  return new Request('http://localhost/api/engine/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ mode, reference: { platform: 'lichess', id }, fingerprint }),
  })
}

export async function eventsFrom(response: Response) {
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line))
}
