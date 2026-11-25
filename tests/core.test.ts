import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Chess } from 'chess.js'
import { drawState, positionKey } from '../src/rules'
import { assess, expectation, sacrifice, summarize, winProbability, type Line } from '../src/review'
import { analysisKey, db, gameMoves, importAccount, importPgn, parsePgn } from '../src/library'
import { searchParameters } from '../src/stockfish'
import { inspectDraft } from '../src/progressive'
import { annotatedPgn, readClocks } from '../src/pgn'
import { immortal, opera } from './fixtures'

const line = (value: number, move: string, wdl?: Line['wdl']): Line => ({ kind: 'cp', value, pv: [move], depth: 16, stable: true, wdl })

test('энергопрофили сохраняют шахматный бюджет, Mobile Lite ограничен одним вариантом', () => {
  const fen = new Chess().fen()
  const position = { initial: fen, fen, moves: [], legal: 20 }
  for (const mode of ['quick', 'standard', 'deep', 'professional'] as const) {
    for (const critical of [false, true]) {
      const baseline = searchParameters(position, mode, { multiplier: 2 }, critical)
      assert.deepEqual(searchParameters(position, mode, { energy: 'eco', multiplier: 2 }, critical), baseline)
      assert.deepEqual(searchParameters(position, mode, { energy: 'turbo', multiplier: 2 }, critical), baseline)
    }
  }
  const regular = searchParameters(position, 'lite', {}, false)
  const critical = searchParameters(position, 'lite', {}, true)
  assert.deepEqual([regular.depth, regular.nodes, regular.count], [9, 22_000, 1])
  assert.deepEqual([critical.depth, critical.nodes, critical.count], [10, 29_700, 1])
})

test('WDL, ожидание, мат и симметрия цвета', () => {
  const score = line(105, 'e2e4', [550, 400, 50])
  assert.equal(expectation(score), 75)
  assert.equal(expectation(score, 'b'), 25)
  assert.equal(winProbability(score, 'b'), 5)
  assert.equal(winProbability(score, 'w'), 55)
  assert.equal(expectation({ ...score, kind: 'mate', value: -4 }, 'b'), 100)
  assert.equal(expectation(line(0, 'e2e4'), 'w'), 50)
})

test('вынужденные, равноценные, ошибки и неглубокие оценки', () => {
  const chess = new Chess()
  const first = chess.move('d4')
  const best = line(38, 'e2e4')
  const equal = line(30, 'd2d4')
  assert.equal(assess([best, equal], equal, first, equal, false, true).category, 'best')
  const blunder = line(-390, 'd2d4')
  assert.equal(assess([best], blunder, first, blunder, false, true).category, 'blunder')
  const shallow = { ...best, depth: 5 }
  assert.equal(assess([shallow, blunder], shallow, new Chess().move('e4'), shallow, false, true).reliable, false)
  const forced = new Chess('7k/8/5K2/8/8/8/8/7R b - - 0 1')
  assert.equal(forced.moves().length, 1)
  const step = forced.move(forced.moves()[0])
  assert.equal(assess([best], blunder, step, blunder, false, true).forced, true)
  assert.equal(summarize([]).accuracy, undefined)
})

test('упущенный мат и допуск мата, в том числе за чёрных', () => {
  const chess = new Chess()
  chess.move('e4')
  const step = chess.move('c5')
  const mate: Line = { ...line(-3, 'e7e5'), kind: 'mate' }
  const played = line(5, 'c7c5')
  assert.equal(assess([mate], played, step, played, false, true).category, 'miss')
  assert.equal(assess([played], { ...mate, value: 3 }, step, played, false, true).category, 'blunder')
})

test('50/75 ходов, трёхкратное и пятикратное повторение, мат при 150 полуходах', () => {
  const base = '4k3/8/8/8/8/8/8/4K2R w - - '
  assert.equal(drawState(new Chess(base + '100 52'))?.automatic, false)
  assert.equal(drawState(new Chess(base + '150 77'))?.automatic, true)
  assert.equal(drawState(new Chess(), 3)?.automatic, false)
  assert.equal(drawState(new Chess(), 5)?.automatic, true)
  assert.equal(drawState(new Chess('7k/6Q1/6K1/8/8/8/8/8 b - - 150 78')), undefined)
  assert.equal(drawState(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))?.label, 'Пат')
  assert.equal(positionKey(new Chess(base + '100 52').fen()), positionKey(new Chess(base + '150 77').fen()))
})

