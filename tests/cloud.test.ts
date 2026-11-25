import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineHandler } from '../server/engine/function'
import { analyzeInCloud } from '../src/cloudClient'
import { cloudLimits } from '../src/cloudProtocol'
import { readGame } from '../src/game'
import { cloudRequest, ending, eventsFrom, sampleAdmission } from './cloudFixtures'
import { opera } from './fixtures'

const sample = ending(opera, 4)
const trusted = (status = 'mate', pgn = sample): typeof fetch => async input => {
  const match = String(input).match(/^https:\/\/lichess\.org\/game\/export\/([A-Za-z0-9]{8})\?/)
  assert.ok(match, 'archive host and identifier are fixed')
  return Response.json({ id: match[1], variant: 'standard', status, pgn })
}
const blankBook = async () => ({})

test('публичное облако закрыто без глобального допуска и при аварийном отключении', async () => {
  const url = 'http://localhost/api/engine/status'
  const absent = engineHandler({ enabled: () => true, request: async () => { assert.fail('network') } })
  assert.equal((await (await absent(new Request(url))).json()).reason, 'quota_guard_unavailable')
  assert.equal((await absent(await cloudRequest(sample, 'quick'))).status, 503)
  const disabled = engineHandler({ admission: sampleAdmission(), enabled: () => false })
  assert.equal((await disabled(await cloudRequest(sample, 'quick'))).status, 503)
})

test('запуск только для подтверждённой архивом записи, строгая форма и бюджет', async () => {
  const admission = sampleAdmission()
  const options = { admission, enabled: () => true, loadBook: blankBook }
  const ongoing = engineHandler({ ...options, request: trusted('started') })
  assert.equal((await ongoing(await cloudRequest(sample, 'quick'))).status, 422)
  const invalid = engineHandler({ ...options, request: trusted('mate', sample.replace('Rd8#', 'Rd9#')) })
  assert.equal((await invalid(await cloudRequest(sample, 'standard'))).status, 422)

  const endpoint = 'http://localhost/api/engine/analyze'
  const tampered = engineHandler({ ...options, request: trusted('mate', opera) })
  assert.equal((await tampered(await cloudRequest(sample, 'quick', 'Abcdef34'))).status, 422)
  const base = await (await cloudRequest(sample, 'quick')).json()
  const post = (data: object) => new Request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  assert.equal((await tampered(post({ ...base, fen: 'startpos' }))).status, 400)
  assert.equal((await tampered(post({ ...base, reference: { platform: 'lichess', id: 'ab\nquit' } }))).status, 400)
  assert.equal((await tampered(post({ ...base, mode: 'professional' }))).status, 422)
  assert.equal((await tampered(post({ ...base, padding: 'x'.repeat(1800) }))).status, 413)
  const quota = engineHandler({ ...options, admission: sampleAdmission(0), request: trusted() })
  const exhausted = await quota(await cloudRequest(sample, 'quick'))
  assert.equal(exhausted.status, 429)
  assert.equal((await exhausted.json()).code, 'quota')
})

test('поток реального Stockfish WASM, повтор и одновременный запрос', async () => {
  const admission = sampleAdmission()
  const handle = engineHandler({ admission, enabled: () => true, request: trusted(), loadBook: blankBook })
  const first = await handle(await cloudRequest(sample, 'quick'))
  assert.equal(first.status, 200)
  assert.equal((await handle(await cloudRequest(sample, 'standard'))).status, 429)
  const events = await eventsFrom(first)
  assert.equal(events[0].type, 'start')
  assert.ok(events.some(event => event.type === 'progress' && event.progress.stage === 'instant'))
  const result = events.at(-1)
  assert.equal(result.type, 'done', JSON.stringify(result))
  assert.equal(result.reviews.length, 4)
  assert.ok(result.reviews.some((item: { depth: number }) => item.depth >= 8))
  assert.equal(result.reviews.at(-1).after.kind, 'mate')
  assert.deepEqual(result.reviews.at(-1).after.wdl, [1000, 0, 0])
  assert.ok(result.metrics.cpuMs > 0)
  const replay = await eventsFrom(await handle(await cloudRequest(sample, 'quick')))
  assert.equal(replay[0].cached, true)
  assert.deepEqual(replay.at(-1).reviews, result.reviews)
  assert.deepEqual(await admission.status(), {
    remainingCpuMs: cloudLimits.monthCpuMs - cloudLimits.reservationCpuMs, busy: false,
  })
})

test('разрыв потока прекращает вычисление и освобождает слот без возврата бюджета', async () => {
  const admission = sampleAdmission()
  const handle = engineHandler({ admission, enabled: () => true, request: trusted(), loadBook: blankBook })
  const response = await handle(await cloudRequest(sample, 'quick'))
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  for (let i = 0; i < 40 && (await admission.status()).busy; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await admission.status(), {
    remainingCpuMs: cloudLimits.monthCpuMs - cloudLimits.reservationCpuMs, busy: false,
  })
  assert.equal((await handle(await cloudRequest(sample, 'quick'))).status, 429)
})

test('клиент принимает проверенный итог с сервера и позиции всех этапов', async ({ mock }) => {
  const handle = engineHandler({ admission: sampleAdmission(), enabled: () => true, request: trusted(), loadBook: blankBook })
  mock.method(globalThis, 'fetch', (path: string, init: RequestInit) =>
    handle(new Request(new URL(path, 'http://localhost'), init)))
  const game = await readGame(sample, blankBook, 'lichess', 'morphy', 'https://lichess.org/Abcdef12')
  const stages = new Set<string>()
  const result = await analyzeInCloud(game, 'standard', new AbortController().signal, async (_draft, progress) => {
    stages.add(progress.stage)
  }, () => {})
  assert.deepEqual([...stages], ['instant', 'critical', 'final'])
  assert.equal(result.reviews.length, game.moves)
  assert.equal(result.reviews.at(-1)?.after.kind, 'mate')
})
