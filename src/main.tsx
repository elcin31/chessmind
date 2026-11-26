import { createRoot } from 'react-dom/client'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_POSITION } from 'chess.js'
import { Activity, ArrowDownToLine, ArrowRight, BookOpen, ChartNoAxesCombined, CircleHelp, Cpu, FolderOpen, House, List, MonitorDown, Settings2, ShieldCheck, Target, Upload, Zap } from 'lucide-react'
import { analyzeInCloud, chooseCompute, CloudUnavailable, cloudBlocker, cloudState, getCloudStatus, useCloudStatus } from './cloudClient'
import { deviceBattery, deviceCapabilities, lowBattery } from './device'
import { markGameFinished, waitBetweenGames, withAnalysisLock } from './analysisQueue'
import { AnalysisLoadPause } from './loadControl'
import { ComputeSelect } from './ComputeSettings'
import { cloudOptions, referenceFor, supportedCloudMode, type ComputeEngine, type ComputeSource, type Energy } from './cloudProtocol'
import { updateLiveReview, updateProgress } from './AnalysisProgress'
import { GameCard } from './PlayerCard'
import { Board } from './Board'
import { ImportForm } from './Import'
import { Empty, ReviewScreen } from './ReviewScreen'
import { budgets, releaseIdleEngine, SearchInterrupted, trimCache } from './engine'
import { adaptiveMode, analysisKey, compatibleAnalysisKeys, db, methodologyVersion, reviewMode, reviewModes, historicalRating, isComplete, parsePgn, playerColor, timeLabel, type Analysis, type EngineOptions, type Game, type Mode, type Practice } from './library'
import { categories, type Line, type Review } from './review'
import { analyzeProgressively, hasPreview, type Draft, type StageProgress } from './progressive'
import type { PoolStatus } from './searchPool'
import './style.css'

const Methodology = lazy(() => import('./Methodology').then(module => ({ default: module.Methodology })))
const Training = lazy(() => import('./Training').then(module => ({ default: module.Training })))
const Statistics = lazy(() => import('./Stats').then(module => ({ default: module.Statistics })))
const Openings = lazy(() => import('./Stats').then(module => ({ default: module.Openings })))
const Endgames = lazy(() => import('./Endgames').then(module => ({ default: module.Endgames })))

const mobileWarning = 'Анализ выполняется на вашем устройстве и может увеличивать расход заряда аккумулятора и нагрев телефона'
const deepWarning = 'Глубокий разбор может занять несколько минут'
const turboWarning = 'Turbo может ускорить разряд аккумулятора и повысить нагрев'
const fullWarning = 'Stockfish Full использует больше памяти и вычислительных ресурсов'
const queueEventKey = 'chessmind-queue-event'
type QueueEvent = { id: string; manual?: boolean }
type AnalysisTask = { id: string; controller: AbortController; automatic: boolean; revision?: number; checkpoint?: () => Promise<void> }

const pages = {
  home: { label: 'Главная', icon: House, title: 'Рабочий стол', subtitle: '' },
  games: { label: 'Партии', icon: List, title: 'Мои партии', subtitle: 'Импорт, поиск и история завершённых партий' },
  review: { label: 'Анализ', icon: Activity, title: 'Разбор партии', subtitle: 'Локальный анализ Stockfish' },
  training: { label: 'Тренировки', icon: Target, title: 'Тренажёр ошибок', subtitle: 'Практика на позициях из ваших партий' },
  stats: { label: 'Статистика', icon: ChartNoAxesCombined, title: 'Статистика игрока', subtitle: 'Результаты и качество игры' },
  openings: { label: 'Дебюты', icon: BookOpen, title: 'Дебюты', subtitle: 'Энциклопедия ECO и ваша дебютная практика' },
  endgames: { label: 'Эндшпили', icon: Target, title: 'Эндшпильная лаборатория', subtitle: 'Позиции из завершённых партий' },
  settings: { label: 'Настройки', icon: Settings2, title: 'Настройки', subtitle: 'Профиль, анализ и локальные данные' },
  methodology: { label: 'Методология', icon: CircleHelp, title: 'Методология', subtitle: 'Формулы, допущения и источники' },
}
type Page = keyof typeof pages
type Settings = { nickname: string; theme: 'system' | 'light' | 'dark'; mode: Mode; engine?: EngineOptions; computeSource?: ComputeSource; autoPreview?: number; board?: 'sage' | 'navy' | 'gold' }
const core: Page[] = ['home', 'games', 'review', 'training', 'stats']
const secondary: Page[] = ['openings', 'endgames', 'settings', 'methodology']

function loadSettings(): Settings {
  const defaults: Settings = { nickname: '', theme: 'system', mode: 'smart', computeSource: 'auto' }
  try {
    const saved: Partial<Settings> = JSON.parse(localStorage.getItem('chessmind-settings') || '{}')
    return { ...defaults, ...saved, mode: reviewMode(saved.mode),
      computeSource: saved.computeSource ?? (saved.mode && !adaptiveMode(saved.mode) ? 'local' : 'auto') }
  }
  catch { return defaults }
}
function route(): { page: Page; id?: string; ply?: number } {
  const [page, id, ply] = location.hash.slice(1).split('/')
  return { page: Object.hasOwn(pages, page) ? page as Page : 'home', id, ply: /^\d+$/.test(ply) ? Number(ply) : undefined }
}

async function patchGame(id: string, patch: Partial<Game>, condition?: (value: Game) => boolean) {
  const tx = (await db).transaction('games', 'readwrite')
  const value = await tx.store.get(id)
  if (!value || condition && !condition(value)) { await tx.done; return value }
  const updated = { ...value, ...patch }
  await tx.store.put(updated)
  await tx.done
  return updated
}

const stopKey = (game: Game) => 'chessmind-stop-' + game.id
const stopRevision = (game: Game) => String(game.queuedAt ?? 0)

async function persistPause(game: Game) {
  const updated = await patchGame(game.id, { queued: false, autoPreviewPaused: true },
    current => stopRevision(current) === stopRevision(game))
  if (localStorage.getItem(stopKey(game)) === stopRevision(game)) localStorage.removeItem(stopKey(game))
  return updated
}

