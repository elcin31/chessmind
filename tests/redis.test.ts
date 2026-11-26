import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { Redis } from '@upstash/redis'
import { engineHandler } from '../server/engine/function'
import { productionAdmission, RedisAdmission } from '../server/engine/quota'
import { cloudRequest, ending, eventsFrom } from './cloudFixtures'
import { opera } from './fixtures'


test('Production принимает целую пару переменных Upstash или Vercel KV', () => {
  const url = 'https://test-only.upstash.io'
  const token = 'test-only'
  assert.ok(productionAdmission({ UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token }))
  assert.ok(productionAdmission({ KV_REST_API_URL: url, KV_REST_API_TOKEN: token }))
  assert.equal(productionAdmission({ UPSTASH_REDIS_REST_URL: url, KV_REST_API_TOKEN: token }), undefined)
})

const cli = process.env.CM_REDIS_CLI ?? 'redis-cli'
const server = process.env.CM_REDIS_SERVER ?? 'redis-server'
const exec = promisify(execFile)
const res = 30_000
const a = { ip: 'first', session: 'first' }
const b = { ip: 'second', session: 'second' }

test('Redis real: общий бюджет, блокировка, повторы, кэш и отказ Redis', async t => {
  try { await Promise.all([exec(server, ['--version']), exec(cli, ['--version'])]) }
  catch { t.skip('Укажите установленные redis-server и redis-cli для интеграционного теста.'); return }
  const dir = await mkdtemp(join(tmpdir(), 'chessmind-redis-'))
  const socket = join(dir, 'redis.sock')
  const process = spawn(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' })
  const command = async (...args: string[]) => {
    const { stdout } = await exec(cli, ['-s', socket, '--json', ...args])
    return JSON.parse(stdout)
  }
  const redis = {
    eval: (script: string, keys: string[], args: unknown[]) =>
      command('EVAL', script, String(keys.length), ...keys, ...args.map(String)),
    get: (key: string) => command('GET', key),
  } as Pick<Redis, 'eval' | 'get'>
  const done = new Promise<void>(resolve => process.once('exit', () => resolve()))
  let ready = false
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if (await command('PING') === 'PONG') { ready = true; break } } catch { /* Redis is still starting. */ }
      await setTimeout(20)
    }
    assert.ok(ready, 'Redis failed to start')
    await t.test('атомарный допуск двух функций и новый UTC-месяц', async () => {
      let now = Date.now()
      const nextMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1)
      const first = new RedisAdmission(redis, 'test', 2 * res, () => now)
      const second = new RedisAdmission(redis, 'test', 2 * res, () => now)
      const both = await Promise.all([first.reserve('first', res, a), second.reserve('second', res, b)])
      assert.equal(both.filter(item => typeof item !== 'string').length, 1)
      assert.ok(both.includes('busy'))
      const held = both.find(item => typeof item !== 'string')!
      assert.ok('release' in held)
      assert.deepEqual(await new RedisAdmission(redis, 'test', 2 * res).status(), { remainingCpuMs: res, busy: true })
      now = nextMonth + 1_000
      assert.equal(await second.reserve('third', res, b), 'busy')
      await held.release()
      const next = await second.reserve('third', res, b)
      assert.ok(typeof next !== 'string' && 'release' in next)
      await next.release()
      assert.deepEqual(await second.status(), { remainingCpuMs: res, busy: false })
      now = nextMonth - 1_000
      assert.equal(await new RedisAdmission(redis, 'test', res, () => now).reserve('fourth', res, b), 'quota')
    })
    await t.test('истёкшая блокировка не освобождает блокировку нового владельца', async () => {
      await command('FLUSHDB')
      const guard = new RedisAdmission(redis, 'test')
      const first = await guard.reserve('expiring', res, a)
      assert.ok(typeof first !== 'string' && 'release' in first)
      const lock = 'chessmind:{cloud-v1}:lease'
      assert.ok(await command('PTTL', lock) > 30_000)
      await command('PEXPIRE', lock, '10')
      await setTimeout(30)
      assert.equal(await guard.reserve('expiring', res, b), 'duplicate')
      const second = await guard.reserve('next', res, b)
      assert.ok(typeof second !== 'string' && 'release' in second)
      await first.release()
      assert.equal(await new RedisAdmission(redis, 'test').reserve('next2', res, a), 'busy')
      await second.release()
      assert.notEqual(await command('TTL', 'chessmind:{cloud-v1}:repeat:expiring'), -2)
    })
    await t.test('дневной лимит сессии и частота запросов с одной сети', async () => {
      await command('FLUSHDB')
      const guard = new RedisAdmission(redis, 'test')
      const intake = (ip: string, session: string) => guard.preflight(new Request('http://localhost', {
        headers: { 'X-Vercel-Forwarded-For': ip, 'X-ChessMind-Session': session },
      }))
      const uuid = crypto.randomUUID()
      assert.equal(await intake('invalid', uuid), 'invalid')
      for (let i = 0; i < 10; i++) assert.equal(typeof await intake('2001:db8::' + (i + 1), uuid), 'object')
      assert.equal(await intake('192.0.2.1', uuid), 'rate')
      for (let i = 0; i < 2; i++) assert.equal(typeof await intake('2001:db8::10', crypto.randomUUID()), 'object')
      assert.equal(await intake('2001:db8::20', crypto.randomUUID()), 'rate')
      for (let i = 0; i < 3; i++) {
        const permit = await guard.reserve('attempt-' + i, res, { ip: String(i), session: 'same' })
        assert.ok(typeof permit !== 'string' && 'release' in permit)
        await permit.release()
      }
      assert.equal(await guard.reserve('blocked', res, { ip: 'new', session: 'same' }), 'rate')
    })
    await t.test('реальный Stockfish сохраняется в Redis и выдаётся после исчерпания бюджета', async () => {
      await command('FLUSHDB')
      const pgn = ending(opera, 4)
      const upstream = async () => Response.json({ id: 'Abcdef12', variant: 'standard', status: 'mate', pgn })
      const guard = () => new RedisAdmission(redis, 'test', res)
      const handler = () => engineHandler({ admission: guard(), enabled: () => true, request: upstream, loadBook: async () => ({}) })
      const request = async (mode: 'smart' | 'standard') => {
        const base = await cloudRequest(pgn, mode)
        base.headers.set('X-Vercel-Forwarded-For', '192.0.2.2')
        base.headers.set('X-ChessMind-Session', crypto.randomUUID())
        return base
      }
      const result = await eventsFrom(await handler()(await request('smart')))
      assert.equal(result.at(-1)?.type, 'done')
      assert.equal(result.at(-1)?.reviews.at(-1).after.kind, 'mate')
      const cached = await eventsFrom(await handler()(await request('smart')))
      assert.equal(cached[0].cached, true)
      assert.deepEqual(cached.at(-1)?.reviews, result.at(-1)?.reviews)
      assert.equal((await handler()(await request('standard'))).status, 429)
      assert.deepEqual(await guard().status(), { remainingCpuMs: 0, busy: false })
      process.kill()
      await done
      const response = await handler()(await request('smart'))
      assert.equal(response.status, 503)
    })
  } finally {
    process.kill()
    await done
    await rm(dir, { recursive: true, force: true })
  }
})
