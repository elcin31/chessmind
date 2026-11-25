import { createHash, createHmac, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Redis } from '@upstash/redis'
import { cloudEngine, cloudLimits, cloudOptions, type CloudMode } from '../../src/cloudProtocol.js'
import { methodologyVersion } from '../../src/game.js'
import { budgets } from '../../src/stockfish.js'
import type { analyzeProgressively } from '../../src/progressive.js'

export type CloudResult = Awaited<ReturnType<typeof analyzeProgressively>>
export type Caller = { ip: string; session: string }
export type Permit = { release(): Promise<void>; save(result: CloudResult): Promise<void> }
export type Denial = 'duplicate' | 'quota' | 'busy' | 'rate'
export type BudgetSnapshot = { remainingCpuMs: number; busy: boolean; intakeClosed?: boolean }
export type Admission = {
  status(): Promise<BudgetSnapshot>
  preflight(request: Request): Promise<Caller | 'invalid' | 'rate'>
  lookup(key: string): Promise<CloudResult | undefined>
  reserve(key: string, cpuMs: number, caller: Caller): Promise<Permit | { cached: CloudResult } | Denial>
}

const prefix = 'chessmind:{cloud-v1}:'
const lock = prefix + 'lease'
const leaseMs = 45_000
const replaySeconds = 15 * 60
const cacheSeconds = 14 * 86_400
const maxCacheBytes = 96 * 1024
const maxResultBytes = 512 * 1024
const requestWindow = 600
const requestsPerDay = 500

const preflightScript = `
  if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 'global' end
  if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 'ip' end
  if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[3]) then return 'session' end
  for i = 1, 3 do
    if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i + 3])) end
  end
  return 'ok'
`

const reserveScript = `
  local cached = redis.call('GET', KEYS[1])
  if cached then return {'cached', cached} end
  if redis.call('EXISTS', KEYS[2]) == 1 then return {'busy'} end
  if redis.call('EXISTS', KEYS[3]) == 1 then return {'duplicate'} end
  local used = tonumber(redis.call('GET', KEYS[4]) or '0')
  if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return {'quota'} end
  if tonumber(redis.call('GET', KEYS[5]) or '0') >= 4 then return {'rate'} end
  if tonumber(redis.call('GET', KEYS[6]) or '0') >= 3 then return {'rate'} end
  redis.call('SET', KEYS[2], ARGV[3], 'PX', tonumber(ARGV[4]))
  redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[5]))
  redis.call('SET', KEYS[4], used + tonumber(ARGV[1]), 'EXAT', tonumber(ARGV[6]))
  for i = 5, 6 do
    if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], 172800) end
  end
  return {'ok'}
`

const releaseScript = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('DEL', KEYS[1])
`
const saveScript = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
`
const statusScript = `
  return {redis.call('GET', KEYS[1]) or '0', redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[3]) or '0'}
`

function billingPeriod(now: number) {
  const date = new Date(now)
  const expiry = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 3) / 1000
  return { month: prefix + 'cpu:' + date.toISOString().slice(0, 7), expiry, day: date.toISOString().slice(0, 10) }
}

// Keep the search revision in this key when changing scheduler or UCI behavior.
export function analysisCacheKey(fingerprint: string, mode: CloudMode, book: number) {
  return createHash('sha256')
    .update(JSON.stringify(['search-1', fingerprint, cloudEngine, 'lite-single', mode, methodologyVersion, cloudOptions, budgets[mode], book]))
    .digest('hex')
}

function decode(value: string | null): CloudResult | undefined {
  if (!value) return
  if (value.length > maxCacheBytes) throw new Error('Invalid cache entry')
  const result = JSON.parse(gunzipSync(Buffer.from(value, 'base64'), { maxOutputLength: maxResultBytes }).toString()) as CloudResult
  if (!Array.isArray(result.reviews) || !Array.isArray(result.draft?.instant) || result.draft.format !== 1) throw new Error('Invalid cache entry')
  return result
}

function network(ip: string) {
  const version = isIP(ip)
  if (version === 4) return ip
  if (version !== 6) return
  const canonical = new URL('http://[' + ip + ']').hostname.slice(1, -1)
  if (canonical.startsWith('::ffff:')) {
    const [first, second] = canonical.slice(7).split(':').map(value => Number.parseInt(value, 16))
    return [first >> 8, first & 255, second >> 8, second & 255].join('.')
  }
  const [head, tail] = canonical.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const expanded = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return expanded.slice(0, 4).join(':') + '/64'
}

export class RedisAdmission implements Admission {
  private blockedUntil = 0
  private intakeClosedUntil = 0
  private rejected = new Map<string, number>()
  private statusSample?: { until: number; result: Promise<BudgetSnapshot> }
  constructor(private redis: Pick<Redis, 'eval' | 'get'>, private secret: string,
    private monthlyCpuMs: number = cloudLimits.monthCpuMs, private clock = Date.now) {}

  private async call<T>(operation: () => Promise<T>) {
    if (Date.now() < this.blockedUntil) throw new Error('Cloud quota unavailable')
    try { return await operation() }
    catch {
      // Back off on transport errors, including Free-tier command exhaustion.
      this.blockedUntil = Date.now() + 10_000
      throw new Error('Cloud quota unavailable')
    }
  }

