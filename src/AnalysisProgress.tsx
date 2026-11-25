import { useSyncExternalStore } from 'react'
import { stageLabels, type Draft, type StageProgress } from './progressive'
import type { ComputeEngine } from './cloudProtocol'
import type { PoolStatus } from './searchPool'

type Progress = StageProgress & { id: string; eta?: number; search?: PoolStatus; automatic: boolean; compute: ComputeEngine }
let progress: Progress | undefined
const listeners = new Set<() => void>()
function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}
const snapshot = () => progress
let liveReview: { id: string; draft: Draft } | undefined
const reviewListeners = new Set<() => void>()
function subscribeReview(callback: () => void) {
  reviewListeners.add(callback)
  return () => { reviewListeners.delete(callback) }
}

export function updateLiveReview(value?: typeof liveReview) {
  liveReview = value
  for (const listener of reviewListeners) listener()
}

export function useLiveReview(id?: string) {
  return useSyncExternalStore(subscribeReview, () => id && liveReview?.id === id ? liveReview.draft : undefined)
}

export function updateProgress(value?: Progress) {
  progress = value
  for (const listener of listeners) listener()
}

export function AnalysisProgress({ id, initial, checked, total, running, queued }: {
  id: string; initial: number; checked: number; total: number; running: boolean; queued: boolean
}) {
  const current = useSyncExternalStore(subscribe, snapshot)
  const live = running && current?.id === id ? current : undefined
  const prepared = live?.instant ?? initial
  const finalCount = live?.checked ?? checked
  const max = live?.automatic ? total + 1 : total * 2 + 1
  const done = prepared + (live?.automatic ? 0 : finalCount)
  const rate = Math.floor(done * 100 / max)
  return <div className="analysis-progress" data-stage={live?.stage} data-instant={prepared} data-checked={finalCount}
    data-critical-done={live?.criticalDone} data-workers={live?.search?.workers} data-threads={live?.search?.threads}>
    <div className="progress-label">
      <strong>{live ? stageLabels[live.stage] : queued ? 'В очереди' : 'Приостановлено'}</strong>
      <progress aria-label="Ходы, проанализированные Stockfish" max={max} value={done} />
      <span>{rate}%</span>
    </div>
    <div className="analysis-counts">
      {live && <span>{live.compute === 'cloud' ? 'Облачный анализ' : 'На устройстве'}</span>}
      <span>Позиции {prepared}/{total + 1}</span>
      {live && live.critical > 0 && <span>Критические {live.criticalDone}/{live.critical}</span>}
      {!live?.automatic && <span>Проверено ходов {finalCount}/{total}</span>}
      {live?.eta !== undefined && live.eta > 0 && <span>До конца этапа ≈ {live.eta >= 60 ? Math.ceil(live.eta / 60) + ' мин' : live.eta + ' с'}</span>}
    </div>
    {live?.search && live.search.workers > 0 && <details className="analysis-engine" aria-label="Параметры поиска">
      <summary>Stockfish · {live.search.nps.toLocaleString('ru-RU')} узлов/с</summary>
      <div className="analysis-counts"><span>Worker {live.search.workers}</span>
        <span>Потоки {live.search.threads}</span>
        {live.search.depth !== undefined && <span>Достигнутая глубина {live.search.depth}</span>}</div>
    </details>}
  </div>
}
