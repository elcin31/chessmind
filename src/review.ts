import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import type { Engine } from './engine.js'
import { positionFacts, type Position } from './stockfish.js'
import { analysisKey, gameMoves, playUci, uci, type Game, type Mode } from './game.js'
import { explain } from './coach.js'
import { drawState, positionKey } from './rules.js'

export type Line = { kind: 'cp' | 'mate'; value: number; wdl?: [number, number, number]; pv: string[]; depth: number; stable?: boolean; engine?: string; nodes?: number }
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
  critical: boolean; depth: number; forced: boolean; reliable?: boolean; preliminary?: boolean;
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
  if (!reply.pv.length) return undefined
  const trail = variation(move.after, reply.pv, 10)
  const delta = (step: Move) => (step.captured ? pieceValue[step.captured] : 0) + (step.promotion ? pieceValue[step.promotion] - 1 : 0)
  let balance = delta(move)
  let conceded = false
  for (const step of trail) {
    const opponent = step.color !== move.color
    balance += delta(step) * (opponent ? -1 : 1)
    if (opponent && step.captured && pieceValue[step.captured] >= 3 && balance <= -2) conceded = true
  }
  if (!conceded) return undefined
  if (balance > -2) return 'Псевдожертва'
  if (trail.length < 5) return undefined
  return trail.some(step => step.color === move.color && step.san.endsWith('+')) ? 'Тактическая жертва' : 'Позиционная жертва'
}

export function sacrifice(move: Move, reply: Line) {
  const evidence = sacrificeEvidence(move, reply)
  return evidence !== undefined && evidence !== 'Псевдожертва'
}

