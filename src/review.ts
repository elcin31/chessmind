import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { Engine, type Position } from './engine'
import { analysisKey, gameMoves, playUci, uci, type Game, type Mode } from './library'
import { explain } from './coach'
import { drawState, positionKey } from './rules'

export type Line = { kind: 'cp' | 'mate'; value: number; wdl?: [number, number, number]; pv: string[]; depth: number; stable?: boolean; engine?: string }
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
  critical: boolean; depth: number; forced: boolean; reliable?: boolean;
  reasons?: string[]; complexity?: 'Низкая' | 'Средняя' | 'Высокая'; sacrificeType?: string; draw?: string
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
function sacrificeEvidence(move: Move, reply: Line) {
  const start = material(new Chess(move.before), move.color)
  const trail = variation(move.after, reply.pv, 10)
  const balances = trail.map(step => material(new Chess(step.after), move.color) - start)
  const conceded = trail.some((step, index) => step.color !== move.color &&
    step.captured && pieceValue[step.captured] >= 3 && balances[index] <= -2)
  if (!conceded) return undefined
  const last = balances.at(-1)!
  if (last > -2) return 'Псевдожертва'
  if (trail.length < 5) return undefined
  return trail.some(step => step.color === move.color && step.san.endsWith('+')) ? 'Тактическая жертва' : 'Позиционная жертва'
}

export function sacrifice(move: Move, reply: Line) {
  const evidence = sacrificeEvidence(move, reply)
  return evidence !== undefined && evidence !== 'Псевдожертва'
}

export function assess(lines: Line[], played: Line, move: Move, after: Line, book: boolean, checked: boolean, baseline = lines[0]) {
  const best = baseline
  const color = move.color
  const wdl = !!best.wdl && !!played.wdl
  const beforeScore = expectation(best, color, wdl)
  const playedScore = expectation(played, color, wdl)
  const loss = Math.max(0, beforeScore - playedScore)
  const cpLoss = best.kind === 'cp' && played.kind === 'cp' ? Math.max(0, fromMover(best, color) - fromMover(played, color)) : null
  const gap = lines[1] ? expectation(lines[0], color, !!lines[0].wdl && !!lines[1].wdl) - expectation(lines[1], color, !!best.wdl && !!lines[1].wdl) : 0
  const top = lines[0].pv[0] === uci(move)
  const forced = move.before !== move.after && new Chess(move.before).moves().length === 1
  const lostMate = best.kind === 'mate' && fromMover(best, color) > 0 && !(played.kind === 'mate' && fromMover(played, color) > 0)
  const allowsMate = played.kind === 'mate' && fromMover(played, color) < 0 && !(best.kind === 'mate' && fromMover(best, color) < 0)
  const equivalent = (cpLoss !== null && cpLoss <= 15 && loss <= 2) ||
    (best.kind === 'mate' && played.kind === 'mate' && Math.sign(best.value) === Math.sign(played.value) && Math.abs(best.value) === Math.abs(played.value))
  const reliable = forced || best.depth >= 12 && played.depth >= 12 && Math.abs(best.depth - played.depth) <= 1
    && best.stable === true && played.stable === true
  const alternatives = lines.slice(1).filter(line => {
    const useWdl = !!lines[0].wdl && !!line.wdl
    return expectation(lines[0], color, useWdl) - expectation(line, color, useWdl) <= 4 &&
      (line.kind === 'mate' && lines[0].kind === 'mate' || line.kind === 'cp' && lines[0].kind === 'cp' && Math.abs(line.value - lines[0].value) <= 35)
  })
  const unique = top && gap >= 18 && beforeScore >= 40 && !forced && !alternatives.length
  const tactical = sacrificeEvidence(move, after)
  const sacrificeType = tactical && (tactical === 'Псевдожертва' ? tactical : forced || gap >= 30 && beforeScore < 65 ?
    'Вынужденная жертва' : loss >= 12 ? 'Ошибочная жертва' : playedScore >= 65 && reliable ? tactical : undefined)
  const strongSacrifice = checked && reliable && after.stable && after.depth >= 12 && !move.captured && !forced &&
    (top || equivalent) && !alternatives.length && loss <= 1 && (cpLoss === null || cpLoss <= 12) &&
    playedScore >= 65 && expectation(after, color) >= 65 && gap >= 5 &&
    (sacrificeType === 'Тактическая жертва' || sacrificeType === 'Позиционная жертва')
  const complexity: Review['complexity'] = forced || alternatives.length >= 2 ? 'Низкая' : gap >= 14 || allowsMate || lostMate || sacrificeType ? 'Высокая' : 'Средняя'
  let category: Category
  if (forced) category = 'best'
  else if (strongSacrifice) category = 'brilliant'
  else if (checked && reliable && lines[1]?.stable && unique) category = 'great'
  else if (allowsMate && (reliable || loss >= 15)) category = 'blunder'
  else if (lostMate && (reliable || loss >= 8) && playedScore <= 85 ||
    beforeScore >= 72 && playedScore <= 61 && loss >= 14) category = 'miss'
  else if (loss >= 26) category = 'blunder'
  else if (loss >= 15 || loss >= 6 && (cpLoss ?? 0) >= 155) category = 'mistake'
  else if (loss >= 7 || loss >= 2 && (cpLoss ?? 0) >= 75) category = 'inaccuracy'
  else if (book && loss <= 5) category = 'book'
  else if (top || equivalent) category = 'best'
  else if (loss <= 3 && (cpLoss ?? 0) <= 48) category = 'excellent'
  else category = 'good'
  const reasons = forced ? ['Единственный легальный ход'] : [
    'Потеря ожидаемого результата: ' + loss.toFixed(1) + ' п. п.',
    ...(cpLoss === null ? [] : ['Потеря оценки: ' + cpLoss + ' cp']),
    ...(lines[1] ? ['Отрыв от второго варианта: ' + Math.max(0, gap).toFixed(1) + ' п. п.'] : []),
    ...(alternatives.length ? ['Близких альтернатив в MultiPV: ' + alternatives.length] : []),
    ...(lostMate ? ['Форсированный мат не найден после сыгранного хода'] : []),
    ...(allowsMate ? ['Сыгранный ход допускает форсированный мат'] : []),
    ...(sacrificeType ? [sacrificeType] : []),
  ]
  return { category, loss, cpLoss, gap, forced, unique, lostMate, allowsMate, reliable, reasons, complexity, sacrificeType }
}

