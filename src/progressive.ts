import { Chess, type Move, type Square } from 'chess.js'
import { adaptiveMode, analysisKey, gameMoves, uci, type Game, type Mode } from './game.js'
import { analyzeMove, expectation, winProbability, moveAccuracy, positionsFor, sacrifice, type Line, type Review } from './review.js'
import type { PoolStatus } from './searchPool.js'
import type { EngineOptions } from './game.js'
import { adaptiveBudgets } from './stockfish.js'
import type { Engine } from './engine.js'

export const stageLabels = {
  instant: 'Предварительный разбор',
  critical: 'Уточнение критических моментов',
  final: 'Завершение разбора',
} as const
export type Stage = keyof typeof stageLabels
export type Draft = {
  format: 1
  previewVersion?: 1
  alternatives?: Array<Line | null>
  instant: Array<Line | null>
  work?: { profile: string; critical: number[]; reviews: Record<number, Review> }
  interrupted?: { profile: string; index: number; reason: 'time' | 'load'; line?: Line }
}

export function validDraft(game: Game) {
  return game.draft?.format === 1 && Array.isArray(game.draft.instant) && game.draft.instant.length === game.moves + 1 ? game.draft : undefined
}

export function hasPreview(game: Game) {
  return validDraft(game)?.instant.every(Boolean) ?? false
}

const forcedMoves = new WeakMap<Move, boolean>()

export function inspectDraft(game: Game, draft: Draft, index: number, moves = gameMoves(game), legal?: number): Review | undefined {
  const move = moves[index]
  const before = draft.instant[index], after = draft.instant[index + 1]
  // Display queued refinement only for the current analysis profile.
  const checked = draft.work?.profile === analysisKey(game) ? draft.work.reviews[index] : undefined
  if (checked) return checked
  if (!move || !before || !after) return
  let forced = !before.pv.length || legal === 1
  if (!forced && legal === undefined) {
    forced = forcedMoves.get(move) ?? new Chess(move.before).perft(1) === 1
    forcedMoves.set(move, forced)
  }
  const matching = before.pv[0] === uci(move)
  const played: Line = matching ? before : { ...after, pv: [uci(move), ...after.pv] }
  const wdl = !!before.wdl && !!played.wdl
  const loss = forced ? 0 : Math.max(0, expectation(before, move.color, wdl) - expectation(played, move.color, wdl))
  const cpLoss = before.kind === 'cp' && played.kind === 'cp' ? Math.max(0, (before.value - played.value) * (move.color === 'w' ? 1 : -1)) : null
  const category = loss >= 26 ? 'blunder' : loss >= 15 ? 'mistake' : loss >= 7 || (cpLoss ?? 0) >= 75 ? 'inaccuracy' : matching ? 'best' : 'good'
  return {
    index, color: move.color, before, after, played, lines: draft.alternatives?.[index] ? [before, draft.alternatives[index]!] : [before], loss, cpLoss, category, preliminary: true,
    accuracy: moveAccuracy(loss), phase: index < Math.max(14, game.book) ? 'opening' : 'middle',
    explanation: 'Предварительная оценка позиции после хода. Ход и альтернативы будут сопоставлены на глубине выбранного режима.',
    critical: loss >= 12 || before.kind !== after.kind, depth: Math.min(before.depth, after.depth), forced,
  }
}

export type StageProgress = {
  stage: Stage; instant: number; checked: number; critical: number; criticalDone: number; moves: number;
}

function criticalPositions(game: Game, draft: Draft, moves: ReturnType<typeof gameMoves>) {
  const scored = moves.flatMap((move, index) => {
    const result = inspectDraft(game, draft, index, moves)
    if (!result || !result.before.pv.length || !result.after.pv.length && result.after.kind === 'cp') return []
    const { before, after, loss, cpLoss } = result
    const mate = before.kind === 'mate' || after.kind === 'mate'
    const uncertain = !before.stable || !after.stable
    const sameLine = before.pv[0] === uci(move)
    const scoredWithWdl = !!before.wdl && !!after.wdl
    const replyTarget = after.pv[0]?.slice(2, 4) as Square | undefined
    const possibleSacrifice = !move.captured && replyTarget && /[nbrq]/.test(new Chess(move.after).get(replyTarget)?.type ?? '') &&
      sacrifice(move, after)
    const rescue = sameLine && !result.forced && expectation(before, move.color) >= 35 && new Chess(move.before).isCheck()
    const swing = Math.abs(expectation(before, move.color, scoredWithWdl) - expectation(after, move.color, scoredWithWdl))
    const risk = Math.max(loss, swing * .55) + (mate ? 23 : 0) + (uncertain ? 6 : 0) +
      Math.min(15, (cpLoss ?? 0) / 12) + (possibleSacrifice ? 18 : 0) + (rescue ? 14 : 0) + (move.captured && uncertain ? 5 : 0)
    return risk >= 12 || mate || !sameLine && uncertain && (cpLoss ?? 0) >= 55 ? [{ index, risk }] : []
  })
  return scored.sort((a, b) => b.risk - a.risk || a.index - b.index)
    .slice(0, Math.max(6, Math.ceil(moves.length / 4))).map(item => item.index)
}

