import { withAnalysisLock } from './analysisQueue'
import { Chess, type Move, type Square } from 'chess.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Lightbulb, Play, RotateCcw, Target } from 'lucide-react'
import { Board } from './Board'
import { Engine } from './engine'
import { db, displayDate, gameMoves, isComplete, playerColor, uci, type Game, type Practice } from './library'
import { Empty, number, percent } from './ReviewScreen'
import { errors, expectation, variation, type Line } from './review'

const modes = {
  mistakes: 'Мои ошибки', tactics: 'Тактика', best: 'Лучший ход', convert: 'Реализация перевеса',
  defend: 'Защита', mate: 'Матовые комбинации', endings: 'Эндшпили', opening: 'Дебютная практика',
}
const tacticalMotifs = ['Вилка', 'Двойной удар', 'Связка', 'Вскрытая атака', 'Перегрузка', 'Сквозной удар', 'Уничтожение защиты', 'Тактическая жертва']
type TaskMode = keyof typeof modes

export function Training({ games, nickname, practice, onPractice, onImport }: {
  games: Game[]; nickname: string; practice: Practice[]; onPractice: (item: Practice) => void; onImport: () => void
}) {
  const [mode, setMode] = useState<TaskMode>('mistakes')
  const [motif, setMotif] = useState('')
  const [daily, setDaily] = useState(false)
  const history = useMemo(() => new Map(practice.map(item => [item.id, item])), [practice])
  const tasks = useMemo(() => games.filter(isComplete).flatMap(game => {
    const side = playerColor(game, nickname)
    if (!side) return []
    const moves = gameMoves(game)
    return game.reviews!.filter(review => side === review.color && !review.forced && review.before.pv.length && (review.reliable !== false || review.depth >= 10)).map(review => ({
      id: game.id + ':' + review.index, game, review, moves, move: moves[review.index],
      level: review.before.kind === 'mate' && Math.abs(review.before.value) <= 2 || review.loss >= 25 ? 'Базовый' :
        review.loss >= 12 ? 'Средний' : 'Сложный',
    }))
  }).sort((first, second) => (history.get(first.id)?.due ?? 0) - (history.get(second.id)?.due ?? 0)), [games, nickname, history])
  const exercises = tasks.filter(({ review }) => {
    const expected = expectation(review.before, review.color)
    switch (mode) {
      case 'mistakes': return errors.includes(review.category)
      case 'tactics': return !!review.motif && tacticalMotifs.includes(review.motif)
      case 'best': return true
      case 'convert': return expected >= 85 && review.before.kind !== 'mate'
      case 'defend': return expected >= 15 && expected <= 48 && review.critical
      case 'mate': return review.before.kind === 'mate' && expected === 100
      case 'endings': return review.phase === 'end'
      case 'opening': return review.phase === 'opening' && errors.includes(review.category)
    }
  })
  const themes = [...new Set(exercises.flatMap(task => task.review.motif ? [task.review.motif] : []))].sort()
  const [level, setLevel] = useState('')
  const [chosen, choose] = useState<string>()
  const filtered = exercises.filter(task => (!level || task.level === level) && (!motif || task.review.motif === motif))
  const available = daily ? filtered.filter(task => (history.get(task.id)?.due ?? 0) <= Date.now()).slice(0, 8) : filtered
  const correctRate = practice.reduce((sum, item) => sum + item.correct, 0) / Math.max(1, practice.reduce((sum, item) => sum + item.correct + item.wrong, 0))
  const preferred = practice.length >= 5 && !level ? (correctRate >= .8 ? 'Сложный' : correctRate >= .55 ? 'Средний' : 'Базовый') : undefined
  const task = filtered.find(item => item.id === chosen) ?? available.find(item => item.level === preferred) ?? available[0]
  const solved = practice.reduce((sum, item) => sum + item.correct, 0)
  const wrong = practice.reduce((sum, item) => sum + item.wrong, 0)
  const due = exercises.filter(task => (history.get(task.id)?.due ?? 0) <= Date.now()).length
  return <>
    <div className="kpis">
      <div className="panel"><span>Позиций к повторению</span><strong>{due}</strong></div>
      <div className="panel"><span>Решений</span><strong>{solved}</strong></div>
      <div className="panel"><span>Верные попытки</span><strong>{solved + wrong ? percent(100 * solved / (solved + wrong)) : '—'}</strong></div>
    </div>
    <div className="filters">
      <label>Режим <select value={mode} onChange={event => { setMode(event.target.value as TaskMode); setMotif(''); choose(undefined) }}>
        {Object.entries(modes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {mode === 'opening' && <a href="#openings">Тренировка репертуара</a>}
      <button aria-pressed={daily} onClick={() => { setDaily(!daily); choose(undefined) }}>Подборка на сегодня</button>
      {themes.length > 0 && <label>Мотив <select value={motif} onChange={event => { setMotif(event.target.value); choose(undefined) }}>
        <option value="">Все мотивы</option>{themes.map(item => <option key={item}>{item}</option>)}
      </select></label>}
      <label>Сложность <select value={level} onChange={event => { setLevel(event.target.value); choose(undefined) }}>
        <option value="">Все уровни</option>{['Базовый','Средний','Сложный'].map(item => <option key={item}>{item}</option>)}
      </select></label>
    </div>
    {task ? <TaskView key={mode + task.id} multi={mode === 'mate' || mode === 'tactics'} task={task} onPractice={item => { choose(task.id); onPractice(item) }} next={() => choose(available[(available.findIndex(item => item.id === task.id) + 1) % available.length]?.id)} canNext={available.length > 1} /> :
      <div className="panel"><Empty title={daily ? "На сегодня задач нет" : "Пока нет задач"} message="Задачи формируются из завершённых партий, сыгранных под вашим никнеймом.">
        <button className="primary" onClick={onImport}>Перейти к партиям</button></Empty></div>}
    {themes.length > 0 && <section className="panel history"><h3>Усвоение тем</h3><table><thead><tr><th>Тема</th><th>Верные / все попытки</th><th>Решено без подсказок подряд ≥2</th></tr></thead>
      <tbody>{themes.map(theme => {
        const entries = exercises.filter(task => task.review.motif === theme)
        const records = entries.flatMap(task => history.get(task.id) ?? [])
        const correct = records.reduce((total, item) => total + item.correct, 0)
        return <tr key={theme}><td>{theme}</td><td>{correct}/{correct + records.reduce((total, item) => total + item.wrong, 0)}</td>
          <td>{records.filter(item => item.streak >= 2).length}/{entries.length}</td></tr>
      })}</tbody></table></section>}
    {practice.length > 0 && <section className="panel history"><h3>История тренировок</h3><table><thead><tr><th>Позиция</th><th>Верно</th><th>Ошибок</th><th>Повторить</th></tr></thead>
      <tbody>{[...practice].sort((a, b) => b.last - a.last).map(item => {
        const matched = tasks.find(entry => entry.id === item.id)
        if (!matched) return null
        return <tr key={item.id}><td><button onClick={() => { setMode('best'); setDaily(false); setMotif(''); setLevel(''); choose(item.id) }}>{matched.game.white} – {matched.game.black} · {matched.move.san}</button></td>
          <td>{item.correct}</td><td>{item.wrong}</td><td>{displayDate(new Date(item.due).toISOString().slice(0, 10))}</td></tr>
      })}</tbody></table></section>}
  </>
}

function TaskView({ task, onPractice, next, canNext, multi }: {
  task: { id: string; game: Game; review: NonNullable<Game['reviews']>[number]; move: ReturnType<typeof gameMoves>[number]; moves: ReturnType<typeof gameMoves>; level: string };
  onPractice: (item: Practice) => void; next: () => void; canNext: boolean; multi: boolean
}) {
  const usedHint = useRef(false)
  const [hint, showHint] = useState(false)
  const [step, setStep] = useState(0)
  const [path, setPath] = useState<Move[]>([])
  const [expected, setExpected] = useState<string[]>([])
  const [solution, showSolution] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [solved, setSolved] = useState(false)
  const [pending, setPending] = useState(false)
  const [attemptedWrong, setAttemptedWrong] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  const { move, review, game } = task
  const line = variation(move.before, review.before.pv)
  const fen = path.at(-1)?.after ?? move.before
  const sameStrength = (candidate: Line, best: Line) => {
    if (best.kind === 'mate') return candidate.kind === 'mate' && Math.sign(best.value) === Math.sign(candidate.value)
      && (expectation(best, move.color) === 100 || Math.abs(candidate.value) >= Math.abs(best.value))
    if (candidate.kind === 'mate') return expectation(candidate, move.color) === 100
    const wdl = !!best.wdl && !!candidate.wdl
    const difference = (best.value - candidate.value) * (move.color === 'w' ? 1 : -1)
    return difference <= 30 && expectation(best, move.color, wdl) - expectation(candidate, move.color, wdl) <= 3
  }
  async function record(correct: boolean) {
    const transaction = (await db).transaction('practice', 'readwrite')
    const now = Date.now()
    const previous = await transaction.store.get(task.id) ?? { id: task.id, correct: 0, wrong: 0, streak: 0, due: now, last: now }
    const streak = correct && !attemptedWrong && !usedHint.current ? previous.streak + 1 : 0
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
    const mode = game.mode ?? 'standard'
    const options = mode === 'lite' ? { ...game.options, full: false, hash: 16 as const, threads: 1 as const } : game.options
    const engine = new Engine(current.signal, options, undefined, game.id)
    try {
      const candidate = new Chess(fen).move({ from, to, promotion })
      const notation = uci(candidate)
      const position = { initial: game.initial, moves: [...task.moves.slice(0, review.index).map(uci), ...path.map(uci)], fen }
      const known = !path.length ? review.lines.find(line => line.pv[0] === notation) ?? (review.played.pv[0] === notation ? review.played : undefined) : undefined
      let recommended = path.length ? undefined : review.before
      let evaluated = known
      const expectedLine = path.length ? expected : review.before.pv
      const sameMove = notation === expectedLine[0]
      if (!sameMove && (!evaluated || !recommended || evaluated.depth !== recommended.depth)) {
        const check = async () => {
          recommended = (await engine.evaluate(position, mode, review.critical))[0]
          evaluated = (await engine.evaluate(position, mode, review.critical, notation, recommended.depth))[0]
          if (evaluated.depth < recommended.depth && recommended.pv[0]) {
            recommended = (await engine.evaluate(position, mode, review.critical, recommended.pv[0], evaluated.depth))[0]
          }
        }
        await withAnalysisLock(current, check)
      }
      if (current.signal.aborted) return
      const correct = sameMove || !!evaluated && !!recommended && sameStrength(evaluated, recommended)
      if (!correct) {
        await record(false)
        setFeedback(candidate.san + ' уступает варианту Stockfish. Попробуйте ещё раз.')
        setAttemptedWrong(true)
        return
      }
      const continuation = variation(fen, sameMove ? expectedLine : evaluated!.pv)
      if (multi && path.length < 4 && continuation.length >= 3) {
        setPath([...path, ...continuation.slice(0, 2)])
        setExpected(continuation.slice(2).map(uci))
        setFeedback(candidate.san + ' — верно. Ответ соперника ' + continuation[1].san + '. Найдите продолжение.')
        showHint(false)
        return
      }
      await record(true)
      setSolved(true); showSolution(true); setFeedback(candidate.san + ' — верно.'); setStep(0)

    } catch (error) {
      if (!current.signal.aborted) setFeedback(error instanceof Error ? error.message : 'Не удалось проверить ход.')
    } finally { engine.close(); void engine.flush(); if (!current.signal.aborted) setPending(false) }
  }
  return <div className="review-layout training-layout">
    <Board fen={solution ? line[step - 1]?.after ?? move.before : fen} orientation={move.color} last={solution ? line[step - 1] : path.at(-1)} arrows={hint && !solution ? [path.length ? expected[0] : review.before.pv[0]] : []} onMove={!solution ? tryMove : undefined} />
    <section className="panel task-card"><div className="card-head"><div className="section-icon"><Target size={20} /></div><div><h3>Найдите сильный ход</h3><p>{task.level} · Ход {move.color === 'w' ? 'белых' : 'чёрных'}</p></div></div>
      <p>{game.white} – {game.black} · {displayDate(game.date)}</p>
      <p className="muted">{solution ? review.explanation : 'Сделайте свой ход на доске. Для многоходовой задачи тренажёр покажет ответ соперника.'}</p>
      {feedback && <p role="status" className={solved ? 'notice good' : 'notice'}>{feedback}</p>}
      {pending && <p role="status">Stockfish проверяет ход…</p>}
      {!solution ? <div className="action-row">
        <button disabled={hint || pending} onClick={() => { usedHint.current = true; showHint(true) }}><Lightbulb size={16} /> Подсказка</button>
        <button disabled={pending} onClick={async () => { setPending(true); try { await record(false); showSolution(true); setStep(0) } catch { setFeedback('Не удалось сохранить тренировку.') } finally { setPending(false) } }}><Play size={16} /> Показать решение</button>
      </div> : <><p><strong>Продолжение</strong> {line.map(item => item.san).join(' ')}</p>
        <p className="muted">Ожидаемая потеря в партии: {number(review.loss)} п. п.</p>
        <div className="action-row"><button disabled={!step} onClick={() => setStep(0)}><RotateCcw size={16} /> Начало</button>
          <button disabled={step >= line.length} onClick={() => setStep(step + 1)}>По варианту <ChevronRight size={16} /></button>
          <button className="primary" disabled={!canNext} onClick={next}>Следующая задача</button></div></>}
    </section>
  </div>
}