function App() {
  const [location, setLocation] = useState(route)
  const [settings, setSettings] = useState(loadSettings)
  const [games, setGames] = useState<Game[]>([])
  const [practice, setPractice] = useState<Practice[]>([])
  const [active, setActive] = useState<string>()
  const [status, setStatus] = useState('')
  const [offline, setOffline] = useState(false)
  const [update, setUpdate] = useState<ServiceWorker>()
  const [visible, setVisible] = useState(!document.hidden)
  const [batteryLow, setBatteryLow] = useState(false)
  const [batteryReady, setBatteryReady] = useState(false)
  const channel = useRef<BroadcastChannel | undefined>(undefined)
  const submitting = useRef(false)
  const current = useRef<AnalysisTask | undefined>(undefined)
  const state = pages[location.page]
  const sorted = useMemo(() => [...games].sort((first, second) => second.date.localeCompare(first.date) || (second.timestamp ?? 0) - (first.timestamp ?? 0)), [games])
  const selected = games.find(game => game.id === location.id) ?? sorted[0]

  function notifyQueue(event: QueueEvent) {
    if (channel.current) channel.current.postMessage(event)
    else localStorage.setItem(queueEventKey, JSON.stringify({ ...event, time: Date.now() }))
  }

  useEffect(() => {
    function onRoute() { setLocation(route()); window.scrollTo(0, 0) }
    function pageHide() {
      const task = current.current
      void task?.checkpoint?.().catch(() => {})
      task?.controller.abort()
      releaseIdleEngine()
    }
    function visibility() {
      if (document.hidden) pageHide()
      setVisible(!document.hidden)
    }
    const refresh = (signal?: QueueEvent) => {
      if (!signal) return
      const task = current.current
      if (signal.manual && task?.automatic) task.controller.abort()
      void db.then(async storage => {
        const latest = await storage.get('games', signal.id)
        if (task && !task.automatic && task.id === signal.id && (!latest?.queued || latest.queuedAt !== task.revision)) {
          task.controller.abort()
        }
        if (latest) setGames(previous => previous.some(game => game.id === latest.id) ?
          previous.map(game => game.id === latest.id ? latest : game) : [...previous, latest])
      }).catch(() => {})
    }
    const queueChannel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('chessmind-queue')
    const onStorage = (event: StorageEvent) => {
      if (event.key === queueEventKey && event.newValue) {
        try { refresh(JSON.parse(event.newValue)) } catch { /* Ignore malformed storage events. */ }
      }
    }
    window.addEventListener('pagehide', pageHide)
    document.addEventListener('freeze', pageHide)
    window.addEventListener('storage', onStorage)
    channel.current = queueChannel
    if (queueChannel) queueChannel.onmessage = event => refresh(event.data)
    window.addEventListener('hashchange', onRoute)
    document.addEventListener('visibilitychange', visibility)
    void db.then(async storage => {
      setGames(await storage.getAll('games'))
      setPractice(await storage.getAll('practice'))
    }).catch(() => setStatus('Локальная база недоступна. Разрешите хранение данных в браузере.'))
    return () => {
      queueChannel?.close()
      window.removeEventListener('pagehide', pageHide)
      document.removeEventListener('freeze', pageHide)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('hashchange', onRoute)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    if (!deviceCapabilities().mobile) { setBatteryReady(true); return }
    let dispose: (() => void) | undefined
    let live = true
    void deviceBattery().then(battery => {
      if (!live) return
      const update = () => setBatteryLow(lowBattery(battery))
      update()
      setBatteryReady(true)
      battery?.addEventListener('levelchange', update)
      battery?.addEventListener('chargingchange', update)
      dispose = () => {
        battery?.removeEventListener('levelchange', update)
        battery?.removeEventListener('chargingchange', update)
      }
    })
    return () => { live = false; dispose?.() }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.board = settings.board ?? 'sage'
    localStorage.setItem('chessmind-settings', JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
    let requested = false
    const controllerChanged = () => { if (requested) window.location.reload(); else setOffline(true) }
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged)
    navigator.serviceWorker.addEventListener('message', event => { if (event.data === 'updating') requested = true })
    void navigator.serviceWorker.register('/sw.js').then(registration => {
      if (registration.waiting) setUpdate(registration.waiting)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.addEventListener('statechange', () => { if (worker.state === 'activating') requested = true })
            setUpdate(worker)
          }
        })
      })
    }).catch(() => setOffline(false))
    void navigator.serviceWorker.ready.then(() => setOffline(Boolean(navigator.serviceWorker.controller)))
    return () => navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged)
  }, [])

  function mergeGame(updated?: Game) {
    if (updated) setGames(previous => previous.map(game => game.id === updated.id ? updated : game))
  }
  useEffect(() => {
    const warned = !deviceCapabilities().mobile || localStorage.getItem('chessmind-mobile-local-warning')
    const autoPreview = !batteryReady || batteryLow || settings.engine?.energy === 'eco' || settings.computeSource === 'cloud' || !warned
      ? 0 : settings.autoPreview || 0
    if (!autoPreview && current.current?.automatic) current.current.controller.abort()
    if (!visible || current.current || active) return
    const manual = games.filter(game => game.queued).sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))[0]
    const pending = manual ?? sorted.slice(0, autoPreview)
      .find(game => game.compute !== 'cloud' && game.queueSource !== 'cloud' && !isComplete(game) && !game.autoPreviewPaused && !hasPreview(game))
    if (!pending) return
    const automatic = !manual
    const controller = new AbortController()
    const task: AnalysisTask = { id: pending.id, controller, automatic, revision: pending.queuedAt }
    current.current = task
    setActive(pending.id)
    const run = async () => {
      if (localStorage.getItem(stopKey(pending)) === stopRevision(pending)) {
        mergeGame(await persistPause(pending))
        notifyQueue({ id: pending.id })
        return
      }
      await waitBetweenGames(controller.signal, (automatic ? settings.engine : pending.options)?.energy === 'eco')
      const storage = await db
      if (automatic) {
        const all = await storage.getAll('games')
        if (all.some(game => game.queued)) { setGames(all); return }
      }
      let latest = await storage.get('games', pending.id)
      if (!latest || controller.signal.aborted || !automatic && (!latest.queued || latest.queuedAt !== pending.queuedAt) ||
        automatic && (latest.queued || latest.compute === 'cloud' || latest.queueSource === 'cloud' || latest.autoPreviewPaused ||
          hasPreview(latest) || isComplete(latest))) return mergeGame(latest)
      if (!automatic && !latest.methodology) {
        const cloud = latest.queueSource === 'cloud' || latest.compute === 'cloud'
        latest = await patchGame(latest.id, prepareAnalysis(latest, latest.mode ?? 'smart',
          cloud ? cloudOptions : settings.engine, cloud ? 'cloud' : 'local'))
      }
      if (!latest) return
      if (localStorage.getItem(stopKey(latest)) === stopRevision(latest)) {
        mergeGame(await persistPause(latest))
        notifyQueue({ id: latest.id })
        return
      }
      const { id, queuedAt } = latest
      const compute = !automatic && (latest.compute === 'cloud' || latest.queueSource === 'cloud') ? 'cloud' : 'local'
      const mode = latest.mode ?? settings.mode
      if (compute === 'local' && deviceCapabilities().mobile && !warned) {
        setStatus(mobileWarning + '.')
        localStorage.setItem('chessmind-mobile-local-warning', '1')
      }
      let staged: Draft | undefined
      let status: StageProgress | undefined
      let telemetry: PoolStatus | undefined
      let lastPaint = -Infinity, lastSave = performance.now(), lastPublish = -Infinity
      let stageStart = performance.now(), stageCount = 0
      let persisted = ''
      let saving = Promise.resolve()
      const copy = (draft: Draft): Draft => ({
        ...draft, instant: [...draft.instant], alternatives: draft.alternatives && [...draft.alternatives],
        work: draft.work && { ...draft.work, reviews: { ...draft.work.reviews } },
      })
      const publish = (transition = false) => {
        if (!status) return
        const now = performance.now()
        if (!transition && now - lastPublish < 250) return
        lastPublish = now
        const step = status.stage === 'instant' ? status.instant : status.stage === 'critical' ? status.criticalDone : status.checked
        const total = status.stage === 'instant' ? status.moves + 1 : status.stage === 'critical' ? status.critical : status.moves
        const processed = step - stageCount
        const eta = processed >= 2 ? Math.ceil((now - stageStart) * (total - step) / (1000 * processed)) : undefined
        updateProgress({ id, ...status, automatic, compute, mode, search: telemetry, eta })
      }
      const persist = (final?: { draft: Draft; reviews?: Review[]; cached?: boolean }) => {
        if (!staged || !status) return saving
        const stamp = [status.stage, status.instant, status.checked, staged.interrupted?.index,
          staged.interrupted?.reason, staged.interrupted?.line?.depth].join(':')
        if (!final && stamp === persisted) return saving
        persisted = stamp
        lastSave = performance.now()
        const checkpoint = copy(staged)
        const draft = final ? copy(final.draft) : checkpoint
        saving = saving.catch(() => {}).then(async () => {
          const tx = (await db).transaction('games', 'readwrite')
          const record = await tx.store.get(id)
          if (record) {
            const unchanged = record.queuedAt === queuedAt
            const finished = !!final?.reviews && unchanged && record.queued && !controller.signal.aborted &&
              localStorage.getItem(stopKey(record)) !== stopRevision(record)
            // An old task may contribute Instant positions after a mode switch.
            const completedDraft = final?.reviews && !finished ? checkpoint : draft
            const field = compute === 'cloud' ? 'cloudDraft' : 'draft'
            const currentProfile = analysisKey(record)
            const compatibleWork = completedDraft.work && compatibleAnalysisKeys(completedDraft.work.profile, currentProfile)
              ? { ...completedDraft.work, profile: currentProfile } : undefined
            const nextDraft = unchanged ? completedDraft :
              mergeDraft(record[field], { ...completedDraft, work: compatibleWork, interrupted: undefined })
            const updated = { ...record, [field]: nextDraft,
              ...(finished ? { reviews: final.reviews, queued: false, loadPaused: false, cloudCacheHit: final.cached === true } : {}) }
            await tx.store.put(updated)
            await tx.done
            if (final) mergeGame(updated)
          } else await tx.done
        }).catch(error => {
          if (persisted === stamp) persisted = ''
          throw error
        })
        return saving
      }
      task.checkpoint = persist
      try {
        const selected = automatic ? { ...latest, options: settings.engine, compute: 'local' as const }
          : compute === 'cloud' ? { ...latest, draft: latest.cloudDraft } : latest
        const update = async (draft: Draft, next: StageProgress) => {
            const transition = status?.stage !== next.stage
            status = next
            staged = draft
            const now = performance.now()
            if (transition) {
              stageStart = now
              stageCount = next.stage === 'instant' ? next.instant : next.stage === 'critical' ? next.criticalDone : next.checked
            }
            publish(transition)
            if (transition || now - lastPaint >= 450 || next.instant === next.moves + 1 && next.stage === 'instant') {
              updateLiveReview({ id, draft: copy(draft) })
              lastPaint = now
            }
            if (now - lastSave >= 2500 || transition && next.stage !== 'instant') await persist()
        }
        const onTelemetry = (sample: PoolStatus) => {
          const transition = telemetry?.paused !== sample.paused
          telemetry = sample
          publish(transition)
        }
        const result = compute === 'cloud'
          ? await analyzeInCloud(selected, mode, controller.signal, update, onTelemetry)
          : await analyzeProgressively(selected, mode, controller.signal, update, onTelemetry, automatic)
        await persist(result)
      } catch (error) {
        if (!controller.signal.aborted) {
          await persist()
          const tx = (await db).transaction('games', 'readwrite')
          const record = await tx.store.get(id)
          if (record && record.queuedAt === queuedAt) {
            if (compute === 'cloud' && record.queueSource === 'auto' && error instanceof CloudUnavailable && error.rejectedBeforeStart) {
              const update = { ...record, ...prepareAnalysis(record, mode, settings.engine),
                queuedAt: Math.max(Date.now(), (queuedAt ?? 0) + 1) }
              if (isComplete(update)) update.queued = false
              await tx.store.put(update)
            } else {
              setStatus(error instanceof Error ? error.message : 'Ошибка анализа.')
              await tx.store.put(automatic ? { ...record, autoPreviewPaused: true } : { ...record, queued: false, loadPaused: error instanceof AnalysisLoadPause || error instanceof SearchInterrupted && error.reason === 'load' })
            }
          }
          await tx.done
        }
      } finally {
        await persist()
        mergeGame(await (await db).get('games', id))
        await markGameFinished()
        notifyQueue({ id })
      }
    }
    const work = withAnalysisLock(controller, run)
    void work.catch(error => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Ошибка очереди.') }).finally(() => {
      current.current = undefined
      updateLiveReview(undefined)
      updateProgress(undefined)
      setActive(undefined)
    })
  }, [games, sorted, visible, active, settings.autoPreview, settings.engine, settings.mode, settings.computeSource, batteryLow, batteryReady])

  const open = useCallback((game: Game, ply?: number) => { window.location.hash = 'review/' + game.id + (ply ? '/' + ply : '') }, [])
  function go(page: Page) { window.location.hash = page }
  async function queueBatch(items: Game[], mode: Mode, change = false, source = settings.computeSource ?? 'auto', eco = false) {
    if (submitting.current) return
    submitting.current = true
    setStatus('')
    try {
      const localOptions = (game: Game) => eco ? { ...(game.compute === 'local' ? game.options : settings.engine), energy: 'eco' as const } : settings.engine
      const selections = new Map<string, ComputeEngine>()
      for (const game of items) {
        if (source !== 'cloud' && isComplete({ ...game, ...prepareAnalysis(game, mode, localOptions(game)) })) {
          selections.set(game.id, 'local')
        } else if (source !== 'local' && isComplete({ ...game, ...prepareAnalysis(game, mode, cloudOptions, 'cloud') })) {
          selections.set(game.id, 'cloud')
        }
      }
      const mayUseCloud = source !== 'local' && supportedCloudMode(mode) &&
        items.some(game => !selections.has(game.id) && referenceFor(game))
      const status = mayUseCloud ? await getCloudStatus() : undefined
      for (const game of items) {
        if (selections.has(game.id)) continue
        const issue = source === 'cloud' && cloudBlocker(game, mode, status)
        if (issue) { setStatus(issue); continue }
        selections.set(game.id, chooseCompute(source, game, mode, status))
      }
      if (!selections.size) return
      const needsLocal = items.some(game => selections.get(game.id) === 'local' &&
        !isComplete({ ...game, ...prepareAnalysis(game, mode, localOptions(game)) }))
      if (needsLocal) {
        const first = deviceCapabilities().mobile && !localStorage.getItem('chessmind-mobile-local-warning')
        const warning = [
          first && mobileWarning,
          mode === 'deep-review' && deepWarning,
          !eco && settings.engine?.energy === 'turbo' && turboWarning,
          settings.engine?.full && fullWarning,
        ].filter(Boolean).join('.\n\n')
        if (warning && !window.confirm(warning + '.')) return
        if (first) localStorage.setItem('chessmind-mobile-local-warning', '1')
      }
      if (current.current && selections.has(current.current.id)) await current.current.checkpoint?.()
      const tx = (await db).transaction('games', 'readwrite')
      const changed = new Map<string, Game>()
      const queuedAt = Date.now()
      for (const [index, item] of items.entries()) {
        const latest = await tx.store.get(item.id)
        const compute = selections.get(item.id)
        if (!latest || !compute || !['1-0', '0-1', '1/2-1/2'].includes(latest.result)) continue
        const options = compute === 'cloud' ? cloudOptions : localOptions(latest)
        if (latest.queued && (!change || latest.mode === mode && latest.compute === compute &&
          (latest.queueSource ?? 'local') === source && JSON.stringify(latest.options) === JSON.stringify(options))) continue
        const updated = { ...latest, ...prepareAnalysis(latest, mode, options, compute), queueSource: source,
          queuedAt: Math.max(queuedAt + index, (latest.queuedAt ?? 0) + 1), autoPreviewPaused: false, loadPaused: false }
        if (isComplete(updated)) updated.queued = false
        await tx.store.put(updated)
        changed.set(updated.id, updated)
      }
      await tx.done
      const running = current.current
      if (changed.size && (running?.automatic || running && changed.has(running.id))) running.controller.abort()
      for (const [id] of changed) notifyQueue({ id, manual: true })
      setGames(previous => previous.map(game => changed.get(game.id) ?? game))
    } catch { setStatus('Не удалось сохранить очередь анализа.') }
    finally { submitting.current = false }
  }
  function queue(game: Game, mode: Mode, source: ComputeSource, eco = false) { return queueBatch([game], mode, true, source, eco) }
  async function pause(game: Game) {
    try {
      localStorage.setItem(stopKey(game), stopRevision(game))
      const task = current.current
      if (task?.id === game.id) {
        task.controller.abort()
        await task.checkpoint?.()
      }
      mergeGame(await persistPause(game))
      notifyQueue({ id: game.id })
    } catch { setStatus('Не удалось приостановить анализ.') }
  }
  const finished = games.filter(isComplete).length
  const importForm = <ImportForm nickname={settings.nickname} onNickname={nickname => setSettings(old => ({ ...old, nickname }))} onSaved={setGames} />
  const navigation = (items: Page[]) => items.map(page => {
    const Icon = pages[page].icon
    return <a key={page} href={'#' + page} aria-current={location.page === page ? 'page' : undefined}><Icon size={19} strokeWidth={1.75} /><span>{pages[page].label}</span>
      {page === 'review' && active && <i className="nav-pulse" />}</a>
  })

  return <div className="app-layout">
    <aside className="sidebar">
      <a href="#home" className="brand"><img src="/icon.svg" width="43" height="43" alt="" /><div>Chess<span>Mind</span><small>АНАЛИЗ ПАРТИЙ</small></div></a>
      <nav aria-label="Основные разделы" className="main-nav">{navigation(core)}</nav>
      <nav aria-label="Дополнительные разделы" className="secondary-nav">{navigation(secondary)}</nav>
      <div className="side-footer"><div><ShieldCheck size={16} /> Данные на устройстве</div><small>ChessMind 2.0.7</small></div>
    </aside>
    <main>
      <header className="topbar">
        <a href="#home" className="mobile-brand"><img src="/icon.svg" width="34" height="34" alt="" /> ChessMind</a>
        <div className="breadcrumb">{state.title}</div>
        <div className="top-status">
          {active && <a href={'#review/' + active} className="offline-status"><Cpu size={15} /> <span>Идёт анализ</span></a>}
          <span className="offline-status"><i />{offline ? 'Офлайн готов' : 'Локальный режим'}</span>
          <a className="icon-btn mobile-only" href="#settings" aria-label="Настройки"><Settings2 size={19} /></a>
        </div>
      </header>
      <div className="content">
        {location.page !== 'home' && <div className="page-heading"><h1>{state.title}</h1><p>{state.subtitle}</p></div>}
        {status && <div className="notice bad banner" role="alert">{status}<button onClick={() => setStatus('')}>Закрыть</button></div>}
        {update && <div className="notice banner">Доступна новая сборка ChessMind.<button disabled={!!active} onClick={() => {
          const activate = () => new Promise<void>(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', () => { resolve(); window.location.reload() }, { once: true })
            update.postMessage('activate-update')
          })
          void withAnalysisLock(new AbortController(), async () => { await activate(); return true }, true)
            .then(locked => { if (!locked) setStatus('Анализ идёт в другой вкладке. Обновление станет доступно после завершения.') })
            .catch(() => setStatus('Не удалось запустить обновление.'))
        }}>Обновить</button></div>}
        {location.page === 'home' && <>
          <section className="hero">
            <div className="hero-copy"><div className="eyebrow"><i /> CHESSMIND 2.0.7</div>
              <h1>Разбор шахматных<br className="desktop-break" /> партий</h1>
              <p>Найдите переломные ходы, проверьте варианты Stockfish и потренируйтесь на собственных ошибках.</p>
              <div className="hero-actions"><a className="primary" href="#games"><ArrowDownToLine size={18} /> Добавить партию</a>
                <a className="hero-link" href="#methodology">Как это работает <ArrowRight size={16} /></a></div>
            </div>
            <div className="hero-board">
              <div className="hero-board-header"><span><Activity size={15} /> Шахматная доска</span><span><i /> Stockfish 19</span></div>
              <Board fen={DEFAULT_POSITION} />
            </div>
          </section>
          <div className="home-body">
            {importForm}
            <section className="panel home-library">
              <div className="card-head"><div className="section-icon"><FolderOpen size={21} /></div><div><h2>Моя библиотека</h2><p>Партии и анализы на этом устройстве</p></div></div>
              <div className="library-summary"><div><strong>{games.length}</strong><span>Сохранено партий</span></div><div><strong>{finished}</strong><span>Разобрано</span></div></div>
              {sorted.length ? <div className="recent-list">{sorted.slice(0, 3).map(game => <GameCard key={game.id} game={game} nickname={settings.nickname} open={open} recent />)}</div> :
                <div className="library-empty"><FolderOpen size={20} /><p>Здесь появятся ваши партии после импорта.</p></div>}
              {sorted.length > 0 && <a className="quiet" href="#games">Все партии <ArrowRight size={16} /></a>}
            </section>
          </div>
          <footer className="home-footer"><span><Cpu size={16} /> Все расчёты на вашем устройстве</span><span><Zap size={16} /> Бесплатно и без лимитов</span><span><MonitorDown size={16} /> Устанавливается как приложение</span></footer>
        </>}
        {location.page === 'games' && <>{importForm}<GameList games={sorted} nickname={settings.nickname} open={open} queue={items => void queueBatch(items, settings.mode)} /></>}
        {location.page === 'review' && <ReviewScreen key={(selected?.id ?? '') + ':' + (location.ply ?? 0)} game={selected} initialPly={location.ply} games={games} nickname={settings.nickname} mode={settings.mode} active={active} options={settings.engine} batteryLow={batteryLow} preferredSource={settings.computeSource ?? 'auto'} onQueue={queue} onPause={pause} onImport={() => go('games')} />}
        <Suspense fallback={<p role="status">Загружаем раздел…</p>}>
        {location.page === 'training' && <Training games={games} nickname={settings.nickname} practice={practice} onPractice={item => setPractice(old => [...old.filter(entry => entry.id !== item.id), item])} onImport={() => go('games')} />}
        {location.page === 'stats' && <Statistics games={games} nickname={settings.nickname} open={open} />}
        {location.page === 'openings' && <Openings games={games} nickname={settings.nickname} open={open} />}
        {location.page === 'endgames' && <Endgames games={games} open={open} />}
        {location.page === 'settings' && <Preferences settings={settings} onSettings={setSettings} setGames={setGames} setPractice={setPractice} offline={offline} />}
        {location.page === 'methodology' && <Methodology />}
        </Suspense>
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Основные разделы">{navigation(core)}</nav>
  </div>
}

