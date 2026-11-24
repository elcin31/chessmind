import { Chess } from 'chess.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Board } from './Board'
import { gameMoves, isComplete, type Game } from './library'
import { evalLabel, variation } from './review'

function family(board: Chess) {
  const pieces = board.board().flat().filter(piece => piece && piece.type !== 'k')
  return pieces.some(piece => piece?.type === 'q') ? 'Ферзевые' : pieces.some(piece => piece?.type === 'r') ?
    'Ладейные' : pieces.some(piece => piece?.type === 'b' || piece?.type === 'n') ? 'Легкофигурные' : 'Пешечные'
}

const concepts = [
  ['Оппозиция', 'Короли на одной линии через клетку. Ходящий первым должен уступить прямую оппозицию, если у него нет выжидательного хода.'],
  ['Правило квадрата', 'Мысленно постройте квадрат от пешки до поля превращения. Если король успевает войти в квадрат, он может догнать пешку при свободном маршруте. Учтите очередь хода и двойной шаг пешки.'],
  ['Активность короля и проходная', 'Сравните прямой маршрут короля к пешке с обходом. Проверьте, может ли соперник остановить проходную без помощи другой фигуры.'],
  ['Базовый мат', 'Ограничивайте пространство короля ладьёй или ферзём и подведите своего короля. Перед каждым тихим ходом проверьте, останется ли у соперника легальный ход.'],
  ['Крепость и пат', 'Материальный перевес сам по себе не доказывает выигрыш. Для пата нужно отсутствие легальных ходов без шаха. Для конкретной крепости ищите линию защиты или табличное подтверждение ничьей.'],
]

type Tablebase = { category: string; dtz: number | null; moves: { san: string; category: string }[] }
const resultLabels: Record<string, string> = { win: 'Выигрыш', loss: 'Поражение', draw: 'Ничья', 'cursed-win': 'Ничья по правилу 50 ходов при точной игре соперника', 'blessed-loss': 'Ничья по правилу 50 ходов при точной защите' }

export function Endgames({ games, open }: { games: Game[]; open: (game: Game, ply: number) => void }) {
  const [type, setType] = useState('Пешечные')
  const [choice, setChoice] = useState('')
  const [step, setStep] = useState(0)
  const [tablebase, setTablebase] = useState<Tablebase & { id: string }>()
  const [message, setMessage] = useState('')
  const positions = useMemo(() => games.filter(isComplete).flatMap(game => {
    const reviews = game.reviews!.filter(item => item.phase === 'end' && item.before.pv.length)
    if (!reviews.length) return []
    const moves = gameMoves(game)
    const firstByFamily = new Map<string, { id: string; game: Game; review: typeof reviews[number]; move: typeof moves[number]; count: number; type: string }>()
    for (const review of reviews) {
      const move = moves[review.index]
      const board = new Chess(move.before)
      const type = family(board)
      const prior = firstByFamily.get(type)
      if (!prior || review.loss > prior.review.loss) firstByFamily.set(type, {
        id: game.id + ':' + review.index, game, review, move, count: board.board().flat().filter(Boolean).length, type,
      })
    }
    return [...firstByFamily.values()]
  }), [games])
  const matches = positions.filter(item => item.type === type)
  const current = matches.find(item => item.id === choice) ?? matches[0]
  const line = current ? variation(current.move.before, current.review.before.pv) : []
  const lookupRequest = useRef<AbortController>(undefined)
  useEffect(() => {
    setTablebase(undefined); setMessage(''); setStep(0)
    return () => lookupRequest.current?.abort()
  }, [current?.id])
  async function lookup() {
    if (!current) return
    setMessage('Запрашиваем таблицы Lichess…')
    const id = current.id
    const request = new AbortController()
    lookupRequest.current = request
    try {
      const url = new URL('https://tablebase.lichess.ovh/standard')
      url.searchParams.set('fen', current.move.before)
      const response = await fetch(url, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const entry: Tablebase = await response.json()
      if (!resultLabels[entry.category]) throw new Error('Позиция недоступна')
      if (request.signal.aborted) return
      setTablebase({ ...entry, id })
      setMessage('')
    } catch { if (!request.signal.aborted) setMessage('Таблицы недоступны. Ниже доступна локальная оценка Stockfish.') }
  }
  const visibleTable = tablebase?.id === current?.id ? tablebase : undefined
  return <>
    <div className="filters"><label>Тип эндшпиля <select value={type} onChange={event => setType(event.target.value)}>
      {['Пешечные', 'Ладейные', 'Ферзевые', 'Легкофигурные'].map(item => <option key={item}>{item}</option>)}
    </select></label><a href="#training">Тренировать свои эндшпили</a></div>
    {current ? <div className="review-layout">
      <Board fen={line[step - 1]?.after ?? current.move.before} orientation={current.move.color} last={line[step - 1]} />
      <section className="panel"><h2>Позиции из библиотеки · {matches.length}</h2>
        <label className="field">Партия<select value={current.id} onChange={event => setChoice(event.target.value)}>
          {matches.map(item => <option key={item.id} value={item.id}>{item.game.white} — {item.game.black} · ход {item.move.before.split(' ')[5]}</option>)}
        </select></label>
        <p>Локальная оценка Stockfish за белых {evalLabel(current.review.before)} · глубина {current.review.depth}.</p>
        <p>{current.review.explanation}</p>
        <div className="action-row"><button disabled={!step} onClick={() => setStep(step - 1)}>Назад</button>
          <button disabled={step >= line.length} onClick={() => setStep(step + 1)}>{line[step] ? 'Дальше · ' + line[step].san : 'Конец варианта'}</button>
          <button onClick={() => open(current.game, current.review.index + 1)}>Разбор партии</button></div>
        {current.count <= 7 && <div className="action-row"><button onClick={() => void lookup()} disabled={message.startsWith('Запрашиваем')}>Запросить таблицу Lichess</button></div>}
        {message && <p role="status">{message}</p>}
        {visibleTable && <p className="notice">Табличный результат для стороны хода · {resultLabels[visibleTable.category]}.
          {visibleTable.moves[0] && ' Ход из таблицы: ' + visibleTable.moves[0].san + '.'}</p>}
      </section>
    </div> : <section className="panel"><p>В проанализированных партиях пока нет этого типа эндшпиля.</p></section>}
    <section className="panel history"><h3>Темы эндшпиля</h3>{concepts.map(([title, detail]) =>
      <details key={title}><summary>{title}</summary><p>{detail}</p></details>)}</section>
  </>
}
