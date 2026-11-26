import { withAnalysisLock } from './analysisQueue'
import { Chess, DEFAULT_POSITION, type Color, type Move, type Square } from 'chess.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Cpu, Flag, Pause, Play, RotateCcw, ScanLine, Target } from 'lucide-react'
import { cloudBlocker, cloudState, useCloudStatus } from './cloudClient'
import { ComputeSelect, computeLabels } from './ComputeSettings'
import { cloudOptions, referenceFor, supportedCloudMode, type ComputeSource } from './cloudProtocol'
import { AnalysisProgress, useLiveReview } from './AnalysisProgress'
import { inspectDraft, validDraft } from './progressive'
import { focusAnalysis } from './searchPool'
import { PlayerBadge } from './PlayerCard'
import { profileSource } from './playerProfiles'
import { Board } from './Board'
import { Chart } from './Charts'
import { coachingPrinciple } from './coach'
import { annotatedPgn, readClocks } from './pgn'
import { budgets } from './engine'
import { adaptiveMode, analysisKey, methodologyVersion, reviewMode, reviewModes, gameMoves, isComplete, playerColor, timeLabel, type EngineOptions, type Game, type Mode } from './library'
import { categories, errors, estimatedRating, evalLabel, expectation, phases, material, recheckMove, summarize, variation, type Review, type Category, type Phase } from './review'

export const percent = (value?: number) => value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%'
export const number = (value?: number) => value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
export function Marker({ category }: { category: Category }) {
  const [label, symbol, color] = categories[category]
  return <span className="marker" style={{ color }} title={label}>{symbol}</span>
}
export function Empty({ title, message, children }: { title: string; message?: string; children?: React.ReactNode }) {
  return <div className="empty"><ScanLine size={28} strokeWidth={1.5} /><h3>{title}</h3>{message && <p>{message}</p>}{children}</div>
}

