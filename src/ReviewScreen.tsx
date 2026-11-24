import { Chess, DEFAULT_POSITION, type Color, type Move, type Square } from 'chess.js'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Cpu, Flag, Pause, Play, RotateCcw, ScanLine, Target } from 'lucide-react'
import { Board } from './Board'
import { Chart } from './Charts'
import { budgets } from './engine'
import { gameMoves, isComplete, playerColor, timeLabel, type Game, type Mode } from './library'
import { categories, errors, estimatedRating, evalLabel, expectation, phases, summarize, variation, winProbability, type Category, type Phase } from './review'

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
  game?: Game; initialPly?: number; games: Game[]; nickname: string; mode: Mode; active?: string;
  onQueue: (game: Game, mode: Mode) => void; onPause: (game: Game) => void; onImport: () => void;
}
export function ReviewScreen({ game, initialPly = 0, games, nickname, mode, active, onQueue, onPause, onImport }: Props) {
  const moves = useMemo(() => game ? gameMoves(game) : [], [game?.pgn])
  const [index, setIndex] = useState(() => Math.min(moves.length, initialPly))
  const [orientation, orient] = useState<Color>(game ? playerColor(game, nickname) ?? 'w' : 'w')
  const [branches, setBranches] = useState<Move[]>([])
  const [playing, autoplay] = useState(false)
  const [guided, guide] = useState(false)
  const [speed, setSpeed] = useState<Mode>(game?.mode ?? mode)
  const reviews = game?.reviews ?? []
  const last = moves[index - 1]
  const review = reviews[index - 1]
  const position = branches.at(-1)?.after ?? last?.after ?? game?.initial ?? DEFAULT_POSITION
  const completed = game && isComplete(game)
  const nextPosition = reviews[index]
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
  if (!game) return <div className="panel"><Empty title="Выберите завершённую партию" message="Импортируйте историю или загрузите PGN, чтобы начать разбор."><button className="primary" onClick={onImport}>Импортировать партию</button></Empty></div>

  const landmarks = [...reviews].filter(item => errors.includes(item.category) || ['brilliant','great'].includes(item.category))
  const rankedErrors = landmarks.filter(item => errors.includes(item.category)).sort((a, b) => b.loss - a.loss)
  const bestMoves = [...reviews].filter(item => ['brilliant', 'great'].includes(item.category))
  if (!bestMoves.length) bestMoves.push(...reviews.filter(item => item.category === 'best' && !item.forced).slice(0, 3))
  const nextError = landmarks.find(item => item.index + 1 > index && errors.includes(item.category))
  const nextGuided = landmarks.find(item => item.index + 1 > index)
  const white = summarize(reviews, 'w'), black = summarize(reviews, 'b')
  const main = nextPosition?.before.pv[0] ?? (review?.after.pv[0])
  const winBefore = review && winProbability(review.before, review.color)
  const winAfter = review && winProbability(review.played, review.color)
  function branch(fen: string, pv: string[]) {
    autoplay(false)
    const steps = variation(fen, pv)
    if (!steps.length) return
    setBranches([steps[0]])
  }
  function tryMove(from: Square, to: Square, promotion?: string) {
    const chess = new Chess(position)
    try { setBranches(previous => [...previous, chess.move({ from, to, promotion })]) } catch { /* Board only offers legal moves. */ }
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
        <h2>{game.white} <span>{game.whiteElo}</span> <small>–</small> {game.black} <span>{game.blackElo}</span></h2>
        <p>{game.result} {game.opening ? ' · ' + game.opening[0] + ' ' + game.opening[1] : ''}</p></div>
      <div className="run-controls">
        <select aria-label="Глубина анализа" value={speed} onChange={event => setSpeed(event.target.value as Mode)} disabled={game.queued}>
          {Object.entries(budgets).map(([key, settings]) => <option key={key} value={key}>{settings.label}</option>)}
        </select>
        {game.queued ? <button onClick={() => onPause(game)}><Pause size={16} /> Пауза</button> :
          <button className="primary" disabled={!!completed && game.mode === speed} onClick={() => onQueue(game, speed)}><Cpu size={17} />{completed && game.mode === speed ? 'Анализ готов' : reviews.length && game.mode === speed ? 'Продолжить' : 'Начать анализ'}</button>}
      </div>
      {(game.queued || reviews.length > 0 && !completed) && <label className="progress-label">
        <span>{active === game.id ? 'Анализ Stockfish' : game.queued ? 'В очереди' : 'Приостановлено'}</span><progress max={moves.length} value={reviews.length} /><span>{reviews.length}/{moves.length}</span>
      </label>}
    </section>
    <div className="review-layout">
      <section className="board-column">
        <div className="player-line"><span className={'player-stone ' + (orientation === 'b' ? 'white' : 'black')} />{orientation === 'b' ? game.white : game.black}</div>
        <div className="evaluation-layout">
          <div className="eval-bar" aria-label="Преимущество"><div style={{ height: expectation(review?.after ?? reviews[0]?.before ?? { kind: 'cp', value: 0, depth: 0, pv: [] }, orientation) + '%' }} /><span>{evalLabel(review?.after ?? reviews[0]?.before)}</span></div>
          <Board fen={position} orientation={orientation} last={branches.at(-1) ?? last}
            accent={review && errors.includes(review.category) && !branches.length ? categories[review.category][2] : undefined}
            arrows={main && !branches.length ? [main] : []} onMove={tryMove} />
        </div>
        <div className="player-line"><span className={'player-stone ' + (orientation === 'w' ? 'white' : 'black')} />{orientation === 'w' ? game.white : game.black}</div>
        <div className="board-controls">{controls}</div>
        {branches.length > 0 && <div className="branch"><strong>Вариант</strong> {branches.map(move => move.san).join(' ')}
          <div><button onClick={() => setBranches(branches.slice(0, -1))}><ChevronLeft size={16} /> Ход назад</button>
            <button onClick={() => setBranches([])}><RotateCcw size={16} /> К партии</button></div></div>}
        {reviews.length > 0 && <section className="panel graph-panel"><h3>Преимущество</h3>
          <Chart center={50} values={[expectation(reviews[0].before), ...reviews.map(move => expectation(move.after))]}
            labels={['Старт', ...reviews.map(item => moves[item.index].san + ' · ' + evalLabel(item.after))]} selected={index}
            onSelect={navigate} caption="Ожидаемый результат белых" /></section>}
      </section>
      <div className="review-details">
        <section className="panel coach-card">
          <div className="card-head"><div className="section-icon"><Target size={20} /></div><div><h3>Тренер</h3><p>Разбор позиции</p></div></div>
          {review ? <>
            <div className="move-heading"><Marker category={review.category} /><strong>{last?.san} · {categories[review.category][0]}</strong>
              <span>{review.depth > 0 ? 'Глубина ' + review.depth : 'Терминальная позиция'}</span></div>
            <p>{review.explanation}</p>
            <div className="metric-strip"><div><small>До / после</small><b>{evalLabel(review.before)} / {evalLabel(review.after)}</b></div>
              <div><small>Потеря ожидания</small><b>{number(review.loss)} п. п.</b></div>
              <div><small>Вероятность победы</small><b>{winBefore === undefined || winAfter === undefined ? '—' : percent(winBefore) + ' → ' + percent(winAfter)}</b></div></div>
          </> : <p className="muted">{index ? 'Этот ход ещё не проанализирован.' : 'Выберите ход партии для просмотра объяснения.'}</p>}
          {reviews.length > 0 && <div className="action-row"><button disabled={!nextError} onClick={() => nextError && navigate(nextError.index + 1)}><Flag size={16} /> К ошибке</button>
            <button disabled={!nextGuided && guided} onClick={() => { guide(true); const next = guided ? nextGuided : landmarks[0] ?? reviews[0]; if (next) navigate(next.index + 1) }}>
              {guided ? 'Следующий момент' : 'Пошаговый разбор'}</button></div>}
          {review && <div className="variations"><h4>Варианты до хода</h4>{review.lines.filter(line => line.pv.length > 0).map((line, idx) => {
            const steps = variation(last!.before, line.pv)
            return <div className="pv" key={line.pv[0]}><button onClick={() => branch(last!.before, line.pv)}><strong>{evalLabel(line)}</strong><span>{steps.slice(0, 8).map(step => step.san).join(' ')}</span>{idx === 0 && <small>Лучший</small>}</button>
              {branches[0]?.before === last!.before && branches[0]?.lan === steps[0]?.lan && <div className="pv-steps">{steps.map((step, i) => <button key={i} onClick={() => setBranches(steps.slice(0, i + 1))}>{step.san}</button>)}</div>}</div>
          })}</div>}
        </section>
        <section className="panel move-panel"><h3>Ходы партии <span>{moves.length}</span></h3>
          <div className="move-grid">{moves.map((move, i) => <button key={i} aria-pressed={index === i + 1} onClick={() => navigate(i + 1)}>
            <span>{move.before.split(' ')[5]}{move.color === 'w' ? '.' : '…'}</span>{move.san}{reviews[i] && <Marker category={reviews[i].category} />}</button>)}</div></section>
      </div>
    </div>
    {completed && <div className="review-summary">
      <section className="panel"><h3>Итоги партии</h3>
        <table><thead><tr><th>Показатель</th><th>Белые</th><th>Чёрные</th></tr></thead><tbody>
          <tr><td>Точность</td><td>{percent(white.accuracy)}</td><td>{percent(black.accuracy)}</td></tr>
          <tr><td>ACPL</td><td>{number(white.acpl)} ({white.cpSample})</td><td>{number(black.acpl)} ({black.cpSample})</td></tr>
          <tr><td>Оценка рейтинга</td>{(['w','b'] as const).map(color => {
            const estimate = estimatedRating(game, color, games)
            return <td key={color}>{estimate ? estimate.value + ' (' + estimate.low + '–' + estimate.high + ')' : 'Мало данных'}</td>
          })}</tr>
          {(Object.keys(phases) as Phase[]).map(phase => <tr key={phase}><td>{phases[phase]}</td>
            {(['w','b'] as const).map(color => <td key={color}>{percent(summarize(reviews, color, phase).accuracy)}</td>)}</tr>)}
        </tbody></table>
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
