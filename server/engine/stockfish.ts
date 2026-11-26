import { Worker } from 'node:worker_threads'
import type { EngineOptions, Mode } from '../../src/game.js'
import type { Line } from '../../src/review.js'
import { collectLines, searchParameters, type Position } from '../../src/stockfish.js'
import type { PoolStatus } from '../../src/searchPool.js'
import { cloudEngine } from '../../src/cloudProtocol.js'

export class ServerStockfish {
  private worker?: Worker
  private ready?: Promise<void>
  private position?: string
  private count?: number
  private lastUpdate = -Infinity
  private cache = new Map<string, Line[]>()
  searches = 0
  nodes = 0
  bootMs = 0
  constructor(private signal: AbortSignal, private options: EngineOptions, private report: (sample: PoolStatus) => void) {}

  async cpuMs() {
    const worker = this.worker
    if (!worker) return 0
    try {
      const { user, system } = await worker.cpuUsage()
      return (user + system) / 1000
    } catch (error) {
      // Startup/termination can race this sample. The process counter includes the thread.
      if (worker !== this.worker || (error as NodeJS.ErrnoException).code === 'ERR_WORKER_NOT_RUNNING') return 0
      throw error
    }
  }

  private exchange(commands: string[], done: string, receive?: (line: string) => void) {
    this.signal.throwIfAborted()
    const worker = this.worker!
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        worker.off('message', message)
        worker.off('error', error)
        worker.off('exit', exit)
        this.signal.removeEventListener('abort', abort)
      }
      const message = (line: unknown) => {
        if (typeof line !== 'string') return
        if (line === done || line.startsWith(done + ' ')) { cleanup(); resolve() }
        else receive?.(line)
      }
      const error = (failure: Error) => { cleanup(); reject(failure) }
      const exit = () => error(new Error('Stockfish прервал выполнение.'))
      const abort = () => { cleanup(); reject(this.signal.reason) }
      worker.on('message', message)
      worker.once('error', error)
      worker.once('exit', exit)
      this.signal.addEventListener('abort', abort, { once: true })
      for (const command of commands) worker.postMessage(command)
    })
  }

  private async start() {
    const now = performance.now()
    this.worker = new Worker(new URL('./wasm-worker.cjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 96 } })
    // An idle engine can still fail. The active exchange listens separately.
    this.worker.on('error', () => {})
    await this.exchange(['uci'], 'uciok')
    await this.exchange(['setoption name Hash value 16', 'setoption name UCI_ShowWDL value true', 'isready'], 'readyok')
    this.bootMs = performance.now() - now
  }

  evaluate = async (position: Position, mode: Mode, critical = false, only?: string | readonly string[],
    targetDepth?: number, targetNodes?: number, maxLines?: number, independent = false): Promise<Line[]> => {
    this.signal.throwIfAborted()
    const params = searchParameters(position, mode, this.options, critical, only, targetDepth, targetNodes, maxLines)
    if (params.terminal) return params.terminal
    const { count, depth, nodes, history, choices, turn } = params
    const key = JSON.stringify([history, count, depth, nodes, choices, independent])
    const hit = this.cache.get(key)
    if (hit) return hit
    await (this.ready ??= this.start())

    const commands: string[] = []
    if (this.count !== count) commands.push('setoption name MultiPV value ' + count)
    if (independent || this.position !== history) commands.push('position fen ' + history)
    this.count = count
    this.position = history
    if (independent) await this.exchange(['ucinewgame', 'isready'], 'readyok')
    commands.push('go depth ' + depth + ' nodes ' + nodes + (choices ? ' searchmoves ' + choices : ''))
    const output = collectLines(count, turn, 'Cloud · ' + cloudEngine)
    this.searches++
    await this.exchange(commands, 'bestmove', line => {
      const sample = output.receive(line)
      const now = performance.now()
      if (sample && now - this.lastUpdate >= 250) {
        this.lastUpdate = now
        this.report({ workers: 1, threads: 1, depth: sample.depth, nps: sample.nps })
      }
    })
    const lines = output.results()
    this.nodes += lines[0]?.nodes ?? 0
    this.cache.set(key, lines)
    return lines
  }

  capacity = 1
  priority() { return undefined }
  at() { return this }
  async close() {
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
  }
}