test('исторический пример жертвы и обычный размен', () => {
  const board = new Chess()
  board.loadPgn(immortal)
  const played = board.history({ verbose: true })
  const step = played.find(move => move.san === 'Bd6')!
  const tail = played.slice(played.indexOf(step) + 1).map(move => move.lan)
  assert.equal(sacrifice(step, { ...line(250, tail[0]), pv: tail }), true)
  const best = line(250, step.lan, [800, 150, 50])
  const other = new Chess(step.before).moves({ verbose: true }).find(move => move.lan !== step.lan)!
  const reply = { ...line(250, tail[0], [800, 150, 50]), pv: tail }
  const options = [best, line(0, other.lan, [100, 800, 100])]
  assert.equal(assess(options, best, step, reply, false, true).category, 'brilliant')
  assert.notEqual(assess(options, best, step, reply, false, false).category, 'brilliant')
  const index = played.indexOf(step)
  const draft = { format: 1 as const, instant: Array<Line | null>(played.length + 1).fill(null) }
  draft.instant[index] = best
  draft.instant[index + 1] = reply
  const preview = inspectDraft({
    id: 'immortal', pgn: immortal, moves: played.length, initial: played[0].before,
    source: 'pgn', book: 0, date: '', result: '1-0', time: '', white: 'Anderssen', black: 'Kieseritzky',
  }, draft, index, played)!
  assert.equal(preview.preliminary, true)
  assert.notEqual(preview.category, 'brilliant')

  const exchange = played.find(move => move.san === 'exf4')!
  assert.equal(sacrifice(exchange, line(20, 'f1c4')), false)
})

test('импорт, пагинация, часы, экспорт, повтор после 429 и сохранённые данные', async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  const withClock = opera.replace('[Result', '[TimeControl "300+2"]\n[Result').replace('1. e4 e5', '1. e4 {[%clk 0:04:57]} e5 {[%emt 0:00:04]}')
  let limited = false
  globalThis.fetch = async input => {
    const url = String(input)
    calls.push(url)
    if (url === '/eco.json') return Response.json({})
    if (url.includes('lichess.org')) {
      if (!limited) { limited = true; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }) }
      return new Response(JSON.stringify({ id: url.includes('until=') ? 'old' : 'new', variant: 'standard', status: 'mate',
        pgn: url.includes('until=') ? immortal : withClock, createdAt: url.includes('until=') ? 800 : 1000 }))
    }
    if (url.endsWith('/archives')) return Response.json({ archives: ['01','02','03','04','05'].map(month =>
      'https://api.chess.com/pub/player/tester/games/2024/' + month) })
    return Response.json({ games: [{ rules: 'chess', pgn: opera, url: 'https://www.chess.com/game/live/123' }] })
  }
  try {
    assert.equal((await importAccount('lichess', 'tester', () => {})).added, 1)
    assert.equal((await importAccount('lichess', 'tester', () => {}, true)).added, 1)
    await importAccount('lichess', 'tester', () => {})
    assert.ok(calls.some(url => url.includes('until=999')))
    assert.ok(calls.some(url => url.includes('since=1001') && url.includes('clocks=true')))
    await importAccount('chesscom', 'tester', () => {})
    await importAccount('chesscom', 'tester', () => {}, true)
    assert.deepEqual(calls.filter(url => /\/2024\//.test(url)).map(url => url.slice(-2)), ['05','04','03','02','01'])
    const game = await parsePgn(withClock)
    assert.equal(readClocks(game.pgn, gameMoves(game), game.time)[0].spent, 5)
    assert.equal(readClocks(game.pgn, gameMoves(game), game.time)[1].spent, 4)
    assert.equal((await parsePgn(annotatedPgn(game))).moves, game.moves)
    const repeated = '[Event "Repeat"]\n[Result "1-0"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 5. e4 1-0'
    const more = await importPgn(new Blob([repeated, '\n\n', withClock]))
    assert.equal(more.added, 1)
    assert.equal(more.skipped, 1)
    assert.equal((await (await db).getAll('games')).length, 3)
    assert.notEqual(analysisKey(game), analysisKey({ ...game, methodology: 2 }))
    await assert.rejects(parsePgn(repeated.replace('5. e4', '5. Nf3 Nf6 6. Ng1 Ng8 7. Nf3 Nf6 8. Ng1 Ng8 9. e4')), /автоматической/)
  } finally { globalThis.fetch = original }
})
