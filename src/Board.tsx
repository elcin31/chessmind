import { Chess, type Color, type Move, type Square } from 'chess.js'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

type Props = {
  fen: string; orientation?: Color; last?: Move; accent?: string; arrows?: string[];
  onSwipe?: (direction: -1 | 1) => void
  onMove?: (from: Square, to: Square, promotion?: string) => void
}

export function Board({ fen, orientation = 'w', last, accent, arrows = [], onSwipe, onMove }: Props) {
  const chess = useMemo(() => new Chess(fen), [fen])
  const [selection, select] = useState<{ fen: string; square: Square }>()
  const [promotion, promote] = useState<{ fen: string; from: Square; to: Square }>()
  const drag = useRef<{ square: Square; x: number; y: number; image: string } | undefined>(undefined)
  const ignoreClick = useRef(false)
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; image: string; square: Square }>()
  const board = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number }>(undefined)
  useEffect(() => {
    if (!last || !board.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const image = board.current.querySelector<HTMLImageElement>('[data-square="' + last.to + '"] img')
    if (!image) return
    const sign = orientation === 'w' ? 1 : -1
    const dx = (last.from.charCodeAt(0) - last.to.charCodeAt(0)) * sign
    const dy = (Number(last.to[1]) - Number(last.from[1])) * sign
    const size = board.current.clientWidth / 8
    image.closest('.square')?.animate([{ zIndex: 2 }, { zIndex: 2 }], { duration: 150 })
    const motion = image.animate([{ transform: 'translate(' + dx * size + 'px,' + dy * size + 'px)' }, { transform: 'translate(0,0)' }],
      { duration: 145, easing: 'ease-out' })
    return () => motion.cancel()
  }, [last, orientation])
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const selected = selection?.fen === fen ? selection.square : undefined
  const choices = promotion?.fen === fen ? promotion : undefined
  const squares = chess.board().flatMap((row, rank) => row.map((piece, file) => ({
    piece, rank, file, square: (String.fromCharCode(97 + file) + (8 - rank)) as Square,
  })))
  if (orientation === 'b') squares.reverse()
  const targets = selected && onMove ? chess.moves({ square: selected, verbose: true }) : []
  function attempt(from: Square, to: Square) {
    const moves = chess.moves({ square: from, verbose: true }).filter(move => move.to === to)
    if (!moves.length) return false
    if (moves[0].promotion) promote({ fen, from, to })
    else onMove?.(from, to)
    select(undefined)
    return true
  }
  function tap(square: Square) {
    if (ignoreClick.current) { ignoreClick.current = false; return }
    if (!onMove) return
    if (selected && selected !== square && attempt(selected, square)) return
    const piece = chess.get(square)
    select(piece?.color === chess.turn() && selected !== square ? { fen, square } : undefined)
  }
  const point = (square: string) => {
    const x = square.charCodeAt(0) - 97, y = 8 - Number(square[1])
    return orientation === 'w' ? [x + 0.5, y + 0.5] : [7.5 - x, 7.5 - y]
  }
  return <div ref={board} className="board" aria-label="Шахматная доска"
    onTouchStart={event => { swipe.current = { x: event.touches[0].clientX, y: event.touches[0].clientY } }}
    onTouchEnd={event => {
      const start = swipe.current
      swipe.current = undefined
      if (!start || dragPreview) return
      const dx = event.changedTouches[0].clientX - start.x
      const dy = event.changedTouches[0].clientY - start.y
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.8) onSwipe?.(dx < 0 ? 1 : -1)
    }}
    onPointerCancel={() => { drag.current = undefined; setDragPreview(undefined) }}
    onPointerMove={event => {
      const start = drag.current
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) return
      const box = event.currentTarget.getBoundingClientRect()
      setDragPreview({ x: event.clientX - box.left, y: event.clientY - box.top, image: start.image, square: start.square })
    }}
    onPointerUp={event => {
      if (!onMove || !drag.current) return
      const start = drag.current
      drag.current = undefined
      setDragPreview(undefined)
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) return
      ignoreClick.current = true
      setTimeout(() => { ignoreClick.current = false }, 0)
      const end = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-square]')
      if (end?.dataset.square && event.currentTarget.contains(end)) attempt(start.square, end.dataset.square as Square)
    }}>
    {squares.map(({ piece, rank, file, square }, index) => <button key={square} type="button" data-square={square}
      tabIndex={onMove ? 0 : -1} aria-label={square + (piece ? ' ' + ({ k:'король', q:'ферзь', r:'ладья', b:'слон', n:'конь', p:'пешка' })[piece.type] + (piece.color === 'w' ? ' белые' : ' чёрные') : '')}
      className={'square ' + (onMove && piece?.color === chess.turn() ? 'draggable ' : '') + ((rank + file) % 2 ? 'dark-square' : 'light-square') + (selected === square ? ' selected' : '')}
      style={last && (last.from === square || last.to === square) ? { boxShadow: 'inset 0 0 0 60px ' + (accent ?? '#dec677') + '88' } : undefined}
      onClick={() => tap(square)}
      onPointerDown={event => {
        if (onMove && piece?.color === chess.turn()) {
          drag.current = { square, x: event.clientX, y: event.clientY, image: '/pieces/' + piece.color + piece.type.toUpperCase() + '.svg' }
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }}>
      {index % 8 === 0 && <span className="rank">{square[1]}</span>}
      {index >= 56 && <span className="file">{square[0]}</span>}
      {piece && dragPreview?.square !== square && <img alt="" draggable={false} src={'/pieces/' + piece.color + piece.type.toUpperCase() + '.svg'} />}
      {targets.some(move => move.to === square) && <span className={piece ? 'capture-target' : 'move-target'} />}
    </button>)}
    {dragPreview && <img className="drag-piece" alt="" src={dragPreview.image} style={{ left: dragPreview.x, top: dragPreview.y }} />}
    {arrows.length > 0 && <svg className="board-arrows" viewBox="0 0 8 8" aria-hidden="true">
      <defs><marker id={id} markerWidth="3" markerHeight="3" refX="2.05" refY="1.5" orient="auto"><path d="M0 0L2.6 1.5 0 3z" fill="#e4ad50" /></marker></defs>
      {arrows.map(move => {
        const [x1, y1] = point(move.slice(0, 2)), [x2, y2] = point(move.slice(2, 4))
        const length = Math.hypot(x2 - x1, y2 - y1)
        return <line key={move} x1={x1} y1={y1} x2={x2 - (x2 - x1) / length * 0.23} y2={y2 - (y2 - y1) / length * 0.23} stroke="#e4ad50" strokeWidth="0.16" markerEnd={'url(#' + id + ')'} />
      })}
    </svg>}
    {choices && <div className="promotion" role="dialog" aria-label="Выбор фигуры для превращения">
      {['q', 'r', 'b', 'n'].map(piece => <button key={piece} aria-label={{ q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' }[piece]} onClick={() => {
        promote(undefined)
        onMove?.(choices.from, choices.to, piece)
      }}><img alt="" src={'/pieces/' + chess.turn() + piece.toUpperCase() + '.svg'} /></button>)}
      <button onClick={() => promote(undefined)}>Отмена</button>
    </div>}
  </div>
}
