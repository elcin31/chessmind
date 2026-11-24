import { Chess, type Square } from 'chess.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Lightbulb, Play, RotateCcw, Target } from 'lucide-react'
import { Board } from './Board'
import { Engine } from './engine'
import { db, displayDate, gameMoves, isComplete, playerColor, uci, type Game, type Practice } from './library'
import { Empty, number, percent } from './ReviewScreen'
import { errors, expectation, variation, type Line } from './review'

export function Training({ games, nickname, practice, onPractice, onImport }: {
  games: Game[]; nickname: string; practice: Practice[]; onPractice: (item: Practice) => void; onImport: () => void
}) {
  const tasks = useMemo(() => games.filter(isComplete).flatMap(game => {
    const side = playerColor(game, nickname)
    if (!side) return []
    const moves = gameMoves(game)
    return game.reviews!.filter(review => side === review.color && errors.includes(review.category) && review.before.pv.length).map(review => ({
      id: game.id + ':' + review.index, game, review, moves, move: moves[review.index],
      level: review.before.kind === 'mate' && Math.abs(review.before.value) <= 2 || review.loss >= 25 ? 'Базовый' :
        review.loss >= 12 ? 'Средний' : 'Сложный',
    }))
  }).sort((first, second) => (practice.find(item => item.id === first.id)?.due ?? 0) - (practice.find(item => item.id === second.id)?.due ?? 0)), [games, nickname, practice])
  const [level, setLevel] = useState('')
  const [chosen, choose] = useState<string>()
  const available = tasks.filter(task => !level || task.level === level)
  const task = available.find(item => item.id === chosen) ?? available[0]
  const solved = practice.reduce((sum, item) => sum + item.correct, 0)
  const wrong = practice.reduce((sum, item) => sum + item.wrong, 0)
  const due = tasks.filter(task => (practice.find(item => item.id === task.id)?.due ?? 0) <= Date.now()).length
  return <>
    <div className="kpis">
      <div className="panel"><span>Позиций к повторению</span><strong>{due}</strong></div>
      <div className="panel"><span>Решений</span><strong>{solved}</strong></div>
      <div className="panel"><span>Верные попытки</span><strong>{solved + wrong ? percent(100 * solved / (solved + wrong)) : '—'}</strong></div>
    </div>
    <div className="filters">
      <label>Сложность <select value={level} onChange={event => { setLevel(event.target.value); choose(undefined) }}>
        <option value="">Все уровни</option>{['Базовый','Средний','Сложный'].map(item => <option key={item}>{item}</option>)}
      </select></label>
    </div>
    {task ? <TaskView key={task.id} task={task} onPractice={item => { choose(task.id); onPractice(item) }} next={() => choose(available[(available.findIndex(item => item.id === task.id) + 1) % available.length]?.id)} canNext={available.length > 1} /> :
      <div className="panel"><Empty title="Пока нет задач" message="Разберите партию, указав свой никнейм при импорте или в настройках. Ошибки с найденным улучшением появятся здесь.">
        <button className="primary" onClick={onImport}>Перейти к партиям</button></Empty></div>}
    {practice.length > 0 && <section className="panel history"><h3>История тренировок</h3><table><thead><tr><th>Позиция</th><th>Верно</th><th>Ошибок</th><th>Повторить</th></tr></thead>
      <tbody>{[...practice].sort((a, b) => b.last - a.last).map(item => {
        const matched = tasks.find(entry => entry.id === item.id)
        if (!matched) return null
        return <tr key={item.id}><td><button onClick={() => { setLevel(''); choose(item.id) }}>{matched.game.white} – {matched.game.black} · {matched.move.san}</button></td>
          <td>{item.correct}</td><td>{item.wrong}</td><td>{displayDate(new Date(item.due).toISOString().slice(0, 10))}</td></tr>
      })}</tbody></table></section>}
  </>
}

