import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { Engine, type Position } from './engine'
import { gameMoves, playUci, uci, type Game, type Mode } from './library'
import { explain } from './coach'

export type Line = { kind: 'cp' | 'mate'; value: number; wdl?: [number, number, number]; pv: string[]; depth: number }
export const categories = {
  brilliant: ['Блестящий', '!!', '#46a9a0'], great: ['Великолепный', '!', '#6394c7'],
  best: ['Лучший', '★', '#77936b'], excellent: ['Отличный', '✓', '#739065'],
  good: ['Хороший', '✓', '#8b986a'], book: ['Теоретический', 'Book', '#a28865'],
  inaccuracy: ['Неточность', '?!', '#cba040'], mistake: ['Ошибка', '?', '#d18449'],
  miss: ['Упущенная возможность', 'Miss', '#c06c80'], blunder: ['Грубая ошибка', '??', '#d7625c'],
} as const
export type Category = keyof typeof categories
export const errors: Category[] = ['inaccuracy', 'mistake', 'miss', 'blunder']
export const phases = { opening: 'Дебют', middle: 'Миттельшпиль', end: 'Эндшпиль' } as const
export type Phase = keyof typeof phases
export type Review = {
  color: Color; index: number; category: Category; before: Line; played: Line; after: Line; lines: Line[];
  loss: number; cpLoss: number | null; accuracy: number; phase: Phase; explanation: string; motif?: string;
  critical: boolean; depth: number; forced: boolean
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const cpExpectation = (cp: number) => 100 / (1 + Math.exp(-0.00368208 * cp))
export function expectation(line: Line, color: Color = 'w', useWdl = true) {
  const white = line.kind === 'mate' ? (line.value > 0 ? 100 : 0) :
    line.wdl && useWdl ? (line.wdl[0] + line.wdl[1] / 2) / 10 : cpExpectation(line.value)
  return color === 'w' ? white : 100 - white
}
export function winProbability(line: Line, color: Color) {
  if (line.kind === 'mate') return expectation(line, color)
  return line.wdl ? line.wdl[color === 'w' ? 0 : 2] / 10 : undefined
}
export const moveAccuracy = (loss: number) => clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669, 0, 100)
const fromMover = (line: Line, color: Color) => line.value * (color === 'w' ? 1 : -1)
export const evalLabel = (line?: Line) => !line ? '—' : line.kind === 'mate'
  ? (line.value < 0 ? '−' : '+') + 'M' + (line.depth === 0 ? 0 : Math.abs(line.value))
  : (line.value > 0 ? '+' : '') + (line.value / 100).toFixed(2)

export const pieceValue: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
export function material(chess: Chess, color: Color) {
  return chess.board().flat().reduce((score, piece) => piece ? score + pieceValue[piece.type] * (piece.color === color ? 1 : -1) : score, 0)
}
export function variation(fen: string, pv: string[], limit = 12) {
  const chess = new Chess(fen)
  const steps: Move[] = []
  for (const move of pv.slice(0, limit)) {
    try { steps.push(playUci(chess, move)) } catch { break }
  }
  return steps
}
export function sacrifice(move: Move, reply: Line) {
  const start = material(new Chess(move.before), move.color)
  const continuation = variation(move.after, reply.pv, 5)
  return continuation.some(step => step.color !== move.color && !!step.captured && pieceValue[step.captured] >= 3) &&
    continuation.length >= 3 && material(new Chess(continuation.at(-1)!.after), move.color) <= start - 2
}

function assess(lines: Line[], played: Line, move: Move, after: Line, book: boolean, checked: boolean) {
  const best = lines[0]
  const color = move.color
  const wdl = !!best.wdl && !!played.wdl
  const beforeScore = expectation(best, color, wdl)
  const playedScore = expectation(played, color, wdl)
  const loss = Math.max(0, beforeScore - playedScore)
  const cpLoss = best.kind === 'cp' && played.kind === 'cp' ? Math.max(0, fromMover(best, color) - fromMover(played, color)) : null
  const gap = lines[1] ? expectation(best, color, !!best.wdl && !!lines[1].wdl) - expectation(lines[1], color, !!best.wdl && !!lines[1].wdl) : 0
  const top = best.pv[0] === uci(move)
  const forced = move.before !== move.after && new Chess(move.before).moves().length === 1
  const lostMate = best.kind === 'mate' && fromMover(best, color) > 0 && !(played.kind === 'mate' && fromMover(played, color) > 0)
  const allowsMate = played.kind === 'mate' && fromMover(played, color) < 0 && !(best.kind === 'mate' && fromMover(best, color) < 0)
  const equivalent = (cpLoss !== null && cpLoss <= 15 && loss <= 2) ||
    (best.kind === 'mate' && played.kind === 'mate' && Math.sign(best.value) === Math.sign(played.value) && Math.abs(best.value) === Math.abs(played.value))
  const unique = top && gap >= 18 && beforeScore >= 40 && !forced
  const strongSacrifice = !forced && checked && (top || equivalent) && loss <= 1 && (cpLoss === null || cpLoss <= 12)
    && playedScore >= 65 && after.depth >= 12 && expectation(after, color) >= 65 && gap >= 3 && sacrifice(move, after)
  let category: Category
  if (forced) category = 'best'
  else if (strongSacrifice) category = 'brilliant'
  else if (checked && unique) category = 'great'
  else if (allowsMate && loss >= 12 || loss >= 26) category = 'blunder'
  else if (lostMate && loss >= 8 || beforeScore >= 72 && playedScore <= 61 && loss >= 14) category = 'miss'
  else if (loss >= 15 || loss >= 6 && (cpLoss ?? 0) >= 155) category = 'mistake'
  else if (loss >= 7 || loss >= 2 && (cpLoss ?? 0) >= 75) category = 'inaccuracy'
  else if (book && loss <= 5) category = 'book'
  else if (top || equivalent) category = 'best'
  else if (loss <= 3 && (cpLoss ?? 0) <= 48) category = 'excellent'
  else category = 'good'
  return { category, loss, cpLoss, gap, forced, unique, lostMate, allowsMate }
}