function adaptivePositions(game: Game, mode: 'smart' | 'deep-review', draft: Draft, moves: ReturnType<typeof gameMoves>, positions: ReturnType<typeof positionsFor>) {
  const ranked = moves.flatMap((move, index) => {
    const { before, after, loss, cpLoss, forced } = inspectDraft(game, draft, index, moves, positions[index].legal)!
    if (forced) return []
    const second = draft.alternatives?.[index]
    const gap = second ? expectation(before, move.color, !!before.wdl && !!second.wdl) -
      expectation(second, move.color, !!before.wdl && !!second.wdl) : 0
    const winBefore = winProbability(before, move.color), winAfter = winProbability(after, move.color)
    const swing = winBefore === undefined || winAfter === undefined ? loss : Math.abs(winBefore - winAfter)
    const mating = before.kind === 'mate' || after.kind === 'mate'
    const sacrificeCandidate = sacrifice(move, after)
    const uncertain = !before.stable || !after.stable || !second?.stable
    const different = before.pv[0] !== uci(move)
    const rescue = gap >= 12 || positions[index].facts?.inCheck && (positions[index].legal ?? 0) <= 5
    const risk = Math.max(loss, swing * .6) + Math.min(12, (cpLoss ?? 0) / 12) +
      (uncertain ? 7 : 0) + (rescue ? 13 : 0) + (different ? 3 : 0) +
      (move.captured || move.promotion ? 4 : 0) + Math.min(6, (positions[index].legal ?? 0) / 8)
    return [{ index, risk, essential: mating || sacrificeCandidate || rescue || loss >= 15 }]
  })
  const cap = Math.max(3, Math.ceil(moves.length * (mode === 'smart' ? .18 : .28)))
  return ranked.filter(item => item.essential || item.risk >= 14)
    .sort((a, b) => Number(b.essential) - Number(a.essential) || b.risk - a.risk || a.index - b.index)
    .filter((item, index) => item.essential || index < cap).map(item => item.index)
}

type WorkPool = {
  capacity: number;
  priority(index: number): number | undefined;
  at(index: number): Pick<Engine, 'evaluate'>;
  close(): Promise<void>;
}
type CreatePool = (options: EngineOptions) => Promise<WorkPool>

