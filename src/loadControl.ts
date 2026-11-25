import { lowBattery, type deviceBattery } from './device.js'
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
  private readonly baselines = new Map<string, { nps: number; samples: number }>()
  private slow = 0
  private late = 0
  private faultCount = 0
  private reduced = false
  private pauseRequested = false
  private recoverySamples = 0
  private timer?: ReturnType<typeof setInterval>
  private lastSampleAt = 0
  private seriesSince = 0
  private since = 0

  constructor(private energy: Energy, private mobile: boolean, private workers: number,
    private battery?: Awaited<ReturnType<typeof deviceBattery>>) {
    const now = performance.now()
    while (previousRuns.length && now - previousRuns[0] > 90_000) previousRuns.shift()
    this.reduced = mobile && previousRuns.length >= 2
    if (mobile) previousRuns.push(now)
  }

  get capacity() { return this.reduced || lowBattery(this.battery) ? 1 : this.workers }
  get shouldPause() {
    return this.pauseRequested || !!this.battery && !this.battery.charging && this.battery.level <= .05
  }

  start() {
    if (!this.mobile || this.timer) return
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
    const now = performance.now()
    if (!this.mobile || activeMs < 180 || nps <= 0 || now - this.lastSampleAt < 200) return
    this.lastSampleAt = now
    const baseline = this.baselines.get(searchType) ?? { nps: 0, samples: 0 }
    if (baseline.samples < 5) {
      baseline.nps += (nps - baseline.nps) / ++baseline.samples
      this.baselines.set(searchType, baseline)
      return
    }
    if (now - this.since < 12_000) return
    this.slow = nps < baseline.nps * .58 ? this.slow + 1 : Math.max(0, this.slow - 1)
    if (this.slow >= 4) this.reduced = true
    if (this.slow >= 10 && (this.late >= 2 || now - this.since >= 90_000)) this.pauseRequested = true
    if (this.reduced && nps >= baseline.nps * .84 && !this.late && !lowBattery(this.battery)) {
      if (++this.recoverySamples >= 8 && !this.faultCount) {
        this.reduced = false
        this.recoverySamples = this.slow = 0
      }
    } else this.recoverySamples = 0
  }

  cooldown() {
    if (!this.mobile && this.energy !== 'eco' && !this.reduced) return 0
    const now = performance.now()
    this.seriesSince ||= now
    const eco = this.energy === 'eco'
    const conserving = this.reduced || lowBattery(this.battery)
    const threshold = eco ? 500 : conserving ? 850 : this.energy === 'turbo' ? 4000 : 1800
    if (this.budgetUsed < threshold && (this.budgetUsed < 120 || now - this.seriesSince < threshold * 3)) return 0
    this.budgetUsed = this.seriesSince = 0
    return eco ? 400 : conserving ? 500 : this.energy === 'turbo' ? 80 : 180
  }
}
