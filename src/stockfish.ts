import { Chess } from 'chess.js'
import { drawState } from './rules'
import type { EngineOptions, Mode } from './game'
import type { Line } from './review'

export const budgets = {
  quick: { label: 'Express', depth: 10, extra: 3, lines: 2, nodes: 45_000 },
  standard: { label: 'Standard', depth: 15, extra: 4, lines: 3, nodes: 220_000 },
  deep: { label: 'Deep', depth: 19, extra: 5, lines: 3, nodes: 950_000 },
  professional: { label: 'Professional', depth: 23, extra: 6, lines: 4, nodes: 2_000_000 },
}

export type Position = { initial: string; moves: string[]; fen: string; repetitions?: number; legal?: number }
export function searchParameters(position: Position, mode: Mode, options: EngineOptions, critical: boolean,
  only?: string | readonly string[], targetDepth?: number, targetNodes?: number, maxLines?: number) {
  const board = new Chess(position.fen)
  const legal = position.legal ?? board.perft(1)
  const turn = board.turn() === 'w' ? 1 : -1
  if (!legal) return { terminal: [{ kind: board.isCheck() ? 'mate' : 'cp', value: board.isCheck() ? -turn : 0, pv: [], depth: 0,
    wdl: board.isCheck() ? (turn === 1 ? [0, 0, 1000] : [1000, 0, 0]) : [0, 1000, 0] }] as Line[] }
  if (drawState(board, position.repetitions, legal)?.automatic) return { terminal: [{ kind: 'cp', value: 0, pv: [], depth: 0, wdl: [0, 1000, 0] }] as Line[] }

  const choices = typeof only === 'string' ? only : only?.join(' ')
  const budget = budgets[mode]
  const depth = targetDepth ?? budget.depth + (critical ? budget.extra : 0)
  const multiplier = mode === 'professional' ? Math.max(0.5, Math.min(3, options.multiplier ?? 1)) : 1
  const count = typeof only === 'string' ? 1 : Math.min(legal, only?.length ?? maxLines ?? budget.lines)
  const nodesPerSearch = Math.round(budget.nodes * (critical ? 3 : 1) * multiplier)
  const nodes = targetNodes ?? nodesPerSearch * (only && typeof only !== 'string' ? count : 1)
  const history = position.initial + (position.moves.length ? ' moves ' + position.moves.join(' ') : '')
  return { choices, count, nodes, depth, history, turn }
}

export function collectLines(count: number, turn: number, engine: string) {
  const iterations = new Map<number, Map<number, Line>>()
  let totalNodes = 0
  return {
    receive(line: string) {
      if (!line.startsWith('info depth ')) return
      const work = /\bnodes (\d+) nps (\d+)/.exec(line)
      if (work) totalNodes = Math.max(totalNodes, Number(work[1]))
      const match = /^info depth (\d+).*? multipv (\d+) score (cp|mate) (-?\d+)(.*) pv (.+)$/.exec(line)
      if (!match || /lowerbound|upperbound/.test(match[5])) return
      const actualDepth = Number(match[1])
      const multipv = Number(match[2])
      const raw = Number(match[4])
      const wdl = match[5].match(/wdl (\d+) (\d+) (\d+)/)?.slice(1).map(Number) as Line['wdl']
      if (wdl && turn < 0) wdl.reverse()
      const group = iterations.get(actualDepth) ?? new Map<number, Line>()
      group.set(multipv, { kind: match[3] as Line['kind'], value: (match[3] === 'mate' && raw === 0 ? -1 : raw) * turn,
        pv: match[6].trim().split(/\s+/), depth: actualDepth, wdl })
      iterations.set(actualDepth, group)
      return work && { depth: actualDepth, nps: Number(work[2]), engine }
    },
    results() {
      let deepest = 0
      for (const [actual, group] of iterations) if (group.size === count) deepest = Math.max(actual, deepest)
      const ranked = iterations.get(deepest)
      if (!ranked) throw new Error('Stockfish не вернул полный набор вариантов.')
      const previous = iterations.get(deepest - 1)
      return Array.from({ length: count }, (_, index) => {
        const rank = index + 1
        const line = ranked.get(rank)!
        const prior = previous?.size === count ? [...previous.values()].find(item => item.pv[0] === line.pv[0]) : undefined
        const stable = !!prior && prior.kind === line.kind &&
          (line.kind === 'mate' ? Math.sign(prior.value) === Math.sign(line.value) : Math.abs(prior.value - line.value) <= 35) &&
          (rank !== 1 || previous?.get(1)?.pv[0] === line.pv[0])
        return { ...line, stable, engine, nodes: totalNodes }
      })
    },
  }
}
