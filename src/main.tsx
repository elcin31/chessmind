import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_POSITION } from 'chess.js'
import { Activity, ArrowDownToLine, ArrowRight, BookOpen, ChartNoAxesCombined, CircleHelp, Cpu, FolderOpen, House, List, MonitorDown, Settings2, ShieldCheck, Target, Upload, Zap } from 'lucide-react'
import { Board } from './Board'
import { ImportForm } from './Import'
import { Methodology } from './Methodology'
import { Empty, percent, ReviewScreen } from './ReviewScreen'
import { Openings, Statistics } from './Stats'
import { Training } from './Training'
import { budgets } from './engine'
import { db, displayDate, isComplete, parsePgn, playerColor, timeLabel, type Game, type Mode, type Practice } from './library'
import { analyzeGame, categories, summarize, type Line, type Review } from './review'
import './style.css'

const pages = {
  home: { label: 'Главная', icon: House, title: 'Рабочий стол', subtitle: '' },
  games: { label: 'Партии', icon: List, title: 'Мои партии', subtitle: 'Импорт, поиск и история завершённых партий' },
  review: { label: 'Анализ', icon: Activity, title: 'Разбор партии', subtitle: 'Локальный анализ Stockfish' },
  training: { label: 'Тренировки', icon: Target, title: 'Тренажёр ошибок', subtitle: 'Практика на позициях из ваших партий' },
  stats: { label: 'Статистика', icon: ChartNoAxesCombined, title: 'Статистика игрока', subtitle: 'Результаты и качество игры' },
  openings: { label: 'Дебюты', icon: BookOpen, title: 'Дебюты', subtitle: 'Энциклопедия ECO и ваша дебютная практика' },
  settings: { label: 'Настройки', icon: Settings2, title: 'Настройки', subtitle: 'Профиль, анализ и локальные данные' },
  methodology: { label: 'Методология', icon: CircleHelp, title: 'Методология', subtitle: 'Формулы, допущения и источники' },
}
type Page = keyof typeof pages
type Settings = { nickname: string; theme: 'system' | 'light' | 'dark'; mode: Mode }
const core: Page[] = ['home', 'games', 'review', 'training', 'stats']
const secondary: Page[] = ['openings', 'settings', 'methodology']

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
  const current = useRef<{ id: string; controller: AbortController } | undefined>(undefined)
  const state = pages[location.page]
  const sorted = [...games].sort((first, second) => second.date.localeCompare(first.date))
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
    void navigator.serviceWorker.ready.then(() => setOffline(true))
    return () => navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged)
  }, [])

  function mergeGame(updated?: Game) {
    if (updated) setGames(previous => previous.map(game => game.id === updated.id ? updated : game))
  }
  useEffect(() => {
    if (!visible || current.current || active) return
    const pending = games.find(game => game.queued && !isComplete(game))
    if (!pending) return
    const controller = new AbortController()
    current.current = { id: pending.id, controller }
    setActive(pending.id)
    const run = async () => {
      const latest = await (await db).get('games', pending.id)
      if (!latest?.queued || isComplete(latest)) return mergeGame(latest)
      try {
        await analyzeGame(latest, latest.mode ?? 'standard', controller.signal, async reviews => {
          mergeGame(await patchGame(latest.id, { reviews, ...(reviews.length === latest.moves ? { queued: false } : {}) }))
        })
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatus(error instanceof Error ? error.message : 'Ошибка анализа.')
          mergeGame(await patchGame(latest.id, { queued: false }))
        }
      }
    }
    const work = navigator.locks ? navigator.locks.request('chessmind-queue', { signal: controller.signal }, run) : run()
    void work.catch(error => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Ошибка очереди.') }).finally(() => {
      current.current = undefined
      setActive(undefined)
    })
  }, [games, visible, active])

  function open(game: Game, ply?: number) { window.location.hash = 'review/' + game.id + (ply ? '/' + ply : '') }
  function go(page: Page) { window.location.hash = page }
  async function queue(game: Game, mode: Mode) {
    setStatus('')
    try { mergeGame(await patchGame(game.id, { queued: true, mode, ...(game.mode !== mode ? { reviews: [] } : {}) })) }
    catch { setStatus('Не удалось сохранить очередь анализа.') }
  }
  async function pause(game: Game) {
    try {
      mergeGame(await patchGame(game.id, { queued: false }))
      if (current.current?.id === game.id) current.current.controller.abort()
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
      <div className="side-footer"><div><ShieldCheck size={16} /> Данные на устройстве</div><small>ChessMind 1.0</small></div>
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
          navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
          update.postMessage('activate-update')
        }}>Обновить</button></div>}
        {location.page === 'home' && <>
          <section className="hero">
            <div className="hero-copy"><div className="eyebrow"><i /> CHESSMIND 1.0</div>
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
              {sorted.length ? <div className="recent-list">{sorted.slice(0, 3).map(game => <button key={game.id} onClick={() => open(game)}><span><b>{game.white} – {game.black}</b><small>{displayDate(game.date)} · {timeLabel(game.time)}</small></span><ArrowRight size={17} /></button>)}</div> :
                <div className="library-empty"><FolderOpen size={20} /><p>Здесь появятся ваши партии после импорта.</p></div>}
              {sorted.length > 0 && <a className="quiet" href="#games">Все партии <ArrowRight size={16} /></a>}
            </section>
          </div>
          <footer className="home-footer"><span><Cpu size={16} /> Все расчёты на вашем устройстве</span><span><Zap size={16} /> Бесплатно и без лимитов</span><span><MonitorDown size={16} /> Устанавливается как приложение</span></footer>
        </>}
        {location.page === 'games' && <>{importForm}<GameList games={sorted} nickname={settings.nickname} open={open} /></>}
        {location.page === 'review' && <ReviewScreen key={(selected?.id ?? '') + ':' + (location.ply ?? 0)} game={selected} initialPly={location.ply} games={games} nickname={settings.nickname} mode={settings.mode} active={active} onQueue={queue} onPause={pause} onImport={() => go('games')} />}
        {location.page === 'training' && <Training games={games} nickname={settings.nickname} practice={practice} onPractice={item => setPractice(old => [...old.filter(entry => entry.id !== item.id), item])} onImport={() => go('games')} />}
        {location.page === 'stats' && <Statistics games={games} nickname={settings.nickname} open={open} />}
        {location.page === 'openings' && <Openings games={games} nickname={settings.nickname} open={open} />}
        {location.page === 'settings' && <Preferences settings={settings} onSettings={setSettings} setGames={setGames} setPractice={setPractice} offline={offline} />}
        {location.page === 'methodology' && <Methodology />}
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Основные разделы">{navigation(core)}</nav>
  </div>
}

