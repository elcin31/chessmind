import { readFile, appendFile } from 'node:fs/promises'
import { ServerStockfish } from '../server/engine/stockfish'
import { readGame, gameMoves, methodologyVersion, type ReviewMode } from '../src/game'
import { analyzeProgressively } from '../src/progressive'
import { analyzeMove, positionsFor, summarize, type Review } from '../src/review'
import { immortal, opera } from '../tests/fixtures'

const output = process.argv[2]
if (!output) throw new Error('node --import tsx scripts/benchmark-quality.ts <output.ndjson>')
const samples = (await readFile('benchmarks/2.0.6-games.pgn', 'utf8')).trim().split(/\n\n(?=\[Event )/)
const mode: ReviewMode = process.env.BENCH_DEEP === '1' ? 'deep-review' : 'smart'
const selected = process.env.BENCH_IDS?.split(',')
const requestedMoves = process.env.BENCH_SANS?.split(',')
const quiet = () => {}
const rank = (review: Review) =>
  (review.category === 'brilliant' || review.category === 'great' ? 100 : 0) +
  (review.before.kind !== review.played.kind ? 50 : 0) + review.loss + (review.reliable ? 5 : 0)

for (const pgn of [...samples, opera, immortal]) {
  const id = pgn.match(/\[Site "https:\/\/lichess.org\/([A-Za-z0-9]+)"\]/)?.[1] ??
    (pgn === opera ? 'opera' : 'immortal')
  if (selected && !selected.includes(id)) continue
  const signal = new AbortController().signal
  const options = { hash: 16, threads: 1 } as const
  const game = { ...await readGame(pgn, async () => ({})), methodology: methodologyVersion, mode, options }
  const engine = new ServerStockfish(signal, options, quiet)
  const start = performance.now()
  const { reviews } = await analyzeProgressively(game, mode, signal, async () => {}, quiet, false, async () => engine)
  if (!reviews) throw new Error('Missing reviews')
  const elapsed = performance.now() - start
  const moves = gameMoves(game), positions = positionsFor(game, moves)
  const ranked = reviews.filter(review => !review.forced).sort((a, b) => rank(b) - rank(a) || a.index - b.index)
  console.log(id, game.moves, (elapsed / 1000).toFixed(1) + 's', 'контроль')
  const verified = []
  const controlSet = requestedMoves ? reviews.filter(review => requestedMoves.includes(moves[review.index].san)) : ranked.slice(0, 1)
  for (const result of controlSet) {
    const control = new ServerStockfish(signal, options, quiet)
    try {
      const { review } = await analyzeMove(game, 'professional', {
        evaluate: (position, profile, critical, only, depth, nodes, lines) =>
          control.evaluate(position, profile, critical, only, depth,
            nodes ?? (position === positions[result.index + 1] ? 1_500_000 : Array.isArray(only) ? 4_000_000 : 3_000_000),
            lines, true),
      }, result.index, moves, positions, undefined, true, false, { preview: result.after, strong: true })
      const compact = ({ before, played, category, cpLoss, loss, depth, reliable }: Review) => ({
        best: before.pv[0], kind: before.kind, mate: before.kind === 'mate' ? before.value : undefined,
        wdl: played.wdl, category, cpLoss, loss, depth, reliable,
      })
      verified.push({ index: result.index, san: moves[result.index].san, result: compact(result), control: compact(review) })
    } finally { await control.close() }
  }
  const result = { id, mode, moves: game.moves, elapsed, searches: engine.searches, nodes: engine.nodes,
    white: summarize(reviews, 'w'), black: summarize(reviews, 'b'), verified }
  await appendFile(output, JSON.stringify(result) + '\n')
  console.log(id, game.moves, (elapsed / 1000).toFixed(1) + 's', verified.map(({ san }) => san).join(' '))
}
