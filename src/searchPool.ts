import { deviceConfiguration, Engine, SearchInterrupted, type SearchSpeed } from './engine.js'
import type { EngineOptions } from './library.js'
import { deviceBattery, deviceCapabilities } from './device.js'
import { AnalysisLoadPause, LoadControl, waitFor } from './loadControl.js'
import type { Energy } from './cloudProtocol.js'
import type { Line } from './review.js'

type Request = Parameters<Engine['evaluate']>
export type PoolStatus = { workers: number; threads: number; depth?: number; nps: number; paused?: boolean; energy?: Energy }
export class PositionInterrupted extends SearchInterrupted {
  constructor(readonly index: number, search: SearchInterrupted) { super(search.line, search.reason) }
}

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
  const device = deviceCapabilities()
  const eco = options.energy === 'eco'
  const turbo = options.energy === 'turbo'
  const mobileLimit = device.constrained || config.saving ? 1 : 2
  const desktopLimit = device.constrained || config.saving ? 1 : turbo && device.cores >= 8 ? 4 : 2
  const safe = eco || options.full || options.threads === 1 ? 1 : device.mobile ? mobileLimit : desktopLimit
  const workers = Math.min(options.workers ?? safe, safe)
  const threads = workers === 1 && (!device.mobile || mobileLimit === 2) ? config.threads : 1
  return { workers, threads, hash: config.hash as EngineOptions['hash'], mobile: device.mobile, battery: await deviceBattery() }
}

export class SearchPool {
  private slots: Slot[] = []
  private queue: Work[] = []
  private cache = new Map<string, Promise<Line[]>>()
  private limit: number
  private running = new Set<Promise<void>>()
  private lastPublish = 0
  private stopped = false
  private cooling = false
  private cooldownDue = 0
  private readonly control: LoadControl

  constructor(private signal: AbortSignal, private game: string, private options: EngineOptions,
    private config: Awaited<ReturnType<typeof poolConfiguration>>, private publish: (status: PoolStatus) => void,
    private retryIndex?: number) {
    this.limit = config.workers
    this.control = new LoadControl(options.energy ?? 'balanced', config.mobile, this.limit, config.battery)
    this.control.start()
  }

  get capacity() { return this.limit }

  priority(index: number) {
    return focused?.game === this.game ? Math.min(3, Math.abs(index - focused.ply)) : undefined
  }

  private status() {
    const active = this.slots.filter(slot => slot.busy && slot.engine.activeWorker)
    return {
      energy: this.options.energy ?? 'balanced', workers: active.length, threads: active.reduce((sum, slot) => sum + slot.engine.activeThreads, 0),
      depth: active.reduce((depth, slot) => Math.max(depth, slot.sample?.depth ?? 0), 0) || undefined,
      nps: active.reduce((sum, slot) => sum + (slot.sample?.nps ?? 0), 0),
    }
  }

  private newSlot(): Slot {
    const options = { ...this.options, threads: this.config.threads, hash: this.config.hash }
    const slot: Slot = { engine: new Engine(this.signal, options, sample => {
      slot.sample = sample
      const now = performance.now()
      if (now - this.lastPublish < 250) return
      this.lastPublish = now
      this.publish(this.status())
    }, this.game) }
    if (this.config.mobile) slot.engine.shouldPauseForLoad = () => this.control.shouldPause
    return slot
  }

  at(index: number): Pick<Engine, 'evaluate'> {
    return { evaluate: (...args: Request) => {
      if (this.signal.aborted || this.stopped) return Promise.reject(this.signal.reason ?? new Error('Остановлен поиск'))
      const [position, ...params] = args
      const key = JSON.stringify([position.initial, position.moves, position.repetitions ?? 1, ...params])
      const existing = this.cache.get(key)
      if (existing) {
        this.cache.delete(key)
        this.cache.set(key, existing)
        return existing
      }
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
    if (this.control.shouldPause) {
      for (const work of this.queue.splice(0)) work.reject(new AnalysisLoadPause())
      return
    }
    if (this.cooling || !this.queue.length) return
    if (this.control.capacity === 1 && this.config.threads === 2) {
      if (this.running.size) return
      const [slot] = this.slots
      if (slot) {
        slot.engine.close(false)
        void slot.engine.flush()
        this.slots = []
      }
      this.config = { ...this.config, threads: 1 }
    }
    if (this.cooldownDue) {
      if (this.running.size) return
      this.cooling = true
      this.publish({ ...this.status(), paused: true })
      void waitFor(this.cooldownDue, this.signal).catch(() => {}).finally(() => {
        this.cooling = false
        this.cooldownDue = 0
        this.publish(this.status())
        this.dispatch()
      })
      return
    }
    while (this.running.size < Math.min(this.limit, this.control.capacity) && this.queue.length) {
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
        try {
          slot.engine.extendTimeLimit = this.retryIndex === work.index
          const lines = await slot.engine.evaluate(...work.args)
          const workTime = slot.engine.lastWork
          if (workTime) {
            const threads = this.running.size * this.config.threads
            this.control.record(workTime.ms, workTime.nps, [threads, workTime.count, workTime.restricted].join(':'))
            this.cooldownDue ||= this.control.cooldown()
          }
          work.resolve(lines)
        } catch (error) {
          if (error instanceof SearchInterrupted) {
            work.reject(new PositionInterrupted(work.index, error))
          } else if (this.signal.aborted) {
            work.reject(error)
          } else {
            const canRetry = this.limit > 1 && this.control.capacity > 1
            this.control.workerFailed()
            if (!canRetry) {
              work.reject(this.control.shouldPause ? new AnalysisLoadPause() : error)
              return
            }
            // Retry an engine failure once with fewer workers, preserving the budget.
            this.limit = 1
            slot.engine.close(false)
            this.slots = this.slots.filter(item => item !== slot)
            await slot.engine.flush()
            this.queue.unshift(work)
          }
        } finally {
          slot.previous = work.index
          slot.busy = undefined
          slot.sample = undefined
          if (this.slots.length > Math.min(this.limit, this.control.capacity) && this.slots.includes(slot)) {
            this.slots = this.slots.filter(item => item !== slot)
            slot.engine.close(false)
            await slot.engine.flush()
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
    this.control.stop()
    this.dispatch()
    await Promise.allSettled([...this.running])
    for (const [index, slot] of this.slots.entries()) slot.engine.close(index === 0)
    await Promise.all(this.slots.map(slot => slot.engine.flush()))
    this.publish({ workers: 0, threads: 0, nps: 0 })
  }
}