function phaseFor(move: Move, index: number, book: number): Phase {
  const board = new Chess(move.before).board().flat()
  const remaining = board.reduce((total, piece) => piece && piece.type !== 'p' ? total + pieceValue[piece.type] : total, 0)
  if (remaining <= 24) return 'end'
  if (index < Math.max(14, book) && index < 36) return 'opening'
  return 'middle'
}

function positionsFor(game: Game, moves: Move[]) {
  const seen = new Map([[positionKey(game.initial), 1]])
  const played: string[] = []
  const positions: Position[] = [{ initial: game.initial, moves: [], fen: game.initial }]
  for (const move of moves) {
    played.push(uci(move))
    const key = positionKey(move.after)
    const repetitions = (seen.get(key) ?? 0) + 1
    seen.set(key, repetitions)
    positions.push({ initial: game.initial, moves: [...played], fen: move.after, repetitions })
  }
  return positions
}

async function analyzeMove(game: Game, mode: Mode, engine: Engine, index: number, moves: Move[], positions: Position[], root?: Line[], force = false) {
  const move = moves[index]
  const notation = uci(move)
  const terminal = drawState(new Chess(move.after), positions[index + 1].repetitions)
  const next = await engine.evaluate(positions[index + 1], mode)
  let after = next[0]
  let lines = root ?? await engine.evaluate(positions[index], mode)
  async function compare(critical: boolean) {
    const best = lines[0]
    const inMulti = lines.find(line => line.pv[0] === notation)
    if (inMulti || !best.pv.length) return { best, played: inMulti ?? best }
    const search = async (move: string, depth: number) =>
      (await engine.evaluate(positions[index], mode, critical, move, depth))[0]
    let played = await search(notation, best.depth)
    let baseline = await search(best.pv[0], Math.min(best.depth, played.depth))
    if (baseline.depth < played.depth) played = await search(notation, baseline.depth)
    return { best: baseline, played }
  }
  let pair = await compare(false)
  let result = assess(lines, pair.played, move, after, index < game.book, false, pair.best)
  const critical = force || !result.forced && !!lines[0].pv.length &&
    (result.loss >= 7 || result.gap >= 14 || result.lostMate || result.allowsMate || sacrifice(move, after))
  if (critical) {
    lines = await engine.evaluate(positions[index], mode, true)
    pair = await compare(true)
    after = (await engine.evaluate(positions[index + 1], mode, true))[0]
    result = assess(lines, pair.played, move, after, index < game.book, true, pair.best)
  }
  const phase = phaseFor(move, index, game.book)
  const rationale = explain(move, pair.best, pair.played, after, result, phase)
  const review: Review = { color: move.color, index, before: pair.best, played: pair.played, after, lines,
    ...result, ...rationale, accuracy: moveAccuracy(result.loss), phase, critical,
    depth: Math.min(pair.best.depth, pair.played.depth), draw: terminal?.label }
  return { review, next }
}

