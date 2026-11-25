import { createRoot } from 'react-dom/client'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_POSITION } from 'chess.js'
import { Activity, ArrowDownToLine, ArrowRight, BookOpen, ChartNoAxesCombined, CircleHelp, Cpu, FolderOpen, House, List, MonitorDown, Settings2, ShieldCheck, Target, Upload, Zap } from 'lucide-react'
import { analyzeInCloud, chooseCompute, cloudBlocker, getCloudStatus, useCloudStatus } from './cloudClient'
import { ComputeSelect } from './ComputeSettings'
import { cloudOptions, type ComputeEngine, type ComputeSource, type Energy } from './cloudProtocol'
import { updateLiveReview, updateProgress } from './AnalysisProgress'
import { GameCard } from './PlayerCard'
import { Board } from './Board'
import { ImportForm } from './Import'
import { Empty, ReviewScreen } from './ReviewScreen'
import { budgets, trimCache } from './engine'
import { analysisKey, db, methodologyVersion, historicalRating, isComplete, parsePgn, playerColor, timeLabel, type Analysis, type EngineOptions, type Game, type Mode, type Practice } from './library'
import { categories, type Line, type Review } from './review'
import { analyzeProgressively, hasPreview, type Draft, type StageProgress } from './progressive'
import type { PoolStatus } from './searchPool'
import './style.css'

const Methodology = lazy(() => import('./Methodology').then(module => ({ default: module.Methodology })))
const Training = lazy(() => import('./Training').then(module => ({ default: module.Training })))
const Statistics = lazy(() => import('./Stats').then(module => ({ default: module.Statistics })))
const Openings = lazy(() => import('./Stats').then(module => ({ default: module.Openings })))
const Endgames = lazy(() => import('./Endgames').then(module => ({ default: module.Endgames })))

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
  try { return { nickname: '', theme: 'system', mode: 'standard', ...JSON.parse(localStorage.getItem('chessmind-settings') || '{}') } }
  catch { return { nickname: '', theme: 'system', mode: 'standard' } }
}
function route(): { page: Page; id?: string; ply?: number } {
  const [page, id, ply] = location.hash.slice(1).split('/')
  return { page: Object.hasOwn(pages, page) ? page as Page : 'home', id, ply: /^\d+$/.test(ply) ? Number(ply) : undefined }
}

