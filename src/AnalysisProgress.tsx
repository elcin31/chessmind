import { useSyncExternalStore } from 'react'
import type { Review } from './review'
import type { SearchSpeed } from './engine'

type Progress = { id: string; done: number; total: number; eta?: number; search?: SearchSpeed }
let progress: Progress | undefined
const listeners = new Set<() => void>()
function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}
const snapshot = () => progress
let liveReview: { id: string; reviews: Review[] } | undefined
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
  return useSyncExternalStore(subscribeReview, () => id && liveReview?.id === id ? liveReview.reviews : undefined)
}

export function updateProgress(value?: Progress) {
  progress = value
  for (const listener of listeners) listener()
}

export function AnalysisProgress({ id, done, total, running, queued }: {
  id: string; done: number; total: number; running: boolean; queued: boolean
}) {
  const current = useSyncExternalStore(subscribe, snapshot)
  const live = running && current?.id === id ? current : undefined
  const count = Math.max(done, live?.done ?? 0)
  const rate = total ? Math.floor(count * 100 / total) : 0
  const time = live?.eta
  return <div className="progress-label">
    <span>{running ? 'Анализ Stockfish' : queued ? 'В очереди' : 'Приостановлено'}</span>
    <progress aria-label="Ходы, проанализированные Stockfish" max={total} value={count} />
    <strong>{rate}% · {count}/{total}</strong>
    {running && <div className="search-progress" aria-label="Параметры поиска">
      <span>{time !== undefined && count < total ? 'Осталось ≈ ' + (time >= 60 ? Math.ceil(time / 60) + ' мин' : time + ' с') : 'Оцениваем время…'}</span>
      {live?.search && <>
        <span>Глубина {live.search.depth}</span>
        <span>{live.search.nps.toLocaleString('ru-RU')} узлов/с</span>
        <span>{live.search.engine} {live.search.engine.endsWith('2') ? 'потока' : 'поток'}</span>
      </>}
    </div>}
  </div>
}
