import { db, type Mode, type EngineOptions } from './library.js'
import type { Line } from './review.js'

import { collectLines, searchParameters, type Position } from './stockfish.js'
export { budgets } from './stockfish.js'
export type { Position } from './stockfish.js'

export type SearchSpeed = { depth: number; nps: number; engine: string }
type Configuration = { full: boolean; threads: 1 | 2; hash: number; saving?: boolean }
type Session = { worker: Worker; config: Configuration; game?: string; count?: number; position?: string }
type CacheEntry = { lines: Line[]; used: number }
const abortError = () => new DOMException('Анализ приостановлен.', 'AbortError')
const engineName = (config: Configuration) => (config.full ? 'Full' : 'Lite') + ' · ' + config.threads
const sameConfig = (a: Configuration, b: Configuration) => a.full === b.full && a.threads === b.threads && a.hash === b.hash

let idle: { session: Session; expires: ReturnType<typeof setTimeout> } | undefined
function park(session: Session) {
  if (idle) {
    clearTimeout(idle.expires)
    idle.session.worker.terminate()
  }
  if (document.hidden) {
    idle = undefined
    session.worker.terminate()
    return
  }
  idle = { session, expires: setTimeout(() => {
    session.worker.terminate()
    idle = undefined
  }, 25_000) }
}

export async function deviceConfiguration(options: EngineOptions): Promise<Configuration> {
  const device = navigator as Navigator & { deviceMemory?: number; getBattery?: () => Promise<{ charging: boolean; level: number }> }
  const mobile = /Android|iPhone|iPad|Mobile/.test(device.userAgent) || device.platform === 'MacIntel' && device.maxTouchPoints > 1
  const cores = device.hardwareConcurrency || 2
  const memory = device.deviceMemory
  const battery = await device.getBattery?.().catch(() => undefined)
  const saving = !!battery && !battery.charging && battery.level <= 0.2
  const canThread = crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && cores >= 4 &&
    (!mobile || memory === undefined || memory >= 4) && !saving
  return {
    full: options.full === true, saving,
    threads: !options.full && options.energy !== 'eco' && options.threads !== 1 && canThread ? 2 : 1,
    hash: options.hash ?? (options.energy === 'eco' || mobile || saving || memory !== undefined && memory < 4 ? 16 : memory !== undefined && memory >= 8 ? 64 : 32),
  }
}

export class Engine {
  private session?: Session
  private initialized = false
  private onCommand = false
  private lastSample = 0
  private configured?: Configuration
  private readonly recent = new Map<string, Line[]>()
  private readonly pending = new Map<string, CacheEntry>()
  private writing?: Promise<void>
  private writes = 0

  constructor(private signal: AbortSignal, private options: EngineOptions = {},
    private progress?: (sample: SearchSpeed) => void, private game?: string) {}

  get activeThreads() { return this.session?.config.threads ?? 0 }
  get activeWorker() { return !!this.session }

  close(reuse = true) {
    const session = this.session
    this.session = undefined
    if (!session) return
    if (reuse && this.initialized && !this.onCommand) park(session)
    else session.worker.terminate()
    this.initialized = false
  }