export function assess(lines: Line[], played: Line, move: Move, after: Line, book: boolean, checked: boolean, baseline = lines[0], legal?: number) {
  const best = baseline
  const color = move.color
  const wdl = !!best.wdl && !!played.wdl
  const beforeScore = expectation(best, color, wdl)
  const playedScore = expectation(played, color, wdl)
  const loss = Math.max(0, beforeScore - playedScore)
  const cpLoss = best.kind === 'cp' && played.kind === 'cp' ? Math.max(0, fromMover(best, color) - fromMover(played, color)) : null
  const compareWdl = !!lines[0].wdl && !!lines[1]?.wdl
  const gap = lines[1] ? expectation(lines[0], color, compareWdl) - expectation(lines[1], color, compareWdl) : 0
  const top = lines[0].pv[0] === uci(move)
  const forced = (legal ?? new Chess(move.before).perft(1)) === 1
  const lostMate = best.kind === 'mate' && fromMover(best, color) > 0 && !(played.kind === 'mate' && fromMover(played, color) > 0)
  const allowsMate = played.kind === 'mate' && fromMover(played, color) < 0 && !(best.kind === 'mate' && fromMover(best, color) < 0)
  const equivalent = (cpLoss !== null && cpLoss <= 15 && loss <= 2) ||
    (best.kind === 'mate' && played.kind === 'mate' && Math.sign(best.value) === Math.sign(played.value) && Math.abs(best.value) === Math.abs(played.value))
  const comparable = beforeScore + 1 >= playedScore &&
    (best.kind !== 'cp' || played.kind !== 'cp' || fromMover(best, color) + 15 >= fromMover(played, color))
  const reliable = forced || comparable && best.depth >= 12 && played.depth >= 12 && Math.abs(best.depth - played.depth) <= 1
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
  else if (checked && reliable && lines[0].stable && lines[1]?.stable && lines[1].depth >= 12 && unique) category = 'great'
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

export function phaseFor(move: Move, index: number, book: number): Phase {
  const board = new Chess(move.before).board().flat()
  const remaining = board.reduce((total, piece) => piece && piece.type !== 'p' ? total + pieceValue[piece.type] : total, 0)
  if (remaining <= 24) return 'end'
  if (index < Math.max(14, book) && index < 36) return 'opening'
  return 'middle'
}

export function positionsFor(game: Game, moves: Move[]) {
  const seen = new Map([[positionKey(game.initial), 1]])
  let initial = game.initial
  let played: string[] = []
  const first = positionFacts(initial)
  const positions: Position[] = [{ initial, moves: [], fen: initial, legal: first.legal, facts: first }]
  for (const move of moves) {
    const key = positionKey(move.after)
    const repetitions = (seen.get(key) ?? 0) + 1
    seen.set(key, repetitions)
    // A pawn move, capture or change in castling rights makes earlier positions
    // unreachable for repetition. The saved FEN retains the clock and move count.
    if (move.piece === 'p' || move.captured || move.before.split(' ')[2] !== move.after.split(' ')[2]) {
      initial = move.after
      played = []
    } else played.push(uci(move))
    const facts = positionFacts(move.after, repetitions)
    positions.push({ initial, moves: [...played], fen: move.after, repetitions, legal: facts.legal, facts })
  }
  return positions
}

type Root = { lines: Line[]; deep: boolean }

export async function analyzeMove(game: Game, mode: Mode, engine: Pick<Engine, 'evaluate'>, index: number,
  moves: Move[], positions: Position[], historyRoot?: Root, force = false, prioritized = false,
  adaptive?: { preview: Line; strong: boolean }) {
  const move = moves[index]
  const notation = uci(move)
  const current = positions[index], child = positions[index + 1]
  const terminal = child.facts ? child.facts.draw : drawState(new Chess(move.after), child.repetitions, child.legal)
  const lite = mode === 'lite'
  let root = historyRoot ?? { lines: await engine.evaluate(current, mode, force), deep: force }
  async function compare() {
    const best = root.lines[0]
    const inMulti = root.lines.find(line => line.pv[0] === notation)
    if (inMulti || !best.pv.length) return { best, played: inMulti ?? best }
    const search = async (move: string, depth: number) => (await engine.evaluate(current, mode, root.deep, move, depth))[0]
    const pairedSearch = () => engine.evaluate(current, mode, root.deep, [best.pv[0], notation], best.depth)
    let paired: Line[] | undefined
    if (adaptive) {
      // Compare both candidates at one root and one completed MultiPV iteration.
      paired = await pairedSearch()
      const baseline = paired.find(line => line.pv[0] === best.pv[0])
      const candidate = paired.find(line => line.pv[0] === notation)
      if (baseline && candidate) return { best: baseline, played: candidate }
    }
    const played = await search(notation, best.depth)
    if (lite) return { best, played }
    const sameKind = played.kind === best.kind
    const mateAgrees = sameKind && best.kind === 'mate' && Math.sign(played.value) === Math.sign(best.value)
    if (!force && played.depth === best.depth && (sameKind && best.kind === 'cp' || mateAgrees)) return { best, played }

    // Lower depth or a different mate assessment needs a common independent check.
    paired ??= await pairedSearch()
    const baseline = paired.find(line => line.pv[0] === best.pv[0])!
    const candidate = paired.find(line => line.pv[0] === notation)!
    const agrees = baseline && candidate && baseline.kind === best.kind &&
      (best.kind === 'mate' ? Math.sign(baseline.value) === Math.sign(best.value) : Math.abs(baseline.value - best.value) <= 35)
    if (agrees && baseline.depth >= best.depth) return { best: baseline, played: candidate }

    const reference = await search(best.pv[0], Math.min(best.depth, played.depth))
    const independent = reference.depth < played.depth ? await search(notation, reference.depth) : played
    return { best: reference, played: independent }
  }
  let pair = await compare()
  const classify = (after: Line, verified: boolean) =>
    assess(root.lines, pair.played, move, after, index < game.book, verified, pair.best, current.legal)
  const verifyChild = force && (!adaptive || mode === 'professional')
  const baseChild = adaptive && !verifyChild
    ? { lines: [adaptive.preview], deep: false }
    : { lines: await engine.evaluate(child, mode, verifyChild), deep: verifyChild }
  const preliminary = classify(baseChild.lines[0], false)
  const childLine = baseChild.lines[0]
  const expressDisagreement = mode === 'quick' && pair.played.depth > 0 && childLine.depth > 0 &&
    (pair.played.kind === 'cp' && childLine.kind === 'cp' &&
      fromMover(pair.played, move.color) - fromMover(childLine, move.color) >= 60 ||
      expectation(pair.played, move.color, !!pair.played.wdl && !!childLine.wdl) -
      expectation(childLine, move.color, !!pair.played.wdl && !!childLine.wdl) >= 10)
  const critical = force || !preliminary.forced && !!root.lines[0].pv.length &&
    (adaptive ? preliminary.loss >= 15 || preliminary.gap >= 18 || preliminary.lostMate || preliminary.allowsMate ||
      sacrifice(move, baseChild.lines[0]) : lite ? prioritized : prioritized || expressDisagreement || preliminary.loss >= 7 || preliminary.gap >= 14 ||
      preliminary.lostMate || preliminary.allowsMate || sacrifice(move, baseChild.lines[0]))
  if (critical && !root.deep && !adaptive) {
    root = { lines: await engine.evaluate(current, mode, true), deep: true }
    pair = await compare()
  }

  let next = baseChild
  let after = next.lines[0]
  if (adaptive?.strong && !next.deep && (after.kind === 'mate' || pair.played.kind === 'mate' || sacrifice(move, after))) {
    next = { lines: await engine.evaluate(child, mode, true), deep: true }
    after = next.lines[0]
  }
  if (!adaptive && critical && !lite && !force && !move.captured && !preliminary.forced) {
    const candidate = classify(after, true)
    const canBeBrilliant = candidate.reliable && candidate.loss <= 1 && (candidate.cpLoss === null || candidate.cpLoss <= 12) &&
      candidate.gap >= 5 && expectation(pair.played, move.color) >= 65 &&
      (candidate.sacrificeType === 'Тактическая жертва' || candidate.sacrificeType === 'Позиционная жертва')
    if (canBeBrilliant) {
      next = { lines: await engine.evaluate(child, mode, true), deep: true }
      after = next.lines[0]
    }
  }
  // The played root line already searched the opponent's response. Use that
  // continuation when it carries a deeper exact iteration than the child search.
  const played = pair.played
  if (!next.deep && played.stable && played.pv[0] === notation && played.pv.length > 1 && played.depth - 1 > after.depth) {
    const matesWithMove = played.kind === 'mate' && (played.value > 0) === (move.color === 'w')
    const value = matesWithMove ? played.value - Math.sign(played.value) : played.value
    if (value !== 0 || played.kind !== 'mate') after = { ...played, value, depth: played.depth - 1, pv: played.pv.slice(1) }
  }
  let result = classify(after, (adaptive ? adaptive.strong : critical) && !lite)
  if (result.category === 'brilliant' && !next.deep) {
    next = { lines: await engine.evaluate(child, mode, true), deep: true }
    after = next.lines[0]
    result = classify(after, critical)
  }
  if (adaptive && !adaptive.strong && !critical && pair.best.kind === 'cp' && pair.played.kind === 'cp' &&
    pair.best.depth >= 9 && pair.best.depth === pair.played.depth && pair.best.stable && pair.played.stable &&
    (result.cpLoss ?? 0) <= 45 && result.loss <= 3 && fromMover(pair.best, move.color) + 15 >= fromMover(pair.played, move.color)) {
    result = { ...result, reliable: true }
  }
  if (adaptive && (!adaptive.strong && (result.lostMate || result.allowsMate || result.loss >= 15) ||
    adaptive.strong && (result.lostMate || result.allowsMate) && !after.stable && !terminal && after.depth !== 0)) {
    result = { ...result, reliable: false }
  }
  const phase = phaseFor(move, index, game.book)
  const rationale = explain(move, pair.best, pair.played, after, result, phase)
  const review: Review = { color: move.color, index, before: pair.best, played: pair.played, after, lines: root.lines,
    ...result, ...rationale, accuracy: moveAccuracy(result.loss), phase, critical,
    depth: Math.min(pair.best.depth, pair.played.depth), draw: terminal?.label }
  return { review, next }
}

export async function recheckMove(game: Game, index: number, signal: AbortSignal) {
  const { SearchPool, poolConfiguration } = await import('./searchPool.js')
  const moves = gameMoves(game)
  const options = { ...game.options, workers: 1 as const }
  const pool = new SearchPool(signal, game.id, options, await poolConfiguration(options), () => {}, undefined, true)
  try { return (await analyzeMove(game, 'professional', pool.at(index), index, moves, positionsFor(game, moves), undefined, true)).review }
  finally { await pool.close() }
}

export function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined
}
export function summarize(reviews: Review[], color?: Color, phase?: Phase) {
  const selection = reviews.filter(review => (!color || review.color === color) && (!phase || review.phase === phase))
  const scored = selection.filter(review => !review.forced && !review.preliminary)
  const precision = scored.map(review => review.accuracy)
  const arithmetic = average(precision)
  const harmonic = precision.length ? (precision.some(value => value === 0) ? 0 : precision.length / precision.reduce((sum, value) => sum + 1 / value, 0)) : undefined
  const counts = Object.fromEntries(Object.keys(categories).map(category => [category, selection.filter(review => review.category === category).length])) as Record<Category, number>
  const cp = scored.flatMap(review => review.cpLoss === null ? [] : [review.cpLoss])
  return { accuracy: arithmetic === undefined || harmonic === undefined ? undefined : (arithmetic + harmonic) / 2,
    acpl: average(cp), esl: average(scored.map(move => move.loss)),
    deviation: arithmetic === undefined ? undefined : Math.sqrt(average(precision.map(value => (value - arithmetic) ** 2))!), cpSample: cp.length, counts, sample: scored.length, limited: scored.filter(review => review.reliable === false).length }
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
