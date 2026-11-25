import { deviceConfiguration, Engine, type SearchSpeed } from './engine'
import type { EngineOptions } from './library'
import type { Line } from './review'

type Request = Parameters<Engine['evaluate']>
export type PoolStatus = { workers: number; threads: number; depth?: number; nps: number }
type Work = {
  index: number; args: Request; resolve: (lines: Line[]) => void; reject: (error: unknown) => void
}
type Slot = { engine: Engine; busy?: Work; sample?: SearchSpeed; previous?: number }

let focused: { game: string; ply: number } | undefined
export function focusAnalysis(game: string, ply?: number) {
  if (ply !== undefined) focused = { game, ply }
  else if (focused?.game === game) focused = undefined
}

export async function poolConfiguration(options: EngineOptions) {
  const config = await deviceConfiguration(options)
  const device = navigator as Navigator & { deviceMemory?: number }
  const cores = device.hardwareConcurrency || 2
  const mobile = /Android|iPhone|iPad|Mobile/.test(device.userAgent) || device.platform === 'MacIntel' && device.maxTouchPoints > 1
  const memory = device.deviceMemory
  const enoughMemory = memory === undefined ? !mobile || cores >= 6 : memory >= 4
  const eco = options.energy === 'eco'
  const turbo = options.energy === 'turbo' && memory !== undefined && memory >= 8
  const coreLimit = turbo ? cores - 1 : Math.floor((cores + (mobile ? 0 : 1)) / 2)
  const safe = eco || options.full || !enoughMemory || config.saving ? 1 :
    Math.min(mobile ? turbo ? 3 : 2 : 4, Math.max(1, coreLimit), memory === undefined || memory < 8 ? 2 : 4)
  const requested = options.workers && [1, 2, 3, 4].includes(options.workers)
    ? options.workers : options.threads === 1 ? 1 : safe
  const workers = Math.min(requested, safe)
  const threads = eco || workers > 1 || options.threads === 1 ? 1 : config.threads
  const hash = options.hash ?? (eco ? 16 : workers > 1 ? (mobile || memory === undefined ? 16 : 32) : config.hash)
  return { workers, threads, hash: hash as EngineOptions['hash'] }
}

export class SearchPool {
  private slots: Slot[] = []
  private queue: Work[] = []
  private cache = new Map<string, Promise<Line[]>>()
  private limit: number
  private running = new Set<Promise<void>>()
  private lastPublish = 0
  private throughput = 0
  private bestThroughput = 0
  private slowSamples = 0
  private measured = 0
  private singleFallback = false
  private stopped = false

  constructor(private signal: AbortSignal, private game: string, private options: EngineOptions,
    private config: Awaited<ReturnType<typeof poolConfiguration>>, private publish: (status: PoolStatus) => void) {
    this.limit = config.workers
  }

  get capacity() { return this.limit }

  priority(index: number) {
    return focused?.game === this.game ? Math.min(3, Math.abs(index - focused.ply)) : undefined
  }

  private status() {
    const active = this.slots.filter(slot => slot.busy && slot.engine.activeWorker)
    return {
      workers: active.length, threads: active.reduce((sum, slot) => sum + slot.engine.activeThreads, 0),
      depth: active.reduce((depth, slot) => Math.max(depth, slot.sample?.depth ?? 0), 0) || undefined,
      nps: active.reduce((sum, slot) => sum + (slot.sample?.nps ?? 0), 0),
    }
  }

  private newSlot(): Slot {
    const options = { ...this.options, threads: this.singleFallback ? 1 as const : this.config.threads, hash: this.config.hash }
    const slot: Slot = { engine: new Engine(this.signal, options, sample => {
      slot.sample = sample
      const now = performance.now()
      if (now - this.lastPublish < 250) return
      this.lastPublish = now
      const report = this.status()
      this.publish(report)
      if (this.limit < 2 || report.workers !== this.limit || report.depth === undefined || report.depth < 10 ||
        this.slots.some(item => item.busy && !item.sample)) return
      this.throughput = this.throughput ? .8 * this.throughput + .2 * report.nps : report.nps
      if (++this.measured < 16) return
      this.bestThroughput = Math.max(this.bestThroughput, this.throughput)
      this.slowSamples = this.throughput < .62 * this.bestThroughput ? this.slowSamples + 1 : 0
      if (this.slowSamples >= 12) {
        this.limit--
        this.measured = this.slowSamples = this.bestThroughput = this.throughput = 0
      }
    }, this.game) }
    return slot
  }

  at(index: number): Pick<Engine, 'evaluate'> {
    return { evaluate: (...args: Request) => {
      if (this.signal.aborted || this.stopped) return Promise.reject(this.signal.reason ?? new Error('Остановлен поиск'))
      const [position, ...params] = args
      const key = JSON.stringify([position.initial, position.moves, position.repetitions ?? 1, ...params])
      const existing = this.cache.get(key)
      if (existing) return existing
      const result = new Promise<Line[]>((resolve, reject) => this.queue.push({ index, args, resolve, reject }))
      this.cache.set(key, result)
      void result.then(() => {
        if (this.cache.size > 480) this.cache.delete(this.cache.keys().next().value!)
      }, () => this.cache.delete(key))
      this.dispatch()
      return result
    } }
  }

  private dispatch() {
    if (this.signal.aborted || this.stopped) {
      for (const work of this.queue.splice(0)) work.reject(this.signal.reason ?? new Error('Остановлен поиск'))
      return
    }
    while (this.running.size < this.limit && this.queue.length) {
      let pickup = 0
      if (focused?.game === this.game) {
        for (let i = 1; i < this.queue.length; i++) {
          if (this.priority(this.queue[i].index)! < this.priority(this.queue[pickup].index)!) pickup = i
        }
      }
      const work = this.queue.splice(pickup, 1)[0]
      let slot = this.slots.filter(item => !item.busy)
        .sort((a, b) => Math.abs((a.previous ?? work.index) - work.index) - Math.abs((b.previous ?? work.index) - work.index))[0]
      if (!slot) {
        slot = this.newSlot()
        this.slots.push(slot)
      }
      slot.busy = work
      slot.sample = undefined
      const execute = async () => {
        const started = performance.now()
        try {
          work.resolve(await slot.engine.evaluate(...work.args))
          if (this.options.energy === 'eco' && !this.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(15, (performance.now() - started) / 5))))
          }
        }
        catch (error) {
          if (this.signal.aborted || this.limit === 1) { work.reject(error); return }
          // Memory/worker failure under load. Requeue this search unchanged.
          this.limit = 1
          this.singleFallback = true
          slot.engine.close(false)
          this.slots = this.slots.filter(item => item !== slot)
          this.queue.unshift(work)
        } finally {
          slot.previous = work.index
          slot.busy = undefined
          slot.sample = undefined
          if (this.slots.length > this.limit && this.slots.includes(slot)) {
            slot.engine.close(false)
            await slot.engine.flush()
            this.slots = this.slots.filter(item => item !== slot)
          }
        }
      }
      const run = execute().finally(() => {
        this.running.delete(run)
        this.dispatch()
      })
      this.running.add(run)
    }
  }

  async close() {
    this.stopped = true
    this.dispatch()
    await Promise.allSettled([...this.running])
    for (const [index, slot] of this.slots.entries()) slot.engine.close(index === 0)
    await Promise.all(this.slots.map(slot => slot.engine.flush()))
    this.publish({ workers: 0, threads: 0, nps: 0 })
  }
}