  status() {
    if (this.statusSample && this.statusSample.until > Date.now()) return this.statusSample.result
    const result = this.call(async () => {
      const { month, day } = billingPeriod(this.clock())
      const [used, active, intake] = await this.redis.eval<unknown[], [string, number, string]>(
        statusScript, [month, lock, prefix + 'intake:' + day], [],
      )
      if (!Number.isSafeInteger(Number(used)) || Number(used) < 0) throw new Error('Invalid cloud budget')
      return { remainingCpuMs: Math.max(0, this.monthlyCpuMs - Number(used)), busy: active === 1,
        ...(Number(intake) >= requestsPerDay ? { intakeClosed: true } : {}) }
    })
    this.statusSample = { until: Date.now() + 60_000, result }
    return result
  }

  async preflight(request: Request) {
    const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for')
    const ip = forwarded && network(forwarded.trim())
    const session = request.headers.get('x-chessmind-session')
    if (!ip || !session || !/^[a-f0-9-]{36}$/i.test(session)) return 'invalid'
    const hash = (kind: string, value: string) => createHmac('sha256', this.secret).update(kind + ':' + value).digest('hex').slice(0, 32)
    const caller = { ip: hash('ip', ip), session: hash('session', session.toLowerCase()) }
    const now = this.clock()
    if (now < this.intakeClosedUntil) return 'rate'
    const { day } = billingPeriod(now)
    const window = Math.floor(now / (requestWindow * 1000))
    const keys = [prefix + 'intake:' + day, prefix + 'intake:ip:' + window + ':' + caller.ip,
      prefix + 'intake:session:' + window + ':' + caller.session]
    if (keys.slice(1).some(key => (this.rejected.get(key) ?? 0) > now)) return 'rate'
    const response = await this.call(() => this.redis.eval<number[], string>(preflightScript, keys,
      [requestsPerDay, 12, 10, 172800, requestWindow * 2, requestWindow * 2]))
    if (response === 'global') this.intakeClosedUntil = Date.parse(day + 'T00:00:00Z') + 86_400_000
    if (response === 'ip' || response === 'session') {
      if (this.rejected.size >= 256) this.rejected.delete(this.rejected.keys().next().value!)
      this.rejected.set(keys[response === 'ip' ? 1 : 2], (window + 1) * requestWindow * 1000)
    }
    if (response !== 'ok') return 'rate'
    return caller
  }

  async lookup(key: string) {
    return decode(await this.call(() => this.redis.get<string>(prefix + 'result:' + key)))
  }

  async reserve(key: string, cpuMs: number, caller: Caller): Promise<Permit | { cached: CloudResult } | Denial> {
    if (cpuMs !== cloudLimits.reservationCpuMs) throw new Error('Invalid reservation')
    const { month, expiry, day } = billingPeriod(this.clock())
    const owner = randomUUID()
    const entry = prefix + 'result:' + key
    const keys = [entry, lock, prefix + 'repeat:' + key, month,
      prefix + 'run:ip:' + day + ':' + caller.ip, prefix + 'run:session:' + day + ':' + caller.session]
    const [state, cached] = await this.call(() => this.redis.eval<Array<number | string>, [string, string?]>(reserveScript, keys,
      [cpuMs, this.monthlyCpuMs, owner, leaseMs, replaySeconds, expiry]))
    if (state === 'cached') {
      const result = decode(cached ?? null)
      if (!result) throw new Error('Invalid cache entry')
      return { cached: result }
    }
    if (state === 'busy' || state === 'duplicate' || state === 'quota' || state === 'rate') return state
    if (state !== 'ok') throw new Error('Cloud quota unavailable')
    this.statusSample = undefined
    return {
      release: async () => {
        try { await this.redis.eval(releaseScript, [lock], [owner]) }
        finally { this.statusSample = undefined }
      },
      save: async result => {
        const bytes = Buffer.from(JSON.stringify(result))
        if (bytes.length > maxResultBytes) return
        const compressed = gzipSync(bytes).toString('base64')
        if (compressed.length > maxCacheBytes) return
        await this.call(() => this.redis.eval(saveScript, [lock, entry], [owner, compressed, cacheSeconds]))
      },
    }
  }
}

function cappedNumber(value: string | undefined, maximum: number) {
  if (value === undefined) return maximum
  return /^\d+$/.test(value) ? Math.min(Number(value), maximum) : 0
}

export function productionAdmission(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token || !/^https:\/\/[a-z0-9-]+\.upstash\.io\/?$/i.test(url)) return
  const concurrent = cappedNumber(env.CHESSMIND_MAX_CONCURRENT_ANALYSES, cloudLimits.concurrent)
  if (concurrent !== 1) return
  const budget = cappedNumber(env.CHESSMIND_MONTHLY_CPU_BUDGET, cloudLimits.monthCpuMs / 1000)
  const redis = new Redis({
    url, token, retry: false, enableAutoPipelining: false, enableTelemetry: false,
    automaticDeserialization: false, signal: () => AbortSignal.timeout(1_800),
  })
  return new RedisAdmission(redis, token, budget * 1000)
}
