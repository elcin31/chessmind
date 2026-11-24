import { Chess } from 'chess.js'
import { db, type Mode, type EngineOptions } from './library'
import type { Line } from './review'
import { drawState } from './rules'

export const budgets = {
  quick: { label: 'Express', depth: 10, extra: 3, lines: 2, nodes: 45_000 },
  standard: { label: 'Standard', depth: 15, extra: 4, lines: 3, nodes: 220_000 },
  deep: { label: 'Deep', depth: 19, extra: 5, lines: 3, nodes: 950_000 },
  professional: { label: 'Professional', depth: 23, extra: 6, lines: 4, nodes: 2_000_000 },
}

export type Position = { initial: string; moves: string[]; fen: string; repetitions?: number }
const abortError = () => new DOMException('Анализ приостановлен.', 'AbortError')

export class Engine {
  private worker?: Worker
  private multi = false
  private full = false
  private failure?: string
  private writes = 0

  constructor(private signal: AbortSignal, private options: EngineOptions = {}) {
    signal.addEventListener('abort', () => this.close(), { once: true })
  }

  close() {
    this.worker?.terminate()
    this.worker = undefined
  }

  private exchange(commands: string[], done: string, timeout: number, info?: (line: string) => void) {
    return new Promise<void>((resolve, reject) => {
      const worker = this.worker
      if (this.signal.aborted) { reject(abortError()); return }
      if (!worker || this.failure) { reject(new Error(this.failure || 'Движок недоступен.')); return }
      const cleanup = () => {
        clearTimeout(timer)
        worker.removeEventListener('message', receive)
        worker.removeEventListener('error', fail)
        this.signal.removeEventListener('abort', abort)
      }
      const receive = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        for (const line of event.data.split('\n')) {
          if (line.trim() === done || line.startsWith(done + ' ')) {
            cleanup()
            resolve()
            return
          }
          info?.(line)
        }
      }
      const fail = () => { cleanup(); reject(new Error(this.failure || 'Не удалось запустить Stockfish.')) }
      const abort = () => { cleanup(); reject(abortError()) }
      const timer = setTimeout(() => {
        cleanup()
        this.close()
        reject(new Error('Stockfish не ответил. Можно продолжить анализ с сохранённого хода.'))
      }, timeout)
      worker.addEventListener('message', receive)
      worker.addEventListener('error', fail)
      this.signal.addEventListener('abort', abort, { once: true })
      commands.forEach(command => worker.postMessage(command))
    })
  }

  private async initialize() {
    if (this.worker) return
    const start = async (multi: boolean, full = false) => {
      this.failure = undefined
      this.multi = multi
      this.full = full
      this.worker = new Worker('/engine/stockfish-19' + (full ? '' : '-lite') + (multi ? '' : '-single') + '.js')
      this.worker.addEventListener('error', () => { this.failure = 'Ошибка Stockfish WASM.' })
      await this.exchange(['uci'], 'uciok', full ? 90_000 : 25_000)
      await this.exchange([
        'setoption name Hash value ' + (this.options.hash ?? 16),
        ...(multi ? ['setoption name Threads value 2'] : []),
        'setoption name UCI_ShowWDL value true',
        'isready',
      ], 'readyok', 10_000)
    }
    try {
      const full = this.options.full === true
      await start(!full && this.options.threads !== 1 && crossOriginIsolated && navigator.hardwareConcurrency >= 4 && typeof SharedArrayBuffer !== 'undefined', full)
    } catch (error) {
      const fallback = (this.multi || this.full) && !this.signal.aborted
      this.close()
      if (!fallback) throw error
      try { await start(false) } catch (fallbackError) { this.close(); throw fallbackError }
    }
  }

  async evaluate(position: Position, mode: Mode, critical = false, only?: string, targetDepth?: number): Promise<Line[]> {
    if (this.signal.aborted) throw abortError()
    const chess = new Chess(position.fen)
    const legal = chess.moves().length
    const turn = chess.turn() === 'w' ? 1 : -1
    if (!legal) return [{ kind: chess.isCheck() ? 'mate' : 'cp', value: chess.isCheck() ? -turn : 0, pv: [], depth: 0, wdl: chess.isCheck() ? (turn === 1 ? [0, 0, 1000] : [1000, 0, 0]) : [0, 1000, 0] }]
    if (drawState(chess, position.repetitions)?.automatic) return [{ kind: 'cp', value: 0, pv: [], depth: 0, wdl: [0, 1000, 0] }]
    await this.initialize()
    const budget = budgets[mode]
    const depth = targetDepth ?? budget.depth + (critical ? budget.extra : 0)
    const multiplier = mode === 'professional' ? Math.max(0.5, Math.min(3, this.options.multiplier ?? 1)) : 1
    const nodes = Math.round(budget.nodes * (critical ? 3 : 1) * multiplier)
    const count = only ? 1 : Math.min(legal, budget.lines)
    const key = JSON.stringify(['2:19.0.1', this.full, this.multi ? 2 : 1, this.options.hash ?? 16, depth, nodes, count, only, position.initial, position.moves])
    const storage = await db
    const cached = this.options.cache === 0 ? undefined : await storage.get('positions', key)
    if (cached && !Array.isArray(cached)) {
      if (Date.now() - cached.used > 300_000) void storage.put('positions', { ...cached, used: Date.now() }, key).catch(() => {})
      return cached.lines
    }
    const iterations = new Map<number, Map<number, Line>>()
    await this.exchange([
      'setoption name MultiPV value ' + count,
      'position fen ' + position.initial + (position.moves.length ? ' moves ' + position.moves.join(' ') : ''),
      'go depth ' + depth + ' nodes ' + nodes + (only ? ' searchmoves ' + only : ''),
    ], 'bestmove', 90_000, line => {
      const match = line.match(/^info depth (\d+).*? multipv (\d+) score (cp|mate) (-?\d+)(.*) pv (.+)$/)
      if (!match || /lowerbound|upperbound/.test(match[5])) return
      const actualDepth = Number(match[1])
      const multipv = Number(match[2])
      const raw = Number(match[4])
      const wdl = match[5].match(/wdl (\d+) (\d+) (\d+)/)?.slice(1).map(Number) as Line['wdl']
      if (wdl && turn < 0) wdl.reverse()
      const group = iterations.get(actualDepth) ?? new Map<number, Line>()
      group.set(multipv, { kind: match[3] as Line['kind'], value: (match[3] === 'mate' && raw === 0 ? -1 : raw) * turn,
        pv: match[6].trim().split(/\s+/), depth: actualDepth, wdl })
      iterations.set(actualDepth, group)
    })
    const ranked = [...iterations.entries()].sort((a, b) => b[0] - a[0])
      .filter(([, group]) => group.size === count)
    if (!ranked.length) throw new Error('Stockfish не вернул полный набор вариантов.')
    const lines = [...ranked[0][1].entries()].sort((a, b) => a[0] - b[0]).map(([rank, line]) => {
      const previous = ranked.find(([previousDepth]) => previousDepth === line.depth - 1)?.[1]
      const prior = previous && [...previous.values()].find(item => item.pv[0] === line.pv[0])
      const stable = !!prior && prior.kind === line.kind &&
        (line.kind === 'mate' ? Math.sign(prior.value) === Math.sign(line.value) : Math.abs(prior.value - line.value) <= 35) &&
        (rank !== 1 || previous?.get(1)?.pv[0] === line.pv[0])
      return { ...line, stable, engine: (this.full ? 'Full' : 'Lite') + ' · ' + (this.multi ? 2 : 1) }
    })
    const limit = this.options.cache ?? 3000
    try {
      if (limit > 0) await storage.put('positions', { lines, used: Date.now() }, key)
      if (++this.writes % 50 === 1) await trimCache(limit)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error
    }
    return lines
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
