import { lowBattery, type deviceBattery, type deviceCapabilities } from './device.js'
import type { Energy } from './cloudProtocol.js'

const previousRuns: number[] = []

export const loadPauseMessage = 'Анализ приостановлен из-за длительной нагрузки или низкого заряда. Прогресс сохранён. Можно продолжить с профилем Eco.'
export class AnalysisLoadPause extends Error {
  constructor() { super(loadPauseMessage) }
}

export function waitFor(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class LoadControl {
  private budgetUsed = 0
  private totalActive = 0
  private readonly baselines = new Map<string, { nps: number; samples: number }>()
  private slow = new Map<string, number>()
  private late = 0
  private faultCount = 0
  private reduced = false
  private pauseRequested = false
  private recoverySamples = 0
  private timer?: ReturnType<typeof setInterval>
  private lastSampleAt = 0
  private seriesSince = 0
  private since = 0
  private recordedRun = false

  constructor(private energy: Energy, private device: ReturnType<typeof deviceCapabilities>, private workers: number,
    private battery?: Awaited<ReturnType<typeof deviceBattery>>, private deep = false) {}

  get parallelReduced() { return this.reduced || lowBattery(this.battery) }
  get capacity() { return this.parallelReduced ? 1 : this.workers }
  get shouldPause() {
    return this.pauseRequested || !!this.battery && !this.battery.charging && this.battery.level <= .05
  }

  start() {
    if (!this.device.mobile || this.timer) return
    this.since = performance.now()
    let last = this.since
    this.timer = setInterval(() => {
      const now = performance.now()
      this.late = now - last > 375 ? this.late + 1 : Math.max(0, this.late - 1)
      last = now
      if (this.late >= 3) this.reduced = true
      if (this.late >= 8) this.pauseRequested = true
    }, 250)
  }

  stop() { clearInterval(this.timer); this.timer = undefined }

  workerFailed() {
    this.reduced = true
    if (++this.faultCount >= 2) this.pauseRequested = true
  }

  record(activeMs: number, nps: number, searchType: string) {
    this.budgetUsed += activeMs
    this.totalActive += activeMs
    const now = performance.now()
    if (!this.device.mobile) return
    if (!this.recordedRun && this.totalActive >= 4000) {
      while (previousRuns.length && now - previousRuns[0] > 90_000) previousRuns.shift()
      if (previousRuns.length >= 2) this.reduced = true
      previousRuns.push(now)
      this.recordedRun = true
    }
    if (activeMs < 180 || nps <= 0 || now - this.lastSampleAt < 200) return
    this.lastSampleAt = now
    const baseline = this.baselines.get(searchType) ?? { nps: 0, samples: 0 }
    if (baseline.samples < 5) {
      baseline.nps += (nps - baseline.nps) / ++baseline.samples
      this.baselines.set(searchType, baseline)
      return
    }
    if (now - this.since < 12_000) return
    const previous = this.slow.get(searchType) ?? 0
    const slow = nps < baseline.nps * .58 ? previous + 1 : Math.max(0, previous - 1)
    this.slow.set(searchType, slow)
    if (slow >= 4) this.reduced = true
    if (slow >= 10 && (this.late >= 2 || now - this.since >= 90_000)) this.pauseRequested = true
    if (this.reduced && nps >= baseline.nps * .84 && !this.late && !lowBattery(this.battery)) {
      if (++this.recoverySamples >= 8 && !this.faultCount) {
        this.reduced = false
        this.recoverySamples = 0
        this.slow.clear()
      }
    } else this.recoverySamples = 0
  }

  cooldown() {
    if (!this.device.mobile && this.energy !== 'eco' && !this.reduced) return 0
    const now = performance.now()
    this.seriesSince ||= now
    const eco = this.energy === 'eco' || lowBattery(this.battery)
    const turbo = this.energy === 'turbo' && !this.reduced
    const threshold = eco ? 600 : this.reduced || this.device.constrained ? 850 :
      turbo ? 2500 : this.device.android ? 1200 : 1500
    if (this.budgetUsed < threshold && (this.budgetUsed < 120 || now - this.seriesSince < threshold * 3)) return 0
    const rest = eco ? 450 : this.reduced ? 500 : turbo ? 120 : 350
    // Let a completed deep search cool down in proportion to an unusually long burst.
    const extra = this.device.mobile && this.deep ? Math.min(1200, Math.max(0, this.budgetUsed - threshold) * .15) : 0
    this.budgetUsed = this.seriesSince = 0
    return rest + extra
  }
}