function TaskView({ task, onPractice, next, canNext }: {
  task: { id: string; game: Game; review: NonNullable<Game['reviews']>[number]; move: ReturnType<typeof gameMoves>[number]; moves: ReturnType<typeof gameMoves>; level: string };
  onPractice: (item: Practice) => void; next: () => void; canNext: boolean
}) {
  const [hint, showHint] = useState(false)
  const [step, setStep] = useState(0)
  const [solution, showSolution] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [solved, setSolved] = useState(false)
  const [pending, setPending] = useState(false)
  const [attemptedWrong, setAttemptedWrong] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  const { move, review, game } = task
  const line = variation(move.before, review.before.pv)
  const sameStrength = (candidate: Line) => {
    const best = review.before
    if (best.kind === 'mate' && candidate.kind !== 'mate') return false
    if (candidate.kind === 'mate') return expectation(candidate, move.color) === 100
    const wdl = !!best.wdl && !!candidate.wdl
    const difference = (best.value - candidate.value) * (move.color === 'w' ? 1 : -1)
    return difference <= 30 && expectation(best, move.color, wdl) - expectation(candidate, move.color, wdl) <= 3
  }
  async function record(correct: boolean) {
    const transaction = (await db).transaction('practice', 'readwrite')
    const now = Date.now()
    const previous = await transaction.store.get(task.id) ?? { id: task.id, correct: 0, wrong: 0, streak: 0, due: now, last: now }
    const streak = correct && !attemptedWrong && !hint ? previous.streak + 1 : 0
    const delay = correct && streak > 0 ? Math.min(30, 2 ** (streak - 1)) * 86_400_000 : 10 * 60_000
    const item = { ...previous, correct: previous.correct + Number(correct), wrong: previous.wrong + Number(!correct), streak, due: now + delay, last: now }
    await transaction.store.put(item)
    await transaction.done
    onPractice(item)
  }
  async function tryMove(from: Square, to: Square, promotion?: string) {
    if (pending || solved || solution) return
    const current = new AbortController()
    controller.current = current
    setPending(true)
    const engine = new Engine(current.signal)
    try {
      const candidate = new Chess(move.before).move({ from, to, promotion })
      const notation = uci(candidate)
      const known = review.lines.find(line => line.pv[0] === notation) ?? (review.played.pv[0] === notation ? review.played : undefined)
      const position = { initial: game.initial, moves: task.moves.slice(0, review.index).map(uci), fen: move.before }
      const evaluated = known ?? (await engine.evaluate(position, game.mode ?? 'standard', review.critical, notation))[0]
      if (current.signal.aborted) return
      const correct = sameStrength(evaluated)
      await record(correct)
      if (correct) { setSolved(true); showSolution(true); setFeedback(candidate.san + ' — верно. Это сильное продолжение.'); setStep(0) }
      else { setFeedback(candidate.san + ' уступает варианту Stockfish. Попробуйте ещё раз.'); setAttemptedWrong(true) }
    } catch (error) {
      if (!current.signal.aborted) setFeedback(error instanceof Error ? error.message : 'Не удалось проверить ход.')
    } finally { engine.close(); if (!current.signal.aborted) setPending(false) }
  }
  return <div className="review-layout training-layout">
    <Board fen={line[step - 1]?.after ?? move.before} orientation={move.color} last={line[step - 1]} arrows={hint && !solution ? [review.before.pv[0]] : []} onMove={!solution ? tryMove : undefined} />
    <section className="panel task-card"><div className="card-head"><div className="section-icon"><Target size={20} /></div><div><h3>Найдите сильный ход</h3><p>{task.level} · Ход {move.color === 'w' ? 'белых' : 'чёрных'}</p></div></div>
      <p>{game.white} – {game.black} · {displayDate(game.date)}</p>
      <p className="muted">{solution ? review.explanation : 'В исходной партии эта позиция привела к потере преимущества. Сделайте свой ход на доске.'}</p>
      {feedback && <p role="status" className={solved ? 'notice good' : 'notice'}>{feedback}</p>}
      {pending && <p role="status">Stockfish проверяет ход…</p>}
      {!solution ? <div className="action-row">
        <button disabled={hint || pending} onClick={() => showHint(true)}><Lightbulb size={16} /> Подсказка</button>
        <button disabled={pending} onClick={async () => { setPending(true); try { await record(false); showSolution(true); setStep(0) } catch { setFeedback('Не удалось сохранить тренировку.') } finally { setPending(false) } }}><Play size={16} /> Показать решение</button>
      </div> : <><p><strong>Продолжение</strong> {line.map(item => item.san).join(' ')}</p>
        <p className="muted">Ожидаемая потеря в партии: {number(review.loss)} п. п.</p>
        <div className="action-row"><button disabled={!step} onClick={() => setStep(0)}><RotateCcw size={16} /> Начало</button>
          <button disabled={step >= line.length} onClick={() => setStep(step + 1)}>По варианту <ChevronRight size={16} /></button>
          <button className="primary" disabled={!canNext} onClick={next}>Следующая задача</button></div></>}
    </section>
  </div>
}