export async function recheckMove(game: Game, index: number, signal: AbortSignal) {
  const moves = gameMoves(game)
  const engine = new Engine(signal, game.options)
  try { return (await analyzeMove(game, 'professional', engine, index, moves, positionsFor(game, moves), undefined, true)).review }
  finally { engine.close() }
}

export async function analyzeGame(game: Game, mode: Mode, signal: AbortSignal, save: (review: Review[]) => Promise<void>) {
  const moves = gameMoves(game)
  const engine = new Engine(signal, game.options)
  const reviews = game.methodology === 2 && game.mode === mode ? [...(game.reviews ?? [])] : []
  const positions = positionsFor(game, moves)
  let root: Line[] | undefined
  try {
    for (let i = reviews.length; i < moves.length; i++) {
      if (signal.aborted) throw new DOMException('Пауза', 'AbortError')
      const current = await analyzeMove(game, mode, engine, i, moves, positions, root)
      root = current.next
      reviews.push(current.review)
      if (!signal.aborted) await save([...reviews])
    }
  } finally { engine.close() }
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
    acpl: average(cp), esl: average(scored.map(move => move.loss)),
    deviation: arithmetic === undefined ? undefined : Math.sqrt(average(precision.map(value => (value - arithmetic) ** 2))!), cpSample: cp.length, counts, sample: scored.length }
}

export function estimatedRating(game: Game, color: Color, library: Game[]) {
  if (game.source === 'pgn' || !game.time || !game.reviews) return undefined
  const target = summarize(game.reviews, color)
  if (target.sample < 12 || target.accuracy === undefined || target.acpl === undefined) return undefined
  const samples = library.flatMap(item => item.id === game.id || item.source !== game.source || item.time !== game.time ||
    analysisKey(item) !== analysisKey(game) || item.reviews?.length !== item.moves ? [] : (['w', 'b'] as const).flatMap(side => {
      const rating = side === 'w' ? item.whiteElo : item.blackElo
      const stats = summarize(item.reviews!, side)
      if (rating === undefined || stats.sample < 12 || stats.accuracy === undefined || stats.acpl === undefined) return []
      const opponent = side === 'w' ? item.blackElo : item.whiteElo
      const targetOpponent = color === 'w' ? game.blackElo : game.whiteElo
      const complexity = (reviews: Review[], side: Color) => average(reviews.filter(move => move.color === side && !move.forced).map(move => Number(move.complexity === 'Высокая'))) ?? 0
      const distance = Math.hypot((stats.sample - target.sample) / 45,
        opponent && targetOpponent ? (opponent - targetOpponent) / 400 : 0,
        (complexity(item.reviews!, side) - complexity(game.reviews!, color)) * 2,(stats.accuracy - target.accuracy!) / 10, Math.log1p(stats.acpl) - Math.log1p(target.acpl!))
      return [{ rating, distance, id: item.id }]
    }))
  if (new Set(samples.map(sample => sample.id)).size < 10) return undefined
  const seen = new Set<string>()
  const nearest = samples.sort((a, b) => a.distance - b.distance).filter(item => !seen.has(item.id) && seen.add(item.id)).slice(0, 10)
  const ratings = nearest.map(sample => sample.rating).sort((a, b) => a - b)
  return { value: Math.round((ratings[4] + ratings[5]) / 100) * 50, low: ratings[1], high: ratings[8], sample: nearest.length }
}