  private exchange(commands: string[], done: string, timeout: number, info?: (line: string) => void) {
    if (!this.session || this.signal.aborted) return Promise.reject(abortError())
    const { worker } = this.session
    this.onCommand = true
    return new Promise<void>((resolve, reject) => {
      let stopTimeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(stopTimeout)
        worker.removeEventListener('message', receive)
        worker.removeEventListener('error', fail)
        this.signal.removeEventListener('abort', abort)
      }
      const receive = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        for (const line of event.data.split('\n')) {
          if (line.trim() === done || line.startsWith(done + ' ')) {
            cleanup()
            this.onCommand = false
            if (this.signal.aborted) reject(abortError())
            else resolve()
            return
          }
          if (!this.signal.aborted) info?.(line)
        }
      }
      const fail = () => {
        cleanup()
        this.close()
        reject(this.signal.aborted ? abortError() : new Error('Ошибка Stockfish WASM.'))
      }
      const abort = () => {
        if (done !== 'bestmove') { fail(); return }
        worker.postMessage('stop')
        stopTimeout = setTimeout(fail, 900)
      }
      const timer = setTimeout(() => {
        cleanup()
        this.close()
        reject(new Error('Stockfish не ответил. Можно продолжить анализ с сохранённого хода.'))
      }, timeout)
      worker.addEventListener('message', receive)
      worker.addEventListener('error', fail)
      this.signal.addEventListener('abort', abort, { once: true })
      for (const command of commands) worker.postMessage(command)
    })
  }

  private async initialize(config: Configuration) {
    if (this.session) return
    if (this.signal.aborted) throw abortError()
    if (idle && sameConfig(idle.session.config, config)) {
      const reusable = idle
      clearTimeout(reusable.expires)
      idle = undefined
      this.session = reusable.session
      if (this.game === undefined || this.session.game !== this.game) {
        await this.exchange(['ucinewgame', 'isready'], 'readyok', 10_000)
        this.session.position = undefined
        this.session.game = this.game
      }
    } else {
      if (idle) {
        clearTimeout(idle.expires)
        idle.session.worker.terminate()
        idle = undefined
      }
      const name = '/engine/stockfish-19' + (config.full ? '' : '-lite') + (config.threads === 2 ? '' : '-single') + '.js'
      this.session = { worker: new Worker(name), config, game: this.game }
      await this.exchange(['uci'], 'uciok', config.full ? 90_000 : 25_000)
      await this.exchange([
        'setoption name Hash value ' + config.hash,
        ...(config.threads === 2 ? ['setoption name Threads value 2'] : []),
        'setoption name UCI_ShowWDL value true',
        'isready',
      ], 'readyok', 10_000)
    }
    this.initialized = true
  }

  async evaluate(position: Position, mode: Mode, critical = false, only?: string | readonly string[], targetDepth?: number, targetNodes?: number, maxLines?: number): Promise<Line[]> {
    this.signal.throwIfAborted()
    const parameters = searchParameters(position, mode, this.options, critical, only, targetDepth, targetNodes, maxLines)
    if (parameters.terminal) return parameters.terminal
    const { depth, nodes, count, choices, history, turn } = parameters
    const limit = this.options.cache ?? 3000
    let config = this.configured ??= await deviceConfiguration(this.options)
    const keyFor = () => JSON.stringify(['2.0.1:19.0.1', config.full, config.threads, config.hash, depth, nodes, count, choices, history])
    const cached = async (key: string) => {
      const recent = this.recent.get(key)
      if (recent) return recent
      if (!limit) return undefined
      const record = await (await db).get('positions', key).catch(() => undefined)
      if (!record || Array.isArray(record)) return undefined
      if (Date.now() - record.used > 300_000) this.pending.set(key, { ...record, used: Date.now() })
      return this.remember(key, record.lines)
    }
    let key = keyFor()
    const hit = await cached(key)
    if (hit) return hit
    try { await this.initialize(config) }
    catch (error) {
      if ((!config.full && config.threads === 1) || this.signal.aborted) throw error
      this.close()
      config = this.configured = { ...config, full: false, threads: 1 }
      key = keyFor()
      const fallback = await cached(key)
      if (fallback) return fallback
      await this.initialize(config)
    }

    const session = this.session!
    const commands: string[] = []
    if (session.count !== count) {
      commands.push('setoption name MultiPV value ' + count)
      session.count = count
    }
    if (session.position !== history) {
      commands.push('position fen ' + history)
      session.position = history
    }
    commands.push('go depth ' + depth + ' nodes ' + nodes + (choices ? ' searchmoves ' + choices : ''))
    const output = collectLines(count, turn, engineName(config))
    await this.exchange(commands, 'bestmove', 150_000, line => {
      const sample = output.receive(line)
      if (sample && this.progress && performance.now() - this.lastSample >= 250) {
        this.lastSample = performance.now()
        this.progress(sample)
      }
    })
    const lines = output.results()
    this.remember(key, lines)
    if (limit) {
      this.pending.set(key, { lines, used: Date.now() })
      if (this.pending.size >= 16) void this.flush()
    }
    return lines
  }

  private remember(key: string, lines: Line[]) {
    this.recent.set(key, lines)
    if (this.recent.size > 96) this.recent.delete(this.recent.keys().next().value!)
    return lines
  }

  async flush() {
    if (this.writing) await this.writing
    if (!this.pending.size) return
    const entries = [...this.pending]
    this.pending.clear()
    this.writing = (async () => {
      try {
        const transaction = (await db).transaction('positions', 'readwrite')
        await Promise.all([...entries.map(([key, value]) => transaction.store.put(value, key)), transaction.done])
        const before = this.writes
        this.writes += entries.length
        if (before === 0 || Math.floor(before / 96) !== Math.floor(this.writes / 96)) await trimCache(this.options.cache ?? 3000)
      } catch { /* The optional cache never blocks review. */ }
    })()
    await this.writing
    this.writing = undefined
  }
}

export async function trimCache(limit: number) {
  const transaction = (await db).transaction('positions', 'readwrite')
  if (limit === 0) await transaction.store.clear()
  const legacy = IDBKeyRange.bound('["19', '["19~')
  let excess = await transaction.store.count() - limit
  if (excess > 0) {
    const legacyCount = await transaction.store.count(legacy)
    if (legacyCount) {
      await transaction.store.delete(legacy)
      excess -= legacyCount
    }
    let cursor = excess > 0 ? await transaction.store.index('used').openKeyCursor() : null
    while (cursor && excess-- > 0) {
      await transaction.store.delete(cursor.primaryKey)
      cursor = await cursor.continue()
    }
  }
  await transaction.done
}
