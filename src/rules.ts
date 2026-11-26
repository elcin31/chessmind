import { Chess } from 'chess.js'

export const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')

export function drawState(board: Chess, repetitions = 1, legal = board.perft(1)) {
  if (!legal) return board.isCheck() ? undefined : { automatic: true, label: 'Пат' }
  if (board.isInsufficientMaterial()) return { automatic: true, label: 'Недостаточно материала для мата' }
  if (repetitions >= 5) return { automatic: true, label: 'Пятикратное повторение' }
  if (board.isDrawByFiftyMoves() && Number(board.fen().split(' ')[4]) >= 150) {
    return { automatic: true, label: 'Правило 75 ходов' }
  }
  if (repetitions >= 3) return { automatic: false, label: 'Можно потребовать ничью по повторению' }
  if (board.isDrawByFiftyMoves()) return { automatic: false, label: 'Можно потребовать ничью по правилу 50 ходов' }
  return undefined
}
