import { Chess } from 'chess.js'
import { db, type Mode } from './library'
import type { Line } from './review'

export const budgets = {
  quick: { label: 'Быстрый', depth: 9, extra: 3, lines: 3, nodes: 80_000 },
  standard: { label: 'Стандартный', depth: 13, extra: 3, lines: 4, nodes: 250_000 },
  deep: { label: 'Глубокий', depth: 17, extra: 4, lines: 5, nodes: 1_200_000 },
}

export type Position = { initial: string; moves: string[]; fen: string }
const abortError = () => new DOMException('Анализ приостановлен.', 'AbortError')

export class Engine {
  private worker?: Worker
  private multi = false
  private failure?: string
  private writes = 0

  constructor(private signal: AbortSignal) {
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
    const start = async (multi: boolean) => {
      this.failure = undefined
      this.multi = multi
      this.worker = new Worker('/engine/stockfish-19-lite' + (multi ? '' : '-single') + '.js')
      this.worker.addEventListener('error', () => { this.failure = 'Ошибка Stockfish WASM.' })
      await this.exchange(['uci'], 'uciok', 25_000)
      await this.exchange([
        'setoption name Hash value 16',
        ...(multi ? ['setoption name Threads value 2'] : []),
        'setoption name UCI_ShowWDL value true',
        'isready',
      ], 'readyok', 10_000)
    }
    try {
      await start(crossOriginIsolated && navigator.hardwareConcurrency >= 4 && typeof SharedArrayBuffer !== 'undefined')
    } catch (error) {
      const fallback = this.multi && !this.signal.aborted
      this.close()
      if (!fallback) throw error
      try { await start(false) } catch (fallbackError) { this.close(); throw fallbackError }
    }
  }

  async evaluate(position: Position, mode: Mode, critical = false, only?: string): Promise<Line[]> {
    if (this.signal.aborted) throw abortError()
    const chess = new Chess(position.fen)
    const legal = chess.moves().length
    const turn = chess.turn() === 'w' ? 1 : -1
    if (!legal) return [{ kind: chess.isCheck() ? 'mate' : 'cp', value: chess.isCheck() ? -turn : 0, pv: [], depth: 0, wdl: chess.isCheck() ? (turn === 1 ? [0, 0, 1000] : [1000, 0, 0]) : [0, 1000, 0] }]
    if (chess.isDraw()) return [{ kind: 'cp', value: 0, pv: [], depth: 0, wdl: [0, 1000, 0] }]
    const budget = budgets[mode]
    const threads = crossOriginIsolated && navigator.hardwareConcurrency >= 4 && typeof SharedArrayBuffer !== 'undefined' ? 2 : 1
    const depth = budget.depth + (critical ? budget.extra : 0)
    const nodes = Math.round(budget.nodes * (critical ? 4 : 1) * (navigator.hardwareConcurrency <= 4 ? 0.7 : 1))
    const count = only ? 1 : Math.min(legal, budget.lines)
    const key = JSON.stringify(['19.0.1-lite', threads, depth, nodes, count, only, position.initial, position.moves])
    const storage = await db
    const cached = await storage.get('positions', key)
    if (cached) return cached
    await this.initialize()
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
    const ranked = [...iterations].sort((a, b) => b[0] - a[0]).find(([, group]) => group.size === count)?.[1]
    if (!ranked) throw new Error('Stockfish не вернул полный набор вариантов.')
    const lines = [...ranked.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
    await storage.put('positions', lines, key)
    if (++this.writes % 200 === 0) {
      const size = await storage.count('positions')
      if (size > 3200) {
        const transaction = storage.transaction('positions', 'readwrite')
        const keys = await transaction.store.getAllKeys(undefined, size - 3000)
        await Promise.all(keys.map(item => transaction.store.delete(item)))
        await transaction.done
      }
    }
    return lines
  }
}
