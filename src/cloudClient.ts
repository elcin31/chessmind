import { useEffect, useState } from 'react'
import { cloudEngine, cloudLimits, cloudOptions, gameFingerprint, referenceFor, supportedCloudMode,
  type CloudStatus, type ComputeEngine, type ComputeSource } from './cloudProtocol'
import { analysisKey, methodologyVersion, type Game, type Mode } from './game'
import { stageLabels, type Draft, type StageProgress } from './progressive'
import type { Line, Review } from './review'
import type { PoolStatus } from './searchPool'

const offline: CloudStatus = { available: false, reason: 'offline' }
let currentStatus: Promise<CloudStatus> | undefined
let checkedAt = 0
export function getCloudStatus(force = false): Promise<CloudStatus> {
  if (!navigator.onLine) return Promise.resolve(offline)
  if (!force && currentStatus && Date.now() - checkedAt < 8000) return currentStatus
  checkedAt = Date.now()
  currentStatus = fetch('/api/engine/status', { signal: AbortSignal.timeout(3500) })
    .then(async response => {
      if (!response.ok) throw new Error()
      const value: CloudStatus = await response.json()
      if (typeof value.available !== 'boolean') throw new Error()
      return value
    }).catch(() => ({ available: false, reason: 'network' }))
  return currentStatus
}

export function useCloudStatus(visible: boolean, poll = true) {
  const [status, setStatus] = useState<CloudStatus>()
  useEffect(() => {
    if (!visible) return
    let mounted = true
    const check = (event?: Event) => {
      void getCloudStatus(poll || !!event).then(value => { if (mounted) setStatus(value) })
    }
    check()
    window.addEventListener('online', check)
    window.addEventListener('offline', check)
    const timer = poll ? setInterval(check, 30_000) : undefined
    return () => {
      mounted = false
      clearInterval(timer)
      window.removeEventListener('online', check)
      window.removeEventListener('offline', check)
    }
  }, [visible, poll])
  return status
}

export function cloudBlocker(game: Game | undefined, mode: Mode, status: CloudStatus | undefined) {
  if (!supportedCloudMode(mode)) return mode === 'lite' ? 'Mobile Lite выполняется на устройстве.' : 'Глубокий разбор выполняется на устройстве.'
  if (game && !referenceFor(game)) return 'Для облака нужна партия из официального архива Chess.com или Lichess.'
  if (game && game.moves > cloudLimits.plies[mode]) return 'Облачный лимит для этого режима — ' + cloudLimits.plies[mode] + ' полуходов.'
  if (!status) return 'Проверяем доступность облака…'
  if (!status.available && !status.cacheAvailable) {
    switch (status.reason) {
      case 'quota_guard_unavailable': return 'Облачный анализ ожидает подключения Redis.'
      case 'quota': return 'Облачный лимит исчерпан.'
      case 'rate': return 'Дневной лимит запросов к облаку исчерпан.'
      case 'offline': return 'Сейчас доступен анализ на устройстве.'
      case 'network': return 'Не удалось связаться с облачным движком.'
      case 'unavailable': return 'Облако временно недоступно.'
      default: return 'Облачный анализ выключен.'
    }
  }
  if (status.engine !== cloudEngine || !status.modes?.includes(mode)) return 'Этот режим доступен на устройстве.'
}

export function cloudState(status: CloudStatus | undefined) {
  if (status?.reason === 'quota') return 'Облачный лимит исчерпан. Доступны результаты из кэша.'
  if (status?.busy) return 'Сервер занят. Доступны результаты из кэша.'
  return 'Облачный движок доступен.'
}

export function chooseCompute(source: ComputeSource, game: Game, mode: Mode, status: CloudStatus | undefined): ComputeEngine {
  return source !== 'local' && !cloudBlocker(game, mode, status) ? 'cloud' : 'local'
}

export class CloudUnavailable extends Error {}

let session: string | undefined
function anonymousSession() {
  if (session) return session
  const key = 'chessmind-cloud-session'
  try {
    const value = localStorage.getItem(key)
    if (value && /^[a-f0-9-]{36}$/i.test(value)) return session = value
    session = crypto.randomUUID()
    localStorage.setItem(key, session)
  } catch { session ??= crypto.randomUUID() }
  return session
}

type StreamEvent =
  | { type: 'start'; fingerprint: string; mode: string; engine: string; options: { threads: number; hash: number }; cached?: boolean }
  | { type: 'progress'; draft: Draft; progress: StageProgress }
  | { type: 'telemetry'; sample: PoolStatus }
  | { type: 'done'; draft: Draft; reviews: Review[] }
  | { type: 'error'; message: string }