type Props = {
  game?: Game; initialPly?: number; games: Game[]; nickname: string; mode: Mode; active?: string; options?: EngineOptions;
  preferredSource: ComputeSource; onQueue: (game: Game, mode: Mode, source: ComputeSource, eco?: boolean) => void; onPause: (game: Game) => void; onImport: () => void;
}
export function ReviewScreen({ game: base, initialPly = 0, games, nickname, mode, active, options, preferredSource, onQueue, onPause, onImport }: Props) {
  const [snapshot, setSnapshot] = useState('')
  const saved = base?.savedAnalyses?.find(item => analysisKey(item) === snapshot)
  const game = saved && base ? { ...base, ...saved } : base
  const moves = useMemo(() => game ? gameMoves(game) : [], [game?.pgn])
  const [index, setIndex] = useState(() => Math.min(moves.length, initialPly))
  const [orientation, orient] = useState<Color>(game ? playerColor(game, nickname) ?? 'w' : 'w')
  const [branches, setBranches] = useState<Move[]>([])
  const [playing, autoplay] = useState(false)
  const [guided, guide] = useState(false)
  const [speed, setSpeed] = useState<Mode>(reviewMode(game?.mode ?? mode))
  const [computeSource, setComputeSource] = useState<ComputeSource>(base?.queueSource ?? preferredSource)
  const requestsCloud = !!base && supportedCloudMode(speed) && !!referenceFor(base) &&
    (computeSource !== 'local' || base.compute === 'cloud')
  const cloud = useCloudStatus(requestsCloud)
  const [compact, setCompact] = useState(false)
  const [graph, setGraph] = useState<'points' | 'cp'>('points')
  const [checked, setChecked] = useState<Record<number, Review>>({})
  const [checking, setChecking] = useState<number>()
  const [checkError, setCheckError] = useState('')
  const controller = useRef<AbortController>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  const clocks = useMemo(() => game && /%clk|%emt/.test(game.pgn) ? readClocks(game.pgn, moves, game.time) : [], [game?.pgn, moves, game?.time])
  const live = useLiveReview(base?.id)
  const draft = !saved && base ? live ?? validDraft(base.compute === 'cloud' ? { ...base, draft: base.cloudDraft } : base) : undefined
  const finished = !!game && isComplete(game)
  const byIndex = useMemo(() => !game ? [] : moves.map((_, i) =>
    game.reviews?.[i] ?? (!finished && draft ? inspectDraft(game, draft, i, moves) : undefined)),
  [game?.id, game?.reviews, game?.mode, game?.options, game?.compute, game?.methodology, draft, moves, finished])
  const reviews = useMemo(() => byIndex.filter((item): item is Review => !!item), [byIndex])
  useEffect(() => {
    if (!base?.id || saved || index === 0) return
    focusAnalysis(base.id, Math.max(0, index - 1))
    return () => focusAnalysis(base.id)
  }, [base?.id, index, saved])
  const last = moves[index - 1]
  const verified = !saved ? checked[index - 1] : undefined
  const review = verified ?? byIndex[index - 1]
  const position = branches.at(-1)?.after ?? last?.after ?? game?.initial ?? DEFAULT_POSITION
  const completed = finished
  const arrow = byIndex[index]?.before.pv[0] ?? draft?.instant[index]?.pv[0] ?? review?.after.pv[0]
  const arrows = useMemo(() => arrow && !branches.length ? [arrow] : [], [arrow, branches.length])
  const materialBalance = useMemo(() => material(new Chess(position), 'w'), [position])
  const swipe = useCallback((direction: -1 | 1) => {
    setBranches([])
    setIndex(previous => Math.max(0, Math.min(moves.length, previous + direction)))
  }, [moves.length])
  const navigable = (i: number) => Math.max(0, Math.min(moves.length, i))
  function navigate(i: number) { setBranches([]); setIndex(navigable(i)) }
  useEffect(() => {
    if (!playing || index >= moves.length) return
    const timer = setTimeout(() => { setBranches([]); setIndex(index + 1); if (index + 1 === moves.length) autoplay(false) }, 900)
    return () => clearTimeout(timer)
  }, [playing, index, moves.length])
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if ((event.target as HTMLElement)?.closest('input, textarea, select, button, [contenteditable]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        setBranches([])
        setIndex(previous => Math.min(moves.length, Math.max(0, previous + (event.key === 'ArrowLeft' ? -1 : 1))))
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [moves.length])
  const tryMove = useCallback((from: Square, to: Square, promotion?: string) => {
    const chess = new Chess(position)
    try { setBranches(previous => [...previous, chess.move({ from, to, promotion })]) } catch { /* Board only offers legal moves. */ }
  }, [position])
  if (!game) return <div className="panel"><Empty title="Выберите завершённую партию" message="Импортируйте историю или загрузите PGN, чтобы начать разбор."><button className="primary" onClick={onImport}>Импортировать партию</button></Empty></div>

  const owner = playerColor(game, nickname)
  const source = profileSource(game)
  const player = (color: Color) => <PlayerBadge key={color + ':' + game.id} source={source}
    name={color === 'w' ? game.white : game.black} rating={color === 'w' ? game.whiteElo : game.blackElo} color={color} owner={owner === color} />
  const landmarks = [...reviews].filter(item => errors.includes(item.category) || ['brilliant','great'].includes(item.category))
  const rankedErrors = landmarks.filter(item => errors.includes(item.category)).sort((a, b) => b.loss - a.loss)
  const bestMoves = [...reviews].filter(item => ['brilliant', 'great'].includes(item.category))
  if (!bestMoves.length) bestMoves.push(...reviews.filter(item => item.category === 'best' && !item.forced).slice(0, 3))
  const nextError = landmarks.find(item => item.index + 1 > index && errors.includes(item.category))
  const nextGuided = landmarks.find(item => item.index + 1 > index)
  const white = summarize(reviews, 'w'), black = summarize(reviews, 'b')
  const ready = reviews.at(-1)
  const instantCount = draft?.instant.filter(Boolean).length ?? 0
  const chart = Array.from({ length: moves.length + 1 }, (_, ply) => {
    const line = (ply ? byIndex[ply - 1]?.after : byIndex[0]?.before) ?? draft?.instant[ply]
    return line ? [{ line, ply }] : []
  }).flat()
  const clock = clocks[index - 1]
  const pressureErrors = rankedErrors.filter(item => {
    const remaining = clocks[item.index]?.remaining
    return remaining !== undefined && remaining <= 30
  })
  const compute = computeSource === 'auto' ? (game.compute ?? 'local') : computeSource
  const sameProfile = !!base && analysisKey(base) === analysisKey({ methodology: methodologyVersion, mode: speed, compute, options: compute === 'cloud' ? cloudOptions : options })
  const changedEnergy = (game.options?.energy ?? 'balanced') !== (options?.energy ?? 'balanced')
  const hasCloudResult = [game, ...game.savedAnalyses ?? []].some(item =>
    item.reviews?.length === game.moves && analysisKey(item) ===
      analysisKey({ methodology: methodologyVersion, mode: speed, compute: 'cloud', options: cloudOptions }))
  const blocker = computeSource !== 'local' && !hasCloudResult ? cloudBlocker(game, speed, cloud) : undefined
  const offerLocal = !saved && !game.queued && (computeSource === 'cloud' && !!blocker ||
    !completed && base?.compute === 'cloud' && active !== game.id)
  const switchLocal = () => { setComputeSource('local'); onQueue(game, speed, 'local') }
  async function verify() {
    if (!game || !review) return
    const current = new AbortController()
    controller.current = current
    const moveIndex = index - 1
    setChecking(moveIndex)
    setCheckError('')
    try {
      const execute = () => recheckMove({ ...game, options }, moveIndex, current.signal)
      const updated = await withAnalysisLock(current, execute)
      if (updated && !current.signal.aborted) setChecked(previous => ({ ...previous, [moveIndex]: updated }))
    } catch (error) {
      if (!current.signal.aborted) setCheckError(error instanceof Error ? error.message : 'Не удалось перепроверить ход.')
    } finally { setChecking(undefined) }
  }
  function download() {
    if (!game) return
    const url = URL.createObjectURL(new Blob([annotatedPgn(game, byIndex.map(item => item?.preliminary ? undefined : item))], { type: 'application/x-chess-pgn;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'chessmind-' + game.id.slice(0, 8) + '.pgn'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function branch(fen: string, pv: string[]) {
    autoplay(false)
    const steps = variation(fen, pv)
    if (!steps.length) return
    setBranches([steps[0]])
  }

  const controls = <>
    <button className="icon-btn" aria-label="Начало партии" onClick={() => navigate(0)}><ChevronFirst /></button>
    <button className="icon-btn" aria-label="Назад" onClick={() => navigate(index - 1)}><ChevronLeft /></button>
    <button className="icon-btn" aria-label={playing ? 'Пауза воспроизведения' : 'Воспроизвести'} onClick={() => { if (index === moves.length) navigate(0); autoplay(!playing) }}>{playing ? <Pause /> : <Play />}</button>
    <button className="icon-btn" aria-label="Вперёд" onClick={() => navigate(index + 1)}><ChevronRight /></button>
    <button className="icon-btn" aria-label="Конец партии" onClick={() => navigate(moves.length)}><ChevronLast /></button>
    <button className="icon-btn" aria-label="Перевернуть доску" onClick={() => orient(orientation === 'w' ? 'b' : 'w')}><ArrowLeftRight /></button>
  </>
  return <>
    <section className="panel review-header">
      <div><div className="eyebrow">{game.source === 'chesscom' ? 'Chess.com' : game.source === 'lichess' ? 'Lichess' : 'PGN'} · {timeLabel(game.time)}</div>
        <h2>{game.white} <span>{game.whiteElo ?? '—'}</span> <small>–</small> {game.black} <span>{game.blackElo ?? '—'}</span></h2>
        <p>{game.result} {game.opening ? ' · ' + game.opening[0] + ' ' + game.opening[1] : ''}</p></div>
      <div className="run-controls">
        <ComputeSelect value={computeSource} onChange={setComputeSource} disabled={!!saved || checking !== undefined} />
        {base?.savedAnalyses?.length ? <select aria-label="Сохранённый анализ" value={saved ? snapshot : ''} onChange={event => setSnapshot(event.target.value)}>
          <option value="">Текущий анализ</option>
          {base.savedAnalyses.map(item => <option key={analysisKey(item)} value={analysisKey(item)}>
            {item.methodology ?? 1}.0 · {computeLabels[item.compute ?? 'local']} · {budgets[item.mode].label} · {item.reviews.length} ходов · {item.mode !== 'lite' && item.options?.full ? 'Full' : 'Lite'} · {item.mode === 'professional' ? item.options?.multiplier ?? 1 : 1}×
          </option>)}
        </select> : null}
        <select aria-label="Тип разбора" value={speed} onChange={event => setSpeed(event.target.value as Mode)} disabled={!!saved || checking !== undefined}>
          {Object.entries(reviewModes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {!saved && (game.queued || active === game.id) && <button onClick={() => onPause(game)}><Pause size={16} /> Пауза</button>}
        {game.queued && !saved && (game.mode !== speed || (game.queueSource ?? 'local') !== computeSource || compute !== 'cloud' && changedEnergy) && <button className="primary" onClick={() => onQueue(game, speed, computeSource)}>Сменить режим</button>}
        {!game.queued &&
          <button className="primary" disabled={!!saved || checking !== undefined || !!completed && sameProfile || computeSource === 'cloud' && !!blocker} onClick={() => onQueue(game, speed, computeSource)}><Cpu size={17} />{completed && sameProfile ? 'Анализ готов' : (reviews.length || instantCount || draft?.interrupted) && sameProfile ? 'Продолжить' : 'Начать анализ'}</button>}
        {reviews.some(item => !item.preliminary) && <button onClick={download}>PGN с разбором</button>}
      </div>
      {!saved && computeSource !== 'local' && <div className="preview-summary" role="status">
        <span>{hasCloudResult ? 'Облачный результат сохранён на устройстве.' : blocker ?? cloudState(cloud)}</span>
      </div>}
      {!saved && !game.queued && game.loadPaused &&
        <button onClick={() => { setComputeSource('local'); onQueue(game, speed, 'local', true) }}>Продолжить в Eco</button>}
      {draft?.interrupted && !completed && <p className="muted">Поиск прерван на позиции {draft.interrupted.index + 1}.
        {draft.interrupted.line && ' Сохранена предварительная оценка с глубины ' + draft.interrupted.line.depth + '.'}</p>}
      {game.mode && !adaptiveMode(game.mode) && (game.reviews?.length || draft) && <p className="muted">
        Сохранённый режим {budgets[game.mode].label}{game.mode === 'lite' ? ' · облегчённый анализ с одним вариантом' : ''}.
      </p>}
      {offerLocal && <button onClick={switchLocal}>Продолжить на устройстве</button>}
      {!saved && !completed && (game.queued || active === game.id || draft?.interrupted || reviews.some(item => !item.preliminary) || !!instantCount && instantCount < moves.length + 1) && <>
        <AnalysisProgress id={game.id} initial={instantCount} checked={reviews.filter(item => !item.preliminary).length} total={moves.length}
          running={active === game.id} queued={!!game.queued} />
      </>}
      {!completed && ready && ready.index + 1 > index && <button className="jump-analyzed" onClick={() => navigate(ready.index + 1)}>К последнему готовому ходу</button>}
      {!saved && !completed && instantCount === moves.length + 1 && <div className="preview-summary" data-preview-ready>
        <strong>Предварительный проход завершён</strong><span>Итоги появятся после сравнения сыгранных ходов с альтернативами.</span>
        {rankedErrors.length > 0 && <button onClick={() => navigate(rankedErrors[0].index + 1)}>К переломному моменту</button>}
      </div>}
      {completed && <p className="analysis-finished">Анализ завершён · {computeLabels[game.compute ?? 'local']}</p>}
      {completed && saved && <p className="muted">Открыт ранее сохранённый разбор.</p>}
      {completed && !saved && game.compute === 'cloud' && game.cloudCacheHit && <p className="muted">Найден готовый анализ в кэше.</p>}
    </section>
    <div className="review-layout">
      <section className="board-column">
        <div className="player-line">{player(orientation === 'b' ? 'w' : 'b')}</div>
        <div className="evaluation-layout">
          <div className="eval-bar" aria-label="Преимущество"><div style={{ height: expectation(review?.after ?? draft?.instant[index] ?? byIndex[0]?.before ?? { kind: 'cp', value: 0, depth: 0, pv: [] }, orientation) + '%' }} /><span>{evalLabel(review?.after ?? draft?.instant[index] ?? byIndex[0]?.before)}</span></div>
          <Board fen={position} orientation={orientation} last={branches.at(-1) ?? last}
            accent={review && errors.includes(review.category) && !branches.length ? categories[review.category][2] : undefined}
            arrows={arrows} onMove={tryMove} onSwipe={swipe} />
        </div>
        <div className="player-line">{player(orientation)}</div>
        <div className="board-controls">{controls}</div>
        <div className="board-context"><strong>{last ? last.before.split(' ')[5] + (last.color === 'w' ? '. ' : '… ') + last.san : 'Начальная позиция'}</strong>
          <span>Материал Б/Ч {materialBalance > 0 ? '+' : ''}{materialBalance}</span>
          {clock?.spent !== undefined && <span>{number(clock.spent)} с на ход</span>}
          {clock?.remaining !== undefined && <span>{number(clock.remaining)} с на часах</span>}
        </div>
        {branches.length > 0 && <div className="branch"><strong>Вариант</strong> {branches.map(move => move.san).join(' ')}
          <div><button onClick={() => setBranches(branches.slice(0, -1))}><ChevronLeft size={16} /> Ход назад</button>
            <button onClick={() => setBranches([])}><RotateCcw size={16} /> К партии</button></div></div>}
        {chart.length > 0 && <section className="panel graph-panel"><div className="list-heading"><h3>График партии{!completed && draft ? ' · предварительный' : ''}</h3>
          <select aria-label="Величина на графике" value={graph} onChange={event => setGraph(event.target.value as 'points' | 'cp')}>
            <option value="points">Ожидаемые очки</option><option value="cp">Оценка в пешках</option>
          </select></div>
          <Chart center={graph === 'points' ? 50 : undefined} values={chart.map(({ line }) =>
            graph === 'points' ? expectation(line) : line.kind === 'mate' ? Math.sign(line.value) * 12 : Math.max(-12, Math.min(12, line.value / 100)))}
            labels={chart.map(({ ply, line }) => (ply ? moves[ply - 1].san : 'Старт') + ' · ' + evalLabel(line))}
            selected={chart.some(item => item.ply === index) ? chart.findIndex(item => item.ply === index) : undefined}
            onSelect={point => navigate(chart[point].ply)} caption={graph === 'points' ? 'Ожидаемый результат белых' : 'Оценка белых · шкала ±12, мат на границе'} /></section>}

      </section>
      <div className="review-details">
        <section className="panel coach-card">
          <div className="card-head"><div className="section-icon"><Target size={20} /></div><div><h3>Тренер</h3><p>Разбор позиции</p></div></div>
          {review ? <>
            <div className="move-heading">{review.preliminary ? <span className="marker">≈</span> : <Marker category={review.category} />}
              <strong>{last?.san} · {review.preliminary ? errors.includes(review.category) ? 'Возможная ошибка' : 'Предварительная оценка' : categories[review.category][0]}</strong>
</div>
            <p>{review.explanation}</p>
            {game.mode === 'deep-review' && review.critical && last && !review.preliminary &&
              review.before.pv[0] !== review.played.pv[0] && review.after.pv.length > 0 &&
              <p>После {last.san} ответ соперника в расчёте Stockfish — {variation(last.after, review.after.pv, 5).map(step => step.san).join(' ')}.</p>}
            {coachingPrinciple(review.motif) && <p className="muted">{coachingPrinciple(review.motif)}</p>}
            {review.draw && <p className="notice">{review.draw}</p>}
            {review.reliable === false && <p className="notice">Ограниченная надёжность оценки. Категория и потеря ожидания могут измениться после перепроверки.</p>}
            {verified && <p className="muted">Перепроверка Professional · {verified.before.engine ?? 'Stockfish'}. Сводная статистика использует исходный разбор.</p>}
            {review.reasons && <details><summary>Основания категории · сложность {review.complexity?.toLowerCase()}</summary>
              <ul>{review.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            </details>}
            {review.depth > 0 && <details><summary>Параметры оценки</summary>
              <div className="analysis-counts"><span>Глубина {review.depth}</span><span>MultiPV {review.lines.length}</span>
                {review.before.nodes !== undefined && <span>{review.before.nodes.toLocaleString('ru-RU')} узлов в сравнении</span>}
                {review.before.engine && <span>{review.before.engine}</span>}</div>
            </details>}
            {review.played.wdl && <div className="wdl" aria-label="WDL после выбора хода">
              {[['Победа', review.color === 'w' ? 0 : 2], ['Ничья', 1], ['Поражение', review.color === 'w' ? 2 : 0]].map(([label, i]) =>
                <div key={label}><span>{label}</span><strong>{percent(review.played.wdl![Number(i)] / 10)}</strong></div>)}
            </div>}
            <div className="metric-strip"><div><small>{review.preliminary ? 'До и после хода' : 'Лучший / сыгранный'}</small><b>{evalLabel(review.before)} / {evalLabel(review.preliminary ? review.after : review.played)}</b></div>
              <div><small>Потеря ожидания</small><b>{number(review.loss)} п. п.</b></div>
              <div><small>Ожидание игрока</small><b>{percent(expectation(review.before, review.color, !!review.before.wdl && !!review.played.wdl))} → {percent(expectation(review.played, review.color, !!review.before.wdl && !!review.played.wdl))}</b></div></div>
            <div className="action-row">{checking !== undefined ? <button onClick={() => controller.current?.abort()}>Остановить перепроверку</button> :
              <button disabled={!!active || !!saved} onClick={() => void verify()}>{game.compute === 'cloud' ? 'Перепроверить на устройстве' : 'Перепроверить ход'}</button>}</div>
            {checkError && <p role="alert">{checkError}</p>}
            {checking !== undefined && <p role="status">Stockfish перепроверяет ход…</p>}
          </> : <p className="muted">{index ? 'Этот ход ещё не проанализирован.' : 'Выберите ход партии для просмотра объяснения.'}</p>}
          {reviews.length > 0 && <div className="action-row"><button disabled={!nextError} onClick={() => nextError && navigate(nextError.index + 1)}><Flag size={16} /> К ошибке</button>
            <button disabled={!nextGuided && guided} onClick={() => { guide(true); const next = guided ? nextGuided : landmarks[0] ?? reviews[0]; if (next) navigate(next.index + 1) }}>
              {guided ? 'Следующий момент' : 'Пошаговый разбор'}</button></div>}
          {review && <div className="variations"><h4>{review.preliminary ? 'Предварительное продолжение' : 'Сравнение вариантов'}</h4>{(review.preliminary || review.lines.some(line => line.pv[0] === review.played.pv[0]) ? review.lines : [...review.lines, review.played]).filter(line => line.pv.length > 0).map((line, idx) => {
            const steps = variation(last!.before, line.pv)
            return <div className="pv" key={line.pv[0]}><button onClick={() => branch(last!.before, line.pv)}><strong>{evalLabel(line)}</strong><span>{steps.slice(0, 8).map(step => step.san).join(' ')}</span>{(idx === 0 || line.pv[0] === review.played.pv[0]) && <small>{idx === 0 ? 'Лучший' : 'Сыгранный'}{idx === 0 && line.pv[0] === review.played.pv[0] ? ' · сыгранный' : ''}</small>}</button>
              {branches[0]?.before === last!.before && branches[0]?.lan === steps[0]?.lan && <div className="pv-steps">{steps.map((step, i) => <button key={i} onClick={() => setBranches(steps.slice(0, i + 1))}>{step.san}</button>)}</div>}</div>
          })}</div>}
        </section>
        <section className="panel move-panel"><div className="list-heading"><h3>Ходы партии <span>{moves.length}</span></h3>
          <button aria-pressed={compact} onClick={() => setCompact(!compact)}>{compact ? 'Только важные' : 'Все ходы'}</button></div>
          <div className="move-grid">{moves.map((move, i) => (!compact || landmarks.some(item => item.index === i)) && <button key={i} aria-pressed={index === i + 1} onClick={() => navigate(i + 1)}>
            <span>{move.before.split(' ')[5]}{move.color === 'w' ? '.' : '…'}</span>{move.san}{byIndex[i]?.preliminary ? errors.includes(byIndex[i]!.category) && <span className="marker" title="Возможная ошибка">≈</span> :
              byIndex[i] && <Marker category={byIndex[i]!.category} />}</button>)}</div></section>
      </div>
    </div>
    {completed && <div className="review-summary">
      <section className="panel"><h3>Итоги партии <small>· Методология {game.methodology ?? 1}.0</small></h3>
        <table><thead><tr><th>Показатель</th><th>Белые</th><th>Чёрные</th></tr></thead><tbody>
          <tr><td>Точность</td><td>{percent(white.accuracy)}</td><td>{percent(black.accuracy)}</td></tr>
          {(white.limited > 0 || black.limited > 0) && <tr><td>Ходы с ограниченной надёжностью</td><td>{white.limited}/{white.sample}</td><td>{black.limited}/{black.sample}</td></tr>}
          <tr><td>ACPL</td><td>{number(white.acpl)} ({white.cpSample})</td><td>{number(black.acpl)} ({black.cpSample})</td></tr>
          <tr><td>Средняя потеря ожидания</td><td>{number(white.esl)} п. п.</td><td>{number(black.esl)} п. п.</td></tr>
          <tr><td>Разброс точности</td><td>{number(white.deviation)}</td><td>{number(black.deviation)}</td></tr>
          <tr><td>Оценка рейтинга</td>{(['w','b'] as const).map(color => {
            const estimate = estimatedRating(game, color, games)
            return <td key={color}>{estimate ? estimate.value + ' (' + estimate.low + '–' + estimate.high + ')' : 'Мало данных'}</td>
          })}</tr>
          {(Object.keys(phases) as Phase[]).map(phase => <tr key={phase}><td>{phases[phase]}</td>
            {(['w','b'] as const).map(color => <td key={color}>{percent(summarize(reviews, color, phase).accuracy)}</td>)}</tr>)}
        </tbody></table>
        {clocks.some(item => item.remaining !== undefined) && <p>Ошибки при ≤30 с после хода: {pressureErrors.length}. {pressureErrors[0] && <button onClick={() => navigate(pressureErrors[0].index + 1)}>К первой</button>}</p>}
        <h4>Ключевые моменты</h4>
        {rankedErrors.length === 0 && <p className="muted">Движок не выявил ходов, превышающих пороги ошибок.</p>}
        {[...rankedErrors.slice(0, 3), ...bestMoves.slice(0, 3)].map(item => <button className="landmark" key={item.index} onClick={() => { navigate(item.index + 1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Marker category={item.category} /> {moves[item.index].san}<span>{item.motif ?? categories[item.category][0]}</span></button>)}
        {rankedErrors[0] && <p className="summary-note">Главный перелом — {moves[rankedErrors[0].index].san}, потеря {number(rankedErrors[0].loss)} п. п. {rankedErrors[0].motif ? 'Тема для тренировки: ' + rankedErrors[0].motif + '.' : 'Повторите эту позицию в тренажёре.'}</p>}
      </section>
      <section className="panel"><h3>Качество ходов</h3><table><thead><tr><th>Категория</th><th>Белые</th><th>Чёрные</th></tr></thead><tbody>
        {(Object.keys(categories) as Category[]).map(category => <tr key={category}><td><Marker category={category} /> {categories[category][0]}</td><td>{white.counts[category]}</td><td>{black.counts[category]}</td></tr>)}
      </tbody></table></section>
    </div>}
  </>
}