function GameList({ games, nickname, open, queue }: { games: Game[]; nickname: string; open: (game: Game) => void; queue: (games: Game[]) => void }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [order, setOrder] = useState('new')
  const [color, setColor] = useState('')
  const [result, setResult] = useState('')
  const [limit, setLimit] = useState(30)
  const shown = games.filter(game => (!status || (status === 'complete' ? isComplete(game) : status === 'queued' ? game.queued : !isComplete(game))) &&
    (!source || game.source === source) && (!color || playerColor(game, nickname) === color) && (!result || game.result === result) &&
    [game.white, game.black, game.opening?.join(' '), game.date, timeLabel(game.time)].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
  if (order === 'old') shown.reverse()
  if (order === 'long') shown.sort((first, second) => second.moves - first.moves)
  return <section className="panel games-panel">
    <div className="list-heading"><h2>Библиотека партий</h2><span>{shown.length} из {games.length}</span></div>
    <div className="filters">
      <input value={search} onChange={e => setSearch(e.target.value)} aria-label="Поиск партий" placeholder="Игрок, дебют, дата…" />
      <select value={source} onChange={e => setSource(e.target.value)} aria-label="Источник"><option value="">Источники</option><option value="chesscom">Chess.com</option><option value="lichess">Lichess</option><option value="pgn">PGN</option></select>
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Статус анализа"><option value="">Статус</option><option value="complete">Анализ готов</option><option value="queued">В очереди</option><option value="pending">Без полного анализа</option></select>
      <select value={color} onChange={e => setColor(e.target.value)} aria-label="Цвет фигур"><option value="">Цвет</option><option value="w">Белые</option><option value="b">Чёрные</option></select>
      <select value={result} onChange={e => setResult(e.target.value)} aria-label="Результат"><option value="">Результат</option><option>1-0</option><option>0-1</option><option>1/2-1/2</option></select>
      <select value={order} onChange={e => setOrder(e.target.value)} aria-label="Сортировка"><option value="new">Сначала новые</option><option value="old">Сначала старые</option><option value="long">По длине</option></select>
    </div>
    {shown.some(game => !isComplete(game) && !game.queued) && <button onClick={() => queue(shown.filter(game => !isComplete(game) && !game.queued))}>Добавить в очередь партии без полного анализа</button>}
    {!shown.length && <Empty title={games.length ? 'Партии не найдены' : 'Библиотека пуста'} message={games.length ? 'Измените параметры поиска.' : 'Выберите источник импорта выше.'} />}
    <div className="game-rows">{shown.slice(0, limit).map(game => <GameCard key={game.id} game={game} nickname={nickname} open={open} />)}</div>
    {shown.length > limit && <button className="quiet" onClick={() => setLimit(limit + 30)}>Показать ещё</button>}
  </section>
}

function prepareAnalysis(game: Game, mode: Mode, options?: EngineOptions, compute: ComputeEngine = 'local'): Partial<Game> {
  const next = { mode, options, compute, methodology: methodologyVersion } as const
  const key = analysisKey(next)
  const current = analysisKey(game)
  const field = compute === 'cloud' ? 'cloudDraft' : 'draft'
  const oldDraft = game[field]
  const savedDrafts = { ...game.savedDrafts }
  const priorKey = oldDraft?.work?.profile ?? oldDraft?.interrupted?.profile
  if (priorKey && !compatibleAnalysisKeys(priorKey, key) && oldDraft) savedDrafts[priorKey] = oldDraft
  const restoredKey = priorKey && compatibleAnalysisKeys(priorKey, key) ? undefined :
    Object.keys(savedDrafts).find(profile => compatibleAnalysisKeys(profile, key))
  const draft = (restoredKey ? savedDrafts[restoredKey] : undefined) ?? oldDraft
  if (restoredKey) delete savedDrafts[restoredKey]
  const draftPatch = { [field]: draft && {
    ...draft,
    work: draft.work && compatibleAnalysisKeys(draft.work.profile, key) ? { ...draft.work, profile: key } : draft.work,
    interrupted: draft.interrupted && compatibleAnalysisKeys(draft.interrupted.profile, key)
      ? { ...draft.interrupted, profile: key } : draft.interrupted,
  }, savedDrafts }
  if (compatibleAnalysisKeys(current, key)) return { ...next, ...draftPatch, queued: true }
  const saved = game.savedAnalyses ?? []
  const snapshot = saved.find(item => compatibleAnalysisKeys(analysisKey(item), key) && isComplete({ ...game, reviews: item.reviews }))
    ?? saved.find(item => analysisKey(item) === key)
  const discardedKey = snapshot && analysisKey(snapshot)
  const prior: Analysis[] = game.reviews?.length && game.mode ? [{
    mode: game.mode, methodology: game.methodology, options: game.options, compute: game.compute, reviews: game.reviews,
  }] : []
  return {
    ...next, ...draftPatch, queued: true, reviews: snapshot?.reviews ?? [],
    savedAnalyses: [...saved.filter(item => ![key, current, discardedKey].includes(analysisKey(item))), ...prior],
  }
}

function mergeDraft(local?: Draft, imported?: Draft) {
  if (!local || !imported) return local ?? imported
  if (local.previewVersion !== imported.previewVersion) return local
  const preferred = local.instant.map((line, index) => (line?.depth ?? -1) >= (imported.instant[index]?.depth ?? -1))
  const draft: Draft = {
    ...local, instant: preferred.map((keep, index) => keep ? local.instant[index] : imported.instant[index]),
    work: local.work ?? imported.work, interrupted: local.interrupted ?? imported.interrupted,
  }
  if (local.previewVersion === 1) draft.alternatives = preferred.map((keep, index) =>
    (keep ? local.alternatives : imported.alternatives)?.[index] ?? null)
  if (local.work?.profile === imported.work?.profile && local.work && imported.work) {
    draft.work = { ...local.work, reviews: { ...imported.work.reviews, ...local.work.reviews } }
  }
  return draft
}

function validLine(value: Line) {
  return value && ['mate', 'cp'].includes(value.kind) && Number.isFinite(value.value) && Number.isFinite(value.depth) &&
    Array.isArray(value.pv) && value.pv.every(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) &&
    (!value.wdl || Array.isArray(value.wdl) && value.wdl.length === 3 && value.wdl.every(Number.isFinite))
}

function readEngineOptions(value?: EngineOptions): EngineOptions | undefined {
  if (!value || typeof value !== 'object') return undefined
  return {
    full: value.full === true,
    energy: value.energy === 'eco' || value.energy === 'turbo' ? value.energy : undefined,
    multiplier: [0.5, 1, 2, 3].includes(value.multiplier ?? 0) ? value.multiplier : undefined,
    threads: value.threads === 1 || value.threads === 2 ? value.threads : undefined,
    workers: [1, 2, 3, 4].includes(value.workers ?? 0) ? value.workers : undefined,
    hash: value.hash === 16 || value.hash === 32 || value.hash === 64 ? value.hash : undefined,
    cache: [0, 500, 3000, 6000].includes(value.cache ?? -1) ? value.cache : undefined,
  }
}

function Preferences({ settings, onSettings, setGames, setPractice, offline }: {
  settings: Settings; onSettings: (value: Settings) => void; setGames: (games: Game[]) => void; setPractice: (practice: Practice[]) => void; offline: boolean
}) {
  const [message, setMessage] = useState('')
  const cloud = useCloudStatus(true)
  async function backup() {
    try {
      const storage = await db
      const snapshot = { version: 2, games: await storage.getAll('games'), practice: await storage.getAll('practice'), settings,
        repertoire: JSON.parse(localStorage.getItem('chessmind-repertoire') ?? '{}'),
        repertoireDue: JSON.parse(localStorage.getItem('chessmind-repertoire-due') ?? '{}') }
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'chessmind-' + new Date().toISOString().slice(0, 10) + '.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage('Резервная копия подготовлена.')
    } catch { setMessage('Не удалось экспортировать данные.') }
  }
  async function restore(file: File) {
    try {
      const json = JSON.parse(await file.text())
      if (![1, 2].includes(json.version) || !Array.isArray(json.games) || !Array.isArray(json.practice)) throw new Error('Неверный формат резервной копии.')
      const restored: Game[] = []
      for (const row of json.games as Game[]) {
        if (!['chesscom', 'lichess', 'pgn'].includes(row.source) || typeof row.pgn !== 'string') throw new Error('Копия содержит некорректную партию.')
        const game = await parsePgn(row.pgn, row.source, typeof row.owner === 'string' ? row.owner : undefined, typeof row.url === 'string' ? row.url : undefined, (row.methodology ?? 1) < 2)
        if (row.id !== game.id) throw new Error('Контрольная сумма партии не совпадает.')
        const validReview = (item: Review, index: number) => !!item && item.index === index &&
          Object.hasOwn(categories, item.category) && ['w','b'].includes(item.color) && !item.preliminary &&
          ['opening','middle','end'].includes(item.phase) && [item.loss, item.accuracy, item.depth].every(Number.isFinite) &&
          (item.cpLoss === null || Number.isFinite(item.cpLoss)) && [item.before,item.after,item.played].every(validLine) &&
          Array.isArray(item.lines) && item.lines.every(validLine) && typeof item.explanation === 'string'
        const validReviews = (reviews: Review[]) => Array.isArray(reviews) && reviews.length <= game.moves && reviews.every(validReview)
        const validIndex = (index: number) => Number.isInteger(index) && index >= 0 && index < game.moves
        const validDraft = (draft?: Draft) => !draft || (draft.format === 1 && Array.isArray(draft.instant) &&
          draft.instant.length === game.moves + 1 && draft.instant.every(line => line === null || validLine(line)) &&
          (!draft.alternatives || draft.previewVersion === 1 && Array.isArray(draft.alternatives) &&
            draft.alternatives.length === game.moves + 1 && draft.alternatives.every(line => line === null || validLine(line))) &&
          (!draft.work || (typeof draft.work.profile === 'string' && Array.isArray(draft.work.critical) &&
            draft.work.critical.every(validIndex) && draft.work.reviews &&
            Object.entries(draft.work.reviews).every(([key, review]) => validIndex(Number(key)) && validReview(review, Number(key))))))
        if (!validDraft(row.draft) || !validDraft(row.cloudDraft) || row.savedDrafts &&
          Object.entries(row.savedDrafts).some(([key, draft]) => !draft || !validDraft(draft) ||
            key !== draft.work?.profile && key !== draft.interrupted?.profile)) throw new Error('Копия содержит некорректный черновик анализа.')
        if (row.reviews && !validReviews(row.reviews) || row.savedAnalyses && (!Array.isArray(row.savedAnalyses) ||
          row.savedAnalyses.some(item => !Object.hasOwn(budgets, item.mode) || !validReviews(item.reviews)))) {
          throw new Error('Копия содержит некорректный анализ.')
        }
        restored.push({ ...game, whiteElo: game.whiteElo ?? historicalRating(row.whiteElo), blackElo: game.blackElo ?? historicalRating(row.blackElo), timestamp: Number.isFinite(row.timestamp) ? row.timestamp : game.timestamp,
          mode: row.mode && Object.hasOwn(budgets, row.mode) ? row.mode : undefined, reviews: row.reviews, draft: row.draft,
          cloudDraft: row.cloudDraft, compute: row.compute === 'cloud' ? 'cloud' : undefined,
          methodology: row.methodology === 3 || row.methodology === 2 ? row.methodology : 1, options: readEngineOptions(row.options), savedAnalyses: row.savedAnalyses, savedDrafts: row.savedDrafts,
          autoPreviewPaused: row.autoPreviewPaused === true, loadPaused: row.loadPaused === true,
          localElapsedMs: Number.isFinite(row.localElapsedMs) ? row.localElapsedMs : undefined,
          queueSource: ['auto', 'cloud', 'local'].includes(row.queueSource ?? '') ? row.queueSource : undefined })

      }
      const storage = await db
      const known = new Set(restored.map(game => game.id))
      const tx = storage.transaction(['games','practice'], 'readwrite')
      for (const game of restored) {
        const previous = await tx.objectStore('games').get(game.id)
        if (!previous) await tx.objectStore('games').put(game)
        else {
          const analyses = new Map((previous.savedAnalyses ?? []).map(item => [analysisKey(item), item]))
          const existingKey = analysisKey(previous)
          const imported = [...(game.savedAnalyses ?? []), ...(game.mode && game.reviews ? [{
            mode: game.mode, methodology: game.methodology, options: game.options, compute: game.compute, reviews: game.reviews,
          }] : [])]
          const draft = mergeDraft(previous.draft, game.draft)
          const savedDrafts = { ...game.savedDrafts }
          for (const [key, value] of Object.entries(previous.savedDrafts ?? {})) savedDrafts[key] = mergeDraft(value, savedDrafts[key])!
          let update = { ...previous, draft, savedDrafts, cloudDraft: mergeDraft(previous.cloudDraft, game.cloudDraft), whiteElo: previous.whiteElo ?? game.whiteElo, blackElo: previous.blackElo ?? game.blackElo }
          for (const item of imported) {
            const key = analysisKey(item)
            if (key === existingKey) {
              if (!previous.queued && item.reviews.length > (update.reviews?.length ?? 0)) update = { ...update, ...item }
            } else if (item.reviews.length > (analyses.get(key)?.reviews.length ?? 0)) analyses.set(key, item)
          }
          if (!update.queued && !update.reviews?.length && game.reviews?.length) {
            update = { ...update, mode: game.mode, methodology: game.methodology, options: game.options, compute: game.compute, reviews: game.reviews }
            analyses.delete(analysisKey(update))
          }
          await tx.objectStore('games').put({ ...update, savedAnalyses: [...analyses.values()] })
        }
      }
      for (const item of json.practice as Practice[]) {
        if (typeof item.id !== 'string' || !known.has(item.id.split(':')[0]) || ![item.correct,item.wrong,item.due,item.last,item.streak].every(value => Number.isFinite(value) && value >= 0)) continue
        const previous = await tx.objectStore('practice').get(item.id)
        if (!previous || previous.last < item.last) await tx.objectStore('practice').put(item)
      }
      await tx.done
      setGames(await storage.getAll('games'))
      setPractice(await storage.getAll('practice'))
      if (json.settings && typeof json.settings.nickname === 'string' && ['system','light','dark'].includes(json.settings.theme) && Object.hasOwn(budgets, json.settings.mode)) {
        onSettings({ nickname: json.settings.nickname, theme: json.settings.theme, mode: reviewMode(json.settings.mode), engine: readEngineOptions(json.settings.engine),
          computeSource: ['local', 'cloud', 'auto'].includes(json.settings.computeSource) ? json.settings.computeSource : adaptiveMode(json.settings.mode) ? 'auto' : 'local',
          autoPreview: [1, 3, 5].includes(json.settings.autoPreview) ? json.settings.autoPreview : 0,
          board: ['sage', 'navy', 'gold'].includes(json.settings.board) ? json.settings.board : 'sage' })
      }
      if (json.repertoire && typeof json.repertoire === 'object' && !Array.isArray(json.repertoire)) {
        const prior = JSON.parse(localStorage.getItem('chessmind-repertoire') ?? '{}')
        const entries = Object.entries(json.repertoire).filter(([key, value]) =>
          /^[wb]:[a-zA-Z0-9/]+ [wb] [KQkq-]+ [a-h1-8-]+$/.test(key) && typeof value === 'string' && value.length <= 12)
        localStorage.setItem('chessmind-repertoire', JSON.stringify({ ...Object.fromEntries(entries), ...prior }))
        const due = JSON.parse(localStorage.getItem('chessmind-repertoire-due') ?? '{}')
        for (const [key] of entries) {
          const time = json.repertoireDue?.[key]
          if (Number.isFinite(time) && time >= 0) due[key] = Math.max(due[key] ?? 0, time)
        }
        localStorage.setItem('chessmind-repertoire-due', JSON.stringify(due))
      }
      setMessage('Резервная копия восстановлена.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось восстановить данные.') }
  }
  return <div className="settings-grid">
    <section className="panel"><h2>Персональные настройки</h2>
      <label className="field">Ваш никнейм для PGN<input value={settings.nickname} onChange={event => onSettings({ ...settings, nickname: event.target.value.trim() })} placeholder="Никнейм в заголовках PGN" maxLength={40} /></label>
      <label className="field">Тема<select value={settings.theme} onChange={event => onSettings({ ...settings, theme: event.target.value as Settings['theme'] })}><option value="system">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
      <label className="field">Цвет доски<select value={settings.board ?? 'sage'} onChange={event => onSettings({ ...settings, board: event.target.value as Settings['board'] })}><option value="sage">Шалфей</option><option value="navy">Тёмно-синий</option><option value="gold">Золотой</option></select></label>
      <div className="action-row"><a href="#endgames">Эндшпили</a><a href="#openings">Дебюты</a><a href="#methodology">Методология</a></div>
    </section>
    <section className="panel"><h2>Производительность и батарея</h2>
      <label className="field">Режим анализа по умолчанию<select value={settings.mode} onChange={event => onSettings({ ...settings, mode: event.target.value as Mode })}>
        {Object.entries(reviewModes).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>

      <label className="field">Предварительный анализ последних партий<select disabled={settings.engine?.energy === 'eco'} value={settings.engine?.energy === 'eco' ? 0 : settings.autoPreview ?? 0} onChange={event =>
        onSettings({ ...settings, autoPreview: Number(event.target.value) })}>
        <option value={0}>Выключен</option>{[1, 3, 5].map(count => <option value={count} key={count}>{count} · пока приложение открыто</option>)}
      </select></label>
      <label className="field">Источник вычислений<ComputeSelect value={settings.computeSource ?? 'auto'}
        onChange={computeSource => onSettings({ ...settings, computeSource })} /></label>
      <p className="muted">{cloudBlocker(undefined, 'smart', cloud) ?? cloudState(cloud)}</p>
      <label className="field">Энергопотребление<select value={settings.engine?.energy ?? 'balanced'} onChange={event => onSettings({
        ...settings, engine: { ...settings.engine, energy: event.target.value as Energy },
      })}><option value="eco">Eco</option><option value="balanced">Balanced</option><option value="turbo">Turbo</option></select></label>
      <p className="muted">Профиль применяется при следующем запуске или продолжении разбора.</p>
      {settings.engine?.energy === 'turbo' && <p className="notice">Turbo может ускорить разряд аккумулятора и повысить нагрев.</p>}
      <details className="analysis-engine"><summary>Технические настройки</summary>
      <label className="field">Бюджет глубокого разбора<select value={Math.max(1, settings.engine?.multiplier ?? 1)} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, multiplier: Number(event.target.value) } })}>{[1, 2, 3].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      <label className="field">Параллелизм Lite<select value={settings.engine?.threads ?? 'auto'} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, threads: event.target.value === '1' ? 1 : undefined } })}><option value="auto">Авто</option><option value="1">Один поток</option></select></label>
      <label className="field">Память Stockfish Hash<select value={settings.engine?.hash ?? 'auto'} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, hash: event.target.value === 'auto' ? undefined : Number(event.target.value) as EngineOptions['hash'] } })}><option value="auto">Авто</option>{[16, 32, 64].map(value => <option key={value} value={value}>{value} МБ</option>)}</select></label>
      <label className="action-row"><input type="checkbox" checked={settings.engine?.full ?? false} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, full: event.target.checked } })} /> Stockfish Full · около 95 МиБ при первом запуске</label>
      </details>
    </section>
    <section className="panel"><h2>Хранение и установка</h2>
      <label className="field">Лимит кэша позиций<select value={settings.engine?.cache ?? 3000} onChange={event => {
        const cache = Number(event.target.value)
        onSettings({ ...settings, engine: { ...settings.engine, cache } })
        void trimCache(cache).catch(() => setMessage('Не удалось очистить кэш позиций.'))
      }}><option value={0}>Отключён</option>{[500, 3000, 6000].map(value => <option key={value} value={value}>{value} позиций</option>)}</select></label><p>{offline ? 'Движок и интерфейс доступны офлайн.' : 'Офлайн-режим готовится при первом открытии опубликованного приложения.'}</p>
      <p>На iPhone откройте ChessMind в Safari, нажмите «Поделиться», затем «На экран Домой» и «Добавить».</p>
      <p className="muted">Экспортируйте резервную копию перед очисткой данных браузера или переносом на другое устройство.</p>
      <div className="action-row"><button onClick={backup}><ArrowDownToLine size={16} /> Экспорт</button>
        <label className="upload"><Upload size={16} /> Импорт копии<input aria-label="Импорт копии" type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0]; if (file) void restore(file); event.target.value = ''
        }} /></label></div>
      {message && <p className="notice" role="status">{message}</p>}
    </section>
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)