function validLine(line?: Line): boolean {
  return !!line && (line.kind === 'cp' || line.kind === 'mate') && Number.isFinite(line.value) && Number.isInteger(line.depth) &&
    line.depth >= 0 && Array.isArray(line.pv) && line.pv.length <= 128 && line.pv.every(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) &&
    (!line.wdl || Array.isArray(line.wdl) && line.wdl.length === 3 && line.wdl.every(value => Number.isInteger(value) && value >= 0) &&
      line.wdl.reduce((a, b) => a + b, 0) === 1000)
}
function validReview(review: Review | undefined, index: number) {
  return !!review && review.index === index && !review.preliminary && [review.before, review.after, review.played].every(validLine) &&
    Array.isArray(review.lines) && review.lines.length <= 4 && review.lines.every(validLine) &&
    [review.depth, review.accuracy, review.loss].every(Number.isFinite) && typeof review.explanation === 'string'
}
function validDraft(draft: Draft, moves: number, profile: string) {
  return draft?.format === 1 && draft.instant?.length === moves + 1 && draft.instant.every(line => line === null || validLine(line)) &&
    (!draft.alternatives || draft.previewVersion === 1 && Array.isArray(draft.alternatives) &&
      draft.alternatives.length === moves + 1 && draft.alternatives.every(line => line === null || validLine(line))) &&
    (!draft.work || (draft.work.profile === profile && Array.isArray(draft.work.critical) &&
      draft.work.critical.every(index => Number.isInteger(index) && index >= 0 && index < moves) &&
      draft.work.reviews && Object.entries(draft.work.reviews).every(([key, review]) =>
        Number(key) >= 0 && Number(key) < moves && validReview(review, Number(key)))))
}

function validProgress(progress: StageProgress, moves: number) {
  return progress?.moves === moves && Object.hasOwn(stageLabels, progress.stage) &&
    [progress.instant, progress.checked, progress.critical, progress.criticalDone].every(Number.isInteger) &&
    progress.instant >= 0 && progress.instant <= moves + 1 && progress.checked >= 0 && progress.checked <= moves &&
    progress.critical >= 0 && progress.critical <= moves && progress.criticalDone >= 0 && progress.criticalDone <= progress.critical
}

export async function analyzeInCloud(game: Game, mode: Mode, signal: AbortSignal,
  update: (draft: Draft, status: StageProgress) => Promise<void>, telemetry: (sample: PoolStatus) => void) {
  const reference = referenceFor(game)
  if (!reference || !supportedCloudMode(mode)) throw new Error('Партия доступна для анализа на устройстве.')
  const fingerprint = await gameFingerprint(game)
  const profile = analysisKey({ compute: 'cloud', methodology: methodologyVersion, mode, options: cloudOptions })
  let response: Response
  try {
    response = await fetch('/api/engine/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ChessMind-Session': anonymousSession() },
      body: JSON.stringify({ reference, fingerprint, mode }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
    })
  } catch {
    signal.throwIfAborted()
    throw new CloudUnavailable('Связь с облаком прервалась. Продолжите на устройстве.')
  }
  if (!response.ok) {
    const error: { message?: string } = await response.json().catch(() => ({}))
    throw new CloudUnavailable(error.message ?? 'Облачный анализ недоступен. Продолжите на устройстве.')
  }
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    throw new CloudUnavailable('Облако вернуло неверный ответ.')
  }
  const reader = response.body.getReader()
  const decode = new TextDecoder()
  let pending = ''
  let started = false
  let cached = false
  let delivered = false
  let result: { draft: Draft; reviews: Review[] } | undefined
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      signal.throwIfAborted()
      pending += decode.decode(part.value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop()!
      if (pending.length > 1024 ** 2) throw new Error('Ответ облака превышает лимит.')
      for (const raw of lines) {
        if (!raw) continue
        if (raw.length > 1024 ** 2) throw new Error('Ответ облака превышает лимит.')
        const event = JSON.parse(raw) as StreamEvent
        if (event.type === 'start') {
          if (started || event.fingerprint !== fingerprint || event.engine !== cloudEngine || event.mode !== mode ||
            event.options?.threads !== cloudOptions.threads || event.options.hash !== cloudOptions.hash) {
            throw new Error('Параметры облачного ответа не совпали с запросом.')
          }
          started = true
          cached = event.cached === true
          continue
        }
        if (event.type === 'error') throw new CloudUnavailable(event.message)
        if (!started) throw new Error('Облако не подтвердило запись партии.')
        if (event.type === 'telemetry') telemetry(event.sample)
        if (event.type === 'progress') {
          if (!validDraft(event.draft, game.moves, profile) || !validProgress(event.progress, game.moves)) {
            throw new Error('Некорректный прогресс облачного анализа.')
          }
          delivered = true
          await update(event.draft, event.progress)
        }
        if (event.type === 'done') {
          if (!validDraft(event.draft, game.moves, profile) || !event.draft.instant.every(Boolean) || !Array.isArray(event.reviews) ||
            event.reviews.length !== game.moves || !event.reviews.every(validReview)) throw new Error('Некорректный итог облачного анализа.')
          result = event
        }
      }
    }
    if (!result) throw new Error('Связь с облаком прервалась. Готовые позиции сохранены.')
    if (!delivered) await update(result.draft, { stage: 'final', instant: game.moves + 1, checked: game.moves,
      critical: 0, criticalDone: 0, moves: game.moves })
    return { ...result, cached }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof CloudUnavailable) throw error
    throw new CloudUnavailable(error instanceof Error ? error.message : 'Связь с облаком прервалась.')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