function GameList({ games, nickname, open }: { games: Game[]; nickname: string; open: (game: Game) => void }) {
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
    {!shown.length && <Empty title={games.length ? 'Партии не найдены' : 'Библиотека пуста'} message={games.length ? 'Измените параметры поиска.' : 'Выберите источник импорта выше.'} />}
    <div className="game-rows">{shown.slice(0, limit).map(game => {
      const side = playerColor(game, nickname)
      const opponent = side === 'w' ? [game.black, game.blackElo] : side === 'b' ? [game.white, game.whiteElo] : []
      const white = isComplete(game) ? summarize(game.reviews!, 'w') : undefined
      const black = isComplete(game) ? summarize(game.reviews!, 'b') : undefined
      return <button className="game-row" key={game.id} onClick={() => open(game)}>
        <span className="game-players"><b>{game.white} {game.whiteElo && <small>{game.whiteElo}</small>} – {game.black} {game.blackElo && <small>{game.blackElo}</small>}</b>
          <small>{side ? 'Ваш цвет: ' + (side === 'w' ? 'белые' : 'чёрные') + ' · Соперник: ' + opponent.filter(Boolean).join(' ') : game.source === 'pgn' ? 'PGN' : game.source === 'chesscom' ? 'Chess.com' : 'Lichess'}</small></span>
        <span className="game-meta"><b>{game.result}</b><small>{displayDate(game.date)} · {timeLabel(game.time)}</small></span>
        <span className="game-meta"><b>{game.opening ? game.opening.slice(0, 2).join(' ') : 'Дебют неизвестен'}</b><small>{game.moves} полуходов</small></span>
        <span className="game-meta"><b>{game.queued ? 'В очереди' : isComplete(game) ? 'Разобрана' : game.reviews?.length ? 'Приостановлена' : 'Без анализа'}</b>
          {white && black && <small>Точность Б / Ч · {percent(white.accuracy)} / {percent(black.accuracy)}</small>}</span><ArrowRight size={18} />
      </button>
    })}</div>
    {shown.length > limit && <button className="quiet" onClick={() => setLimit(limit + 30)}>Показать ещё</button>}
  </section>
}

