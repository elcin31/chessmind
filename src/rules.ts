import { Chess } from 'chess.js'

export const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')

export function drawState(board: Chess, repetitions = 1) {
  if (board.isCheckmate()) return undefined
  const halfmoves = Number(board.fen().split(' ')[4])
  if (board.isStalemate()) return { automatic: true, label: 'Пат' }
  if (board.isInsufficientMaterial()) return { automatic: true, label: 'Недостаточно материала для мата' }
  if (repetitions >= 5) return { automatic: true, label: 'Пятикратное повторение' }
  if (halfmoves >= 150) return { automatic: true, label: 'Правило 75 ходов' }
  if (repetitions >= 3) return { automatic: false, label: 'Можно потребовать ничью по повторению' }
  if (halfmoves >= 100) return { automatic: false, label: 'Можно потребовать ничью по правилу 50 ходов' }
  return undefined
}
