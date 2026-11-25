import { Chess, type Move } from 'chess.js'
import type { Game } from './library'
import { categories, evalLabel, variation, type Review } from './review'

const seconds = (value: string) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0)

export function readClocks(pgn: string, moves: Move[], control: string) {
  const board = new Chess()
  board.loadPgn(pgn)
  const comments = new Map(board.getComments().map(item => [item.fen, item.comment]))
  const match = control.match(/^(\d+)(?:\+(\d+))?$/)
  const previous: Partial<Record<'w' | 'b', number>> = {}
  if (match && moves[0]?.before === new Chess().fen()) previous.w = previous.b = Number(match[1])
  return moves.map(move => {
    const comment = comments.get(move.after) ?? ''
    const clock = comment.match(/\[%clk ([\d:]+(?:\.\d+)?)\]/)?.[1]
    const elapsed = comment.match(/\[%emt ([\d:]+(?:\.\d+)?)\]/)?.[1]
    const remaining = clock === undefined ? undefined : seconds(clock)
    const prior = previous[move.color]
    previous[move.color] = remaining
    const spent = elapsed !== undefined ? seconds(elapsed) : match && remaining !== undefined && prior !== undefined
      ? prior + Number(match[2] ?? 0) - remaining : undefined
    return { remaining, spent: spent !== undefined && spent >= 0 ? spent : undefined }
  })
}

export function annotatedPgn(game: Game, reviews: ReadonlyArray<Review | undefined> | undefined = game.reviews) {
  const board = new Chess()
  board.loadPgn(game.pgn)
  const moves = board.history({ verbose: true })
  const comments = new Map(board.getComments().map(item => [item.fen, item.comment]))
  const headers = Object.entries(board.getHeaders()).map(([key, value]) =>
    '[' + key + ' "' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]/g, ' ') + '"]')
  const text = moves.map((move, index) => {
    const review = reviews?.[index]
    const assessment = review ? [
      'ChessMind ' + (game.methodology ?? 1) + '.0 · ' + categories[review.category][0],
      'Оценка белых ' + evalLabel(review.after),
      review.explanation,
      review.before.pv.length ? 'Лучший вариант ' + variation(move.before, review.before.pv).map(item => item.san).join(' ') : '',
    ].filter(Boolean).join('. ') : ''
    const comment = [comments.get(move.after), assessment].filter(Boolean).join(' ').replace(/[{}]/g, '')
    return move.before.split(' ')[5] + (move.color === 'w' ? '. ' : '... ') + move.san + (comment ? ' {' + comment + '}' : '')
  })
  return headers.join('\n') + '\n\n' + [...text, game.result].join(' ') + '\n'
}