function validLine(value: Line) {
  return value && ['mate', 'cp'].includes(value.kind) && Number.isFinite(value.value) && Number.isFinite(value.depth) &&
    Array.isArray(value.pv) && value.pv.every(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) &&
    (!value.wdl || Array.isArray(value.wdl) && value.wdl.length === 3 && value.wdl.every(Number.isFinite))
}

function Preferences({ settings, onSettings, setGames, setPractice, offline }: {
  settings: Settings; onSettings: (value: Settings) => void; setGames: (games: Game[]) => void; setPractice: (practice: Practice[]) => void; offline: boolean
}) {
  const [message, setMessage] = useState('')
  async function backup() {
    try {
      const storage = await db
      const snapshot = { version: 1, games: await storage.getAll('games'), practice: await storage.getAll('practice'), settings }
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
      if (json.version !== 1 || !Array.isArray(json.games) || !Array.isArray(json.practice)) throw new Error('Неверный формат резервной копии.')
      const restored: Game[] = []
      for (const row of json.games as Game[]) {
        if (!['chesscom', 'lichess', 'pgn'].includes(row.source) || typeof row.pgn !== 'string') throw new Error('Копия содержит некорректную партию.')
        const game = await parsePgn(row.pgn, row.source, typeof row.owner === 'string' ? row.owner : undefined)
        if (row.id !== game.id) throw new Error('Контрольная сумма партии не совпадает.')
        const reviews = row.reviews
        if (reviews && (!Array.isArray(reviews) || reviews.length > game.moves || !reviews.every((item: Review, index: number) =>
          item.index === index && Object.hasOwn(categories, item.category) && ['w','b'].includes(item.color) &&
          ['opening','middle','end'].includes(item.phase) && [item.loss, item.accuracy, item.depth].every(Number.isFinite) &&
          (item.cpLoss === null || Number.isFinite(item.cpLoss)) && [item.before,item.after,item.played].every(validLine) &&
          Array.isArray(item.lines) && item.lines.every(validLine) && typeof item.explanation === 'string'))) throw new Error('Копия содержит некорректный анализ.')
        restored.push({ ...game, mode: row.mode && Object.hasOwn(budgets, row.mode) ? row.mode : undefined, reviews })
      }
      const storage = await db
      const known = new Set(restored.map(game => game.id))
      const tx = storage.transaction(['games','practice'], 'readwrite')
      for (const game of restored) {
        const previous = await tx.objectStore('games').get(game.id)
        if (!previous || !previous.queued && (previous.reviews?.length ?? 0) < (game.reviews?.length ?? 0)) await tx.objectStore('games').put(game)
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
        onSettings({ nickname: json.settings.nickname, theme: json.settings.theme, mode: json.settings.mode })
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
      <div className="action-row"><a href="#openings">Дебюты</a><a href="#methodology">Методология</a></div>
    </section>
    <section className="panel"><h2>Хранение и установка</h2><p>{offline ? 'Движок и интерфейс доступны офлайн.' : 'Офлайн-режим готовится при первом открытии опубликованного приложения.'}</p>
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