async function patchGame(id: string, patch: Partial<Game>) {
  const tx = (await db).transaction('games', 'readwrite')
  const value = await tx.store.get(id)
  if (!value) { await tx.done; return }
  const updated = { ...value, ...patch }
  await tx.store.put(updated)
  await tx.done
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
  const current = useRef<{ id: string; controller: AbortController; automatic: boolean } | undefined>(undefined)
  const state = pages[location.page]
  const sorted = useMemo(() => [...games].sort((first, second) => second.date.localeCompare(first.date) || (second.timestamp ?? 0) - (first.timestamp ?? 0)), [games])
  const selected = games.find(game => game.id === location.id) ?? sorted[0]

  useEffect(() => {
    function onRoute() { setLocation(route()); window.scrollTo(0, 0) }
    function visibility() {
      if (document.hidden) current.current?.controller.abort()
      setVisible(!document.hidden)
    }
    window.addEventListener('hashchange', onRoute)
    document.addEventListener('visibilitychange', visibility)
    void db.then(async storage => {
      setGames(await storage.getAll('games'))
      setPractice(await storage.getAll('practice'))
    }).catch(() => setStatus('Локальная база недоступна. Разрешите хранение данных в браузере.'))
    return () => { window.removeEventListener('hashchange', onRoute); document.removeEventListener('visibilitychange', visibility) }
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
    if (!settings.autoPreview && current.current?.automatic) current.current.controller.abort()
    if (!visible || current.current || active) return
    const manual = games.filter(game => game.queued).sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))[0]
    const pending = manual ?? sorted.slice(0, settings.autoPreview || 0)
      .find(game => !isComplete(game) && !game.autoPreviewPaused && !hasPreview(game))
    if (!pending) return
    const automatic = !manual
    const controller = new AbortController()
    current.current = { id: pending.id, controller, automatic }
    setActive(pending.id)
    const run = async () => {
      let latest = await (await db).get('games', pending.id)
      if (!latest || controller.signal.aborted || !automatic && !latest.queued ||
        automatic && (latest.queued || latest.autoPreviewPaused || hasPreview(latest) || isComplete(latest))) return mergeGame(latest)
      if (!automatic && latest.methodology !== 2) {
        latest = await patchGame(latest.id, prepareAnalysis(latest, latest.mode ?? 'standard', settings.engine))
      }
      if (!latest) return
      const { id, queuedAt } = latest
      const compute = !automatic && latest.compute === 'cloud' ? 'cloud' : 'local'
      const started = performance.now()
      const resumedLocal = !!latest.reviews?.length || !!Object.keys(latest.draft?.work?.reviews ?? {}).length
      let staged: Draft | undefined
      let status: StageProgress | undefined
      let telemetry: PoolStatus | undefined
      let lastPaint = -Infinity, lastSave = performance.now(), lastPublish = -Infinity
      let stageStart = performance.now(), stageCount = 0
      let persisted = ''
      let saving = Promise.resolve()
      const copy = (draft: Draft): Draft => ({
        ...draft, instant: [...draft.instant],
        work: draft.work && { ...draft.work, reviews: { ...draft.work.reviews } },
      })
      const publish = (transition = false) => {
        if (!status) return
        const now = performance.now()
        if (!transition && now - lastPublish < 150) return
        lastPublish = now
        const step = status.stage === 'instant' ? status.instant : status.stage === 'critical' ? status.criticalDone : status.checked
        const total = status.stage === 'instant' ? status.moves + 1 : status.stage === 'critical' ? status.critical : status.moves
        const processed = step - stageCount
        const eta = processed >= 2 ? Math.ceil((now - stageStart) * (total - step) / (1000 * processed)) : undefined
        updateProgress({ id, ...status, automatic, compute, search: telemetry, eta })
      }
      const persist = (final?: { draft: Draft; reviews?: Review[] }) => {
        if (!staged || !status) return saving
        const stamp = [status.stage, status.instant, status.checked].join(':')
        if (!final && stamp === persisted) return saving
        persisted = stamp
        lastSave = performance.now()
        const checkpoint = copy(staged)
        const draft = final ? copy(final.draft) : checkpoint
        saving = saving.then(async () => {
          const tx = (await db).transaction('games', 'readwrite')
          const record = await tx.store.get(id)
          if (record) {
            const unchanged = record.queuedAt === queuedAt
            const finished = !!final?.reviews && unchanged && !controller.signal.aborted
            // An old task may contribute Instant positions after a mode switch.
            const completedDraft = final?.reviews && !finished ? checkpoint : draft
            const field = compute === 'cloud' ? 'cloudDraft' : 'draft'
            const updated = { ...record, [field]: unchanged ? completedDraft : { ...completedDraft, work: record[field]?.work },
              ...(finished ? { reviews: final.reviews, queued: false,
                ...(compute === 'local' && !resumedLocal ? { localElapsedMs: performance.now() - started } : {}) } : {}) }
            await tx.store.put(updated)
            await tx.done
            if (final) mergeGame(updated)
          } else await tx.done
        })
        return saving
      }
      try {
        const selected = automatic ? { ...latest, options: settings.engine, compute: 'local' as const } : latest
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
            if (transition || now - lastPaint >= 225 || next.instant === next.moves + 1 && next.stage === 'instant') {
              updateLiveReview({ id, draft: copy(draft) })
              lastPaint = now
            }
            if (now - lastSave >= 800 || transition && next.stage !== 'instant') await persist()
        }
        const onTelemetry = (sample: PoolStatus) => { telemetry = sample; publish() }
        const mode = latest.mode ?? settings.mode
        const result = compute === 'cloud'
          ? await analyzeInCloud(selected, mode, controller.signal, update, onTelemetry)
          : await analyzeProgressively(selected, mode, controller.signal, update, onTelemetry, automatic)
        await persist(result)
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatus(error instanceof Error ? error.message : 'Ошибка анализа.')
          if (automatic) await patchGame(id, { autoPreviewPaused: true })
          else {
            const latest = await (await db).get('games', id)
            if (latest?.queuedAt === queuedAt) await patchGame(id, { queued: false })
          }
        }
      } finally {
        await persist()
        mergeGame(await (await db).get('games', id))
      }
    }
    const work = navigator.locks ? navigator.locks.request('chessmind-queue', { signal: controller.signal }, run) : run()
    void work.catch(error => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Ошибка очереди.') }).finally(() => {
      current.current = undefined
      updateLiveReview(undefined)
      updateProgress(undefined)
      setActive(undefined)
    })
  }, [games, sorted, visible, active, settings.autoPreview])

  const open = useCallback((game: Game, ply?: number) => { window.location.hash = 'review/' + game.id + (ply ? '/' + ply : '') }, [])
  function go(page: Page) { window.location.hash = page }
  async function queueBatch(items: Game[], mode: Mode, change = false, source = settings.computeSource ?? 'local') {
    setStatus('')
    const status = source === 'local' ? undefined : await getCloudStatus()
    const selections = new Map<string, ComputeEngine>()
    const calibration = games.find(item => item.compute !== 'cloud' && item.mode === mode && isComplete(item) && item.localElapsedMs && item.moves)
    for (const game of items) {
      const issue = source === 'cloud' && cloudBlocker(game, mode, status)
      if (issue) { setStatus(issue); continue }
      const localSeconds = calibration ? calibration.localElapsedMs! * game.moves / (1000 * calibration.moves) : undefined
      selections.set(game.id, chooseCompute(source, game, mode, status, localSeconds))
    }
    if (!selections.size) return
    const running = current.current
    if (running?.automatic || change && running && selections.has(running.id)) running.controller.abort()
    try {
      const tx = (await db).transaction('games', 'readwrite')
      const changed = new Map<string, Game>()
      const queuedAt = Date.now()
      for (const [index, item] of items.entries()) {
        const latest = await tx.store.get(item.id)
        const compute = selections.get(item.id)
        if (!latest || !compute || latest.queued && !change) continue
        const options = compute === 'cloud' ? cloudOptions : settings.engine
        const draft = compute === 'local' ? reuseInstant(latest) : latest.draft
        const updated = { ...latest, ...prepareAnalysis(latest, mode, options, compute), draft, queueSource: source, queuedAt: Math.max(queuedAt + index, (latest.queuedAt ?? 0) + 1), autoPreviewPaused: false }
        if (isComplete(updated)) updated.queued = false
        await tx.store.put(updated)
        changed.set(updated.id, updated)
      }
      await tx.done
      setGames(previous => previous.map(game => changed.get(game.id) ?? game))
    } catch { setStatus('Не удалось сохранить очередь анализа.') }
  }
  function queue(game: Game, mode: Mode, source: ComputeSource) { return queueBatch([game], mode, true, source) }
  async function pause(game: Game) {
    try {
      if (current.current?.id === game.id) current.current.controller.abort()
      mergeGame(await patchGame(game.id, { queued: false, autoPreviewPaused: true }))
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
      <div className="side-footer"><div><ShieldCheck size={16} /> Данные на устройстве</div><small>ChessMind 2.0.3</small></div>
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
          if (navigator.locks) void navigator.locks.request('chessmind-queue', { ifAvailable: true }, lock => {
            if (lock) return activate()
            setStatus('Анализ идёт в другой вкладке. Обновление станет доступно после завершения.')
          })
          else void activate()
        }}>Обновить</button></div>}
        {location.page === 'home' && <>
          <section className="hero">
            <div className="hero-copy"><div className="eyebrow"><i /> CHESSMIND 2.0.3</div>
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
        {location.page === 'review' && <ReviewScreen key={(selected?.id ?? '') + ':' + (location.ply ?? 0)} game={selected} initialPly={location.ply} games={games} nickname={settings.nickname} mode={settings.mode} active={active} options={settings.engine} preferredSource={settings.computeSource ?? 'local'} onQueue={queue} onPause={pause} onImport={() => go('games')} />}
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

function reuseInstant(game: Game) {
  const remote = game.cloudDraft
  if (!remote || remote.format !== 1 || remote.instant.length !== game.moves + 1) return game.draft
  // The stream was bound to a hash of this complete game and the same Lite
  // build. Position estimates are reusable; adjudicated cloud moves stay separate.
  return { format: 1 as const, work: game.draft?.work, instant: remote.instant.map((line, index) => {
    const local = game.draft?.instant[index]
    return (local?.depth ?? -1) >= (line?.depth ?? -1) ? local ?? null : line
  }) }
}

function prepareAnalysis(game: Game, mode: Mode, options?: EngineOptions, compute: ComputeEngine = 'local'): Partial<Game> {
  const next = { mode, options, compute, methodology: methodologyVersion } as const
  if (analysisKey(game) === analysisKey(next)) return { ...next, queued: true }
  const key = analysisKey(next)
  const saved = game.savedAnalyses ?? []
  const snapshot = saved.find(item => analysisKey(item) === key)
  const prior: Analysis[] = game.reviews?.length && game.mode ? [{
    mode: game.mode, methodology: game.methodology, options: game.options, compute: game.compute, reviews: game.reviews,
  }] : []
  return {
    ...next, queued: true, reviews: snapshot?.reviews ?? [],
    savedAnalyses: [...saved.filter(item => ![key, analysisKey(game)].includes(analysisKey(item))), ...prior],
  }
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
    threads: value.threads === 1 ? 1 : undefined,
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
        const game = await parsePgn(row.pgn, row.source, typeof row.owner === 'string' ? row.owner : undefined, typeof row.url === 'string' ? row.url : undefined, row.methodology !== 2)
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
          (!draft.work || (typeof draft.work.profile === 'string' && Array.isArray(draft.work.critical) &&
            draft.work.critical.every(validIndex) && draft.work.reviews &&
            Object.entries(draft.work.reviews).every(([key, review]) => validIndex(Number(key)) && validReview(review, Number(key))))))
        if (!validDraft(row.draft) || !validDraft(row.cloudDraft)) throw new Error('Копия содержит некорректный черновик анализа.')
        if (row.reviews && !validReviews(row.reviews) || row.savedAnalyses && (!Array.isArray(row.savedAnalyses) ||
          row.savedAnalyses.some(item => !Object.hasOwn(budgets, item.mode) || !validReviews(item.reviews)))) {
          throw new Error('Копия содержит некорректный анализ.')
        }
        restored.push({ ...game, whiteElo: game.whiteElo ?? historicalRating(row.whiteElo), blackElo: game.blackElo ?? historicalRating(row.blackElo), timestamp: Number.isFinite(row.timestamp) ? row.timestamp : game.timestamp,
          mode: row.mode && Object.hasOwn(budgets, row.mode) ? row.mode : undefined, reviews: row.reviews, draft: row.draft,
          cloudDraft: row.cloudDraft, compute: row.compute === 'cloud' ? 'cloud' : undefined,
          methodology: row.methodology === 2 ? 2 : 1, options: readEngineOptions(row.options), savedAnalyses: row.savedAnalyses })

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
          const instant = game.draft?.instant.map((line, index) => {
            const local = previous.draft?.instant[index]
            return (local?.depth ?? -1) >= (line?.depth ?? -1) ? local ?? null : line
          })
          const draft = instant ? { format: 1 as const, instant, work: previous.draft ? previous.draft.work : game.draft?.work } : previous.draft
          let update = { ...previous, draft, cloudDraft: previous.cloudDraft ?? game.cloudDraft, whiteElo: previous.whiteElo ?? game.whiteElo, blackElo: previous.blackElo ?? game.blackElo }
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
        onSettings({ nickname: json.settings.nickname, theme: json.settings.theme, mode: json.settings.mode, engine: readEngineOptions(json.settings.engine),
          computeSource: ['local', 'cloud', 'auto'].includes(json.settings.computeSource) ? json.settings.computeSource : 'local',
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
      <label className="field">Режим анализа по умолчанию<select value={settings.mode} onChange={event => onSettings({ ...settings, mode: event.target.value as Mode })}>
        {Object.entries(budgets).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label>
      <label className="field">Цвет доски<select value={settings.board ?? 'sage'} onChange={event => onSettings({ ...settings, board: event.target.value as Settings['board'] })}><option value="sage">Шалфей</option><option value="navy">Тёмно-синий</option><option value="gold">Золотой</option></select></label>
      <label className="field">Бюджет Professional<select value={settings.engine?.multiplier ?? 1} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, multiplier: Number(event.target.value) } })}>{[0.5, 1, 2, 3].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      <label className="field">Предварительный анализ последних партий<select value={settings.autoPreview ?? 0} onChange={event =>
        onSettings({ ...settings, autoPreview: Number(event.target.value) })}>
        <option value={0}>Выключен</option>{[1, 3, 5].map(count => <option value={count} key={count}>{count} · пока приложение открыто</option>)}
      </select></label>
      <label className="field">Источник вычислений<ComputeSelect value={settings.computeSource ?? 'local'}
        onChange={computeSource => onSettings({ ...settings, computeSource })} /></label>
      <p className="muted">На устройстве анализ доступен офлайн. Облако экономит заряд и использует выделенную квоту. Автоматический режим учитывает доступность, режим разбора и скорость устройства.</p>
      <p className="muted">{cloud?.available ? 'Облачный анализ доступен для Express и Standard.' : cloudBlocker(undefined, 'quick', cloud)}</p>
      <label className="field">Энергопотребление<select value={settings.engine?.energy ?? 'balanced'} onChange={event => onSettings({
        ...settings, engine: { ...settings.engine, energy: event.target.value as Energy },
      })}><option value="eco">Eco</option><option value="balanced">Balanced</option><option value="turbo">Turbo</option></select></label>
      {settings.engine?.energy === 'turbo' && <p className="notice">Turbo может ускорить разряд аккумулятора и повысить нагрев.</p>}
      <label className="field">Параллелизм Lite<select value={settings.engine?.threads ?? 'auto'} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, threads: event.target.value === '1' ? 1 : undefined } })}><option value="auto">Авто</option><option value="1">Один поток</option></select></label>
      <label className="field">Память Stockfish Hash<select value={settings.engine?.hash ?? 'auto'} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, hash: event.target.value === 'auto' ? undefined : Number(event.target.value) as EngineOptions['hash'] } })}><option value="auto">Авто</option>{[16, 32, 64].map(value => <option key={value} value={value}>{value} МБ</option>)}</select></label>
      <label className="action-row"><input type="checkbox" checked={settings.engine?.full ?? false} onChange={event => onSettings({ ...settings, engine: { ...settings.engine, full: event.target.checked } })} /> Stockfish Full · около 95 МиБ при первом запуске</label>
      <div className="action-row"><a href="#endgames">Эндшпили</a><a href="#openings">Дебюты</a><a href="#methodology">Методология</a></div>
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