async function runStage(pool: WorkPool, remaining: number[], signal: AbortSignal, work: (index: number) => Promise<void>) {
  let failed = false
  const loop = async () => {
    try {
      while (remaining.length && !failed) {
        signal.throwIfAborted()
        let next = 0
        const focus = pool.priority(remaining[0])
        if (focus !== undefined) {
          for (let i = 1; i < remaining.length; i++) {
            if (pool.priority(remaining[i])! < pool.priority(remaining[next])!) next = i
          }
        }
        await work(remaining.splice(next, 1)[0])
      }
    } catch (error) {
      failed = true
      throw error
    }
  }
  const results = await Promise.allSettled(Array.from({ length: pool.capacity }, loop))
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

export async function analyzeProgressively(game: Game, mode: Mode, signal: AbortSignal,
  update: (draft: Draft, status: StageProgress) => Promise<void>, telemetry: (status: PoolStatus) => void, previewOnly = false, createPool?: CreatePool) {
  const moves = gameMoves(game)
  if (!moves.length || moves.length !== game.moves || !['1-0', '0-1', '1/2-1/2'].includes(game.result)) {
    throw new Error('Для анализа требуется запись завершённой партии.')
  }
  const positions = positionsFor(game, moves)
  const prior = validDraft(game)
  const adaptive = adaptiveMode(mode)
  const modernPreview = adaptive || previewOnly
  const compatiblePreview = prior && (!modernPreview || prior.previewVersion === 1)
  const profile = analysisKey(game)
  const oldWork = prior?.work?.profile === profile ? prior.work : undefined
  const draft: Draft = {
    format: 1, instant: compatiblePreview ? [...prior.instant] : positions.map(() => null),
    ...(modernPreview ? { previewVersion: 1 as const, alternatives: prior?.previewVersion === 1 && prior.alternatives
      ? [...prior.alternatives] : positions.map(() => null) } : {}),
    ...(oldWork ? { work: { ...oldWork, reviews: { ...oldWork.reviews } } } : {}),
  }
  const options: EngineOptions = !previewOnly && mode === 'lite'
    ? { ...game.options, full: false, threads: 1, workers: 1, hash: 16 }
    : mode === 'deep-review' && (game.options?.multiplier ?? 1) < 1
      ? { ...game.options, multiplier: 1 } : game.options ?? {}
  const retry = prior?.interrupted?.profile === profile ? prior.interrupted : undefined
  draft.interrupted = retry
  const previewOptions = { ...options, full: false }
  const makePool = createPool ?? (async (config: EngineOptions) => {
    const { SearchPool, poolConfiguration } = await import('./searchPool.js')
    return new SearchPool(signal, game.id, config, await poolConfiguration(config), telemetry,
      retry?.reason === 'time' ? retry.index : undefined, !previewOnly && mode === 'deep-review')
  })
  let pool = await makePool(previewOptions)
  let instant = draft.instant.filter(Boolean).length
  let checked = Object.keys(oldWork?.reviews ?? {}).length
  let criticalDone = oldWork?.critical.filter(index => !!oldWork.reviews[index]).length ?? 0
  const publish = (stage: Stage) => update(draft, {
    stage, instant, checked, critical: draft.work?.critical.length ?? 0, criticalDone, moves: moves.length,
  })

  let currentStage: Stage = 'instant'
  try {
    await publish('instant')
    await runStage(pool, positions.map((_, index) => index).filter(index => !draft.instant[index]), signal, async index => {
      const position = positions[index]
      const legal = position.legal ?? 0
      const nodes = Math.min(8500, 3000 + legal * 120)
      const lines = await pool.at(index).evaluate(position, 'quick', false, undefined, 9, nodes, modernPreview ? 2 : 1, modernPreview)
      draft.instant[index] = lines[0]
      if (draft.alternatives) draft.alternatives[index] = lines[1] ?? null
      instant++
      await publish('instant')
    })
    if (previewOnly) return { draft }

    // Full keeps a single worker. The preview always uses the smaller Lite build.
    if (options.full && checked < moves.length) {
      await pool.close()
      pool = await makePool(options)
    }
    if (!draft.work) {
      const candidates = adaptive ? adaptivePositions(game, mode, draft, moves, positions) : criticalPositions(game, draft, moves)
      draft.work = {
        profile, critical: mode === 'lite' ? candidates.slice(0, Math.min(6, Math.ceil(moves.length / 10))) : candidates,
        reviews: Object.fromEntries((game.reviews ?? []).filter(review => !review.preliminary).map(review => [review.index, review])),
      }
      checked = Object.keys(draft.work.reviews).length
      criticalDone = draft.work.critical.filter(index => !!draft.work!.reviews[index]).length
    }
    const work = draft.work
    const verify = async (index: number, stage: 'critical' | 'final') => {
      // The original comparison, mate and sacrifice checks remain in analyzeMove.
      // Priority also rechecks a preview with serious, contradictory evidence.
      const preview = inspectDraft(game, draft, index, moves, positions[index].legal)
      const prioritize = stage === 'critical' && !!preview && (mode === 'lite' || preview.loss >= 23 || preview.before.kind !== preview.after.kind)
      const strong = stage === 'critical' && adaptive
      const searchMode = adaptive ? adaptiveBudgets[mode][strong ? 'critical' : 'base'] : mode
      const engine = pool.at(index)
      const search: Pick<Engine, 'evaluate'> = adaptive
        ? { evaluate: (position, mode, critical, only, depth, nodes, lines) =>
          engine.evaluate(position, mode, critical, only, depth, nodes, lines, true) } : engine
      const previewAfter = draft.instant[index + 1]!
      const options = adaptive ? { preview: previewAfter, strong } : undefined
      let { review } = await analyzeMove(game, searchMode, search, index, moves, positions, undefined, strong, prioritize, options)
      if (adaptive && !strong && !review.forced && review.critical) {
        const upgraded = await analyzeMove(game, adaptiveBudgets[mode].critical, search, index, moves, positions, undefined,
          true, true, { preview: previewAfter, strong: true })
        review = upgraded.review
      }
      work.reviews[index] = review
      checked++
      if (stage === 'critical') criticalDone++
      await publish(stage)
    }

    currentStage = 'critical'
    await publish(currentStage)
    await runStage(pool, work.critical.filter(index => !work.reviews[index]), signal, index => verify(index, 'critical'))
    currentStage = 'final'
    await publish(currentStage)
    await runStage(pool, moves.map((_, index) => index).filter(index => !work.reviews[index]), signal, index => verify(index, 'final'))
    const reviews = moves.map((_, index) => work.reviews[index])
    // The completed pass lives in Game.reviews, separate from the Instant cache.
    return { draft: { ...draft, work: undefined, interrupted: undefined }, reviews }
  } catch (error) {
    if (!createPool && !signal.aborted) {
      const { PositionInterrupted } = await import('./searchPool.js')
      if (error instanceof PositionInterrupted) {
        draft.interrupted = { profile, index: error.index, reason: error.reason, line: error.line }
        await publish(currentStage)
      }
    }
    throw error
  } finally { await pool.close() }
}
