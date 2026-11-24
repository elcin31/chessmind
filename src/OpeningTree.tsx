import { Chess, DEFAULT_POSITION, type Color, type Square } from 'chess.js'
import { useEffect, useMemo, useState } from 'react'
import { Board } from './Board'
import { fenKey, gameMoves, type Game, type Opening } from './library'

type Tree = { graph: Record<string, Record<string, string>>; variants: Opening[] }
type Repertoire = Record<string, string>
const storageKey = 'chessmind-repertoire'
function readRepertoire(): Repertoire {
  try { return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {} }
  catch { return {} }
}

export function OpeningTree({ games }: { games: Game[] }) {
  const [tree, setTree] = useState<Tree>()
  const [query, setQuery] = useState('')
  const [start, setStart] = useState(DEFAULT_POSITION)
  const [path, setPath] = useState<string[]>([])
  const [side, setSide] = useState<Color>('w')
  const [due, setDue] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('chessmind-repertoire-due') ?? '{}') ?? {} }
    catch { return {} }
  })
  const [saved, setSaved] = useState(readRepertoire)
  const [test, setTest] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failure, setFailure] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/opening-tree.json', { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('База ECO недоступна.')
      return response.json()
    }).then(setTree).catch(() => { if (!controller.signal.aborted) setFailure('База ECO недоступна.') })
    return () => controller.abort()
  }, [])
  const board = useMemo(() => {
    const position = new Chess(start)
    for (const san of path) position.move(san)
    return position
  }, [path, start])
  const key = fenKey(board.fen())
  const pin = side + ':' + key
  const options = Object.keys(tree?.graph[key] ?? {})
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const game of games) {
      const move = gameMoves(game).slice(0, 45).find(item => fenKey(item.before) === key)
      if (move) result.set(move.san, (result.get(move.san) ?? 0) + 1)
    }
    return result
  }, [games, key])
  const variants = query.trim() ? (tree?.variants ?? []).filter(item => item.slice(0, 2).join(' ').toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12) : []
  function follow(move: string) {
    if (!board.moves().includes(move)) {
      setFeedback('Этот ход не легален в выбранной позиции.')
      return
    }
    setPath([...path, move])
    setFeedback('')
  }
  const savedPositions = Object.entries(saved).filter(([key]) => key.startsWith(side + ':'))
    .sort(([a], [b]) => (due[a] ?? 0) - (due[b] ?? 0))
  const updateDue = (key: string, time: number) => {
    const next = { ...due, [key]: time }
    try { localStorage.setItem('chessmind-repertoire-due', JSON.stringify(next)); setDue(next) }
    catch { /* The exercise remains usable without persistence. */ }
  }
  function save(move: string) {
    const next = { ...saved }
    if (next[pin] === move) delete next[pin]
    else next[pin] = move
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next); updateDue(pin, 0) }
    catch { setFeedback('Не удалось сохранить репертуар в браузере.') }
  }
  function play(from: Square, to: Square, promotion?: string) {
    const move = new Chess(board.fen()).move({ from, to, promotion })
    if (!test) { setPath([...path, move.san]); return }
    if (move.san === saved[pin]) {
      updateDue(pin, Date.now() + 86_400_000)
      setFeedback('Верно · ' + move.san)
      setTest(false)
      setPath([...path, move.san])
    } else {
      updateDue(pin, 0)
      setFeedback('Сыгран другой ход. Попробуйте вспомнить сохранённый вариант.')
    }
  }
  return <div className="review-layout opening-lab">
    <Board fen={board.fen()} orientation={side} last={board.history({ verbose: true }).at(-1)} onMove={play} />
    <section className="panel">
      <h2>Дерево ECO</h2>
      {failure && <p role="alert">{failure}</p>}
      <label className="field">Название или код ECO<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      {!!variants.length && <div className="action-row">{variants.map(([eco, name, pgn]) =>
        <button key={eco + name + pgn} onClick={() => {
          const line = new Chess()
          line.loadPgn(pgn)
          setStart(DEFAULT_POSITION); setPath(line.history()); setTest(false); setQuery(''); setFeedback('')
        }}>{eco} {name}</button>)}</div>}
      <div className="action-row">
        <button disabled={!path.length} onClick={() => { setPath(path.slice(0, -1)); setTest(false); setFeedback('') }}>Назад</button>
        <button disabled={!path.length && start === DEFAULT_POSITION} onClick={() => { setStart(DEFAULT_POSITION); setPath([]); setTest(false); setFeedback('') }}>Начальная позиция</button>
        <select aria-label="Цвет репертуара" value={side} onChange={event => { setSide(event.target.value as Color); setTest(false) }}>
          <option value="w">За белых</option><option value="b">За чёрных</option>
        </select>
      </div>
      <p className="muted">{path.join(' ') || 'Начальная позиция'} · {counts.size ? 'Числа показывают партии из вашей библиотеки.' : 'В библиотеке нет продолжений этой позиции.'}</p>
      {test ? <p>Воспроизведите сохранённый ход на доске.</p> : <div className="opening-options">
        {[...new Set([...options, ...counts.keys(), ...(saved[pin] ? [saved[pin]] : [])])].map(move => <div key={move}>
          <button onClick={() => { follow(move) }}>{move}{counts.get(move) ? ' · ' + counts.get(move) : ''}</button>
          {board.turn() === side && <button aria-pressed={saved[pin] === move} onClick={() => save(move)}>{saved[pin] === move ? 'В репертуаре' : 'В репертуар'}</button>}
        </div>)}
      </div>}
      {!!savedPositions.length && <details><summary>Репертуар · к повторению {savedPositions.filter(([key]) => (due[key] ?? 0) <= Date.now()).length}/{savedPositions.length}</summary>
        <div className="action-row">{savedPositions.map(([key], index) => <button key={key} onClick={() => {
          const fen = key.slice(2) + ' 0 1'
          try { new Chess(fen) } catch { return }
          setStart(fen); setPath([]); setTest(true); setFeedback('')
        }}>Позиция {index + 1} · {(due[key] ?? 0) <= Date.now() ? 'повторить' : 'пройдена'}</button>)}</div>
      </details>}
      {!!saved[pin] && !test && <button onClick={() => { setTest(true); setFeedback('') }}>Повторить эту позицию</button>}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  </div>
}