function phaseFor(move: Move, index: number, book: number): Phase {
  const board = new Chess(move.before).board().flat()
  const remaining = board.reduce((total, piece) => piece && piece.type !== 'p' ? total + pieceValue[piece.type] : total, 0)
  if (remaining <= 24) return 'end'
  if (index < Math.max(14, book) && index < 36) return 'opening'
  return 'middle'
}

export async function analyzeGame(game: Game, mode: Mode, signal: AbortSignal, save: (review: Review[]) => Promise<void>) {
  const moves = gameMoves(game)
  const engine = new Engine(signal)
  const reviews = game.mode === mode ? [...(game.reviews ?? [])] : []
  const play = new Chess(game.initial)
  const positions: Position[] = [{ initial: game.initial, moves: [], fen: game.initial }]
  for (const move of moves) {
    playUci(play, uci(move))
    positions.push({ initial: game.initial, moves: [...positions.at(-1)!.moves, uci(move)], fen: play.fen() })
  }
  let root: Line[] | undefined
  try {
    for (let i = reviews.length; i < moves.length; i++) {
      if (signal.aborted) throw new DOMException('Пауза', 'AbortError')
      const move = moves[i]
      const playedUci = uci(move)
      let lines = root ?? await engine.evaluate(positions[i], mode)
      // A PGN may continue past a claimable draw. Keep its actual move visible.
      const findPlayed = async (critical: boolean) => {
        if (!lines[0].pv.length) return lines[0]
        return lines.find(line => line.pv[0] === playedUci) ?? (await engine.evaluate(positions[i], mode, critical, playedUci))[0]
      }
      let played = await findPlayed(false)
      root = await engine.evaluate(positions[i + 1], mode)
      let after = root[0]
      let result = assess(lines, played, move, after, i < game.book, false)
      const critical = !result.forced && !!lines[0].pv.length &&
        (result.loss >= 7 || result.gap >= 15 || result.lostMate || result.allowsMate || sacrifice(move, after))
      if (critical) {
        lines = await engine.evaluate(positions[i], mode, true)
        played = await findPlayed(true)
        after = (await engine.evaluate(positions[i + 1], mode, true))[0]
        result = assess(lines, played, move, after, i < game.book, true)
      }
      const phase = phaseFor(move, i, game.book)
      const rationale = explain(move, lines[0], played, after, result, phase)
      const review: Review = { color: move.color, index: i, category: result.category, before: lines[0], played, after,
        lines, loss: result.loss, cpLoss: result.cpLoss, accuracy: moveAccuracy(result.loss), phase, ...rationale,
        critical, depth: lines[0].depth, forced: result.forced }
      reviews.push(review)
      await save([...reviews])
    }
  } finally {
    engine.close()
  }
}

export function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined
}
export function summarize(reviews: Review[], color?: Color, phase?: Phase) {
  const selection = reviews.filter(review => (!color || review.color === color) && (!phase || review.phase === phase))
  const scored = selection.filter(review => !review.forced)
  const precision = scored.map(review => review.accuracy)
  const arithmetic = average(precision)
  const harmonic = precision.length ? (precision.some(value => value === 0) ? 0 : precision.length / precision.reduce((sum, value) => sum + 1 / value, 0)) : undefined
  const counts = Object.fromEntries(Object.keys(categories).map(category => [category, selection.filter(review => review.category === category).length])) as Record<Category, number>
  const cp = scored.flatMap(review => review.cpLoss === null ? [] : [review.cpLoss])
  return { accuracy: arithmetic === undefined || harmonic === undefined ? undefined : (arithmetic + harmonic) / 2,
    acpl: average(cp), cpSample: cp.length, counts, sample: scored.length }
}

export function estimatedRating(game: Game, color: Color, library: Game[]) {
  if (game.source === 'pgn' || !game.time || !game.reviews) return undefined
  const target = summarize(game.reviews, color)
  if (target.sample < 12 || target.accuracy === undefined || target.acpl === undefined) return undefined
  const samples = library.flatMap(item => item.id === game.id || item.source !== game.source || item.time !== game.time ||
    item.mode !== game.mode || item.reviews?.length !== item.moves ? [] : (['w', 'b'] as const).flatMap(side => {
      const rating = side === 'w' ? item.whiteElo : item.blackElo
      const stats = summarize(item.reviews!, side)
      if (rating === undefined || stats.sample < 12 || stats.accuracy === undefined || stats.acpl === undefined) return []
      const distance = Math.hypot((stats.accuracy - target.accuracy!) / 10, Math.log1p(stats.acpl) - Math.log1p(target.acpl!))
      return [{ rating, distance, id: item.id }]
    }))
  if (new Set(samples.map(sample => sample.id)).size < 10) return undefined
  const nearest = samples.sort((a, b) => a.distance - b.distance).slice(0, 10)
  const ratings = nearest.map(sample => sample.rating).sort((a, b) => a - b)
  return { value: Math.round((ratings[4] + ratings[5]) / 100) * 50, low: ratings[1], high: ratings[8], sample: nearest.length }
}
