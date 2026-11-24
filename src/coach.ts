import { Chess, SQUARES, type Color, type Move, type Square } from 'chess.js'
import { evalLabel, material, pieceValue, sacrifice, variation, type Line, type Phase } from './review'

const pieces = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' }
const enemy = (color: Color): Color => color === 'w' ? 'b' : 'w'
const result = (motif: string, explanation: string) => ({ motif, explanation })

function tactical(step: Move, reply: Move[]) {
  const before = new Chess(step.before)
  const after = new Chess(step.after)
  const opponent = enemy(step.color)
  const targets = after.board().flat().filter(piece => piece && piece.color === opponent &&
    (piece.type === 'k' || pieceValue[piece.type] > pieceValue[step.piece] || !after.attackers(piece.square, opponent).length) &&
    after.attackers(piece.square, step.color).includes(step.to))
  const futureCapture = reply.find(move => move.color === step.color && move.from === step.to && move.captured && targets.some(target => target?.square === move.to))
  if (targets.length >= 2 && futureCapture) {
    const text = targets.slice(0, 2).map(piece => pieces[piece!.type] + ' на ' + piece!.square).join(' и ')
    return result(step.piece === 'n' || step.piece === 'p' ? 'Вилка' : 'Двойной удар', step.san + ' одновременно атакует две цели: ' + text + '. В варианте движка следует ' + futureCapture.san + '.')
  }
  const uncovered = reply.find(move => move.color === step.color && move.captured && move.from !== step.to &&
    !!after.get(move.to) && after.attackers(move.to, step.color).includes(move.from) && !before.attackers(move.to, step.color).includes(move.from))
  if (uncovered) return result('Вскрытая атака', step.san + ' открывает линию атаки. В варианте движка это позволяет сыграть ' + uncovered.san + '.')
  const king = after.board().flat().find(piece => piece?.type === 'k' && piece.color === opponent)
  if (king && !after.isCheck()) {
    const [file, rank] = [king.square.charCodeAt(0) - 97, Number(king.square[1]) - 1]
    for (const [x, y] of [[0, 1], [1, 0], [1, 1], [1, -1], [0, -1], [-1, 0], [-1, -1], [-1, 1]]) {
      let pinned: Square | undefined
      for (let offset = 1; offset < 8; offset++) {
        const nextFile = file + offset * x, nextRank = rank + offset * y
        if (nextFile < 0 || nextFile > 7 || nextRank < 0 || nextRank > 7) break
        const square = (String.fromCharCode(97 + nextFile) + (nextRank + 1)) as Square
        const piece = after.get(square)
        if (!piece) continue
        if (!pinned && piece.color === opponent) { pinned = square; continue }
        if (pinned && square === step.to && piece.color === step.color &&
          (piece.type === 'q' || piece.type === (x && y ? 'b' : 'r')) &&
          reply.some(move => move.color === step.color && move.to === pinned && move.captured)) {
          return result('Связка', step.san + ' связывает фигуру на ' + pinned + ' с королём. Вариант движка использует эту связку для взятия.')
        }
        break
      }
    }
  }
}

function pawnStructure(chess: Chess, color: Color) {
  const pawns = chess.board().flat().filter(piece => piece?.type === 'p' && piece.color === color)
  const columns = Array.from({ length: 8 }, (_, file) => pawns.filter(piece => piece!.square.charCodeAt(0) - 97 === file).length)
  const isolated = columns.reduce((sum, count, file) => sum + (count && !columns[file - 1] && !columns[file + 1] ? count : 0), 0)
  return { doubled: columns.reduce((sum, count) => sum + Math.max(0, count - 1), 0), isolated }
}
function passed(chess: Chess, color: Color, square: Square) {
  return !chess.board().flat().some(piece => piece?.type === 'p' && piece.color !== color &&
    Math.abs(piece.square.charCodeAt(0) - square.charCodeAt(0)) <= 1 &&
    (color === 'w' ? piece.square[1] > square[1] : piece.square[1] < square[1]))
}
function kingZone(chess: Chess, color: Color) {
  const king = chess.board().flat().find(piece => piece?.type === 'k' && piece.color === color)
  return king ? SQUARES.filter(square => Math.abs(square.charCodeAt(0) - king.square.charCodeAt(0)) <= 1 &&
    Math.abs(Number(square[1]) - Number(king.square[1])) <= 1 && chess.attackers(square, enemy(color)).length).length : 0
}
const center = ['d4', 'd5', 'e4', 'e5'] as Square[]

export function explain(
  move: Move, best: Line, played: Line, after: Line,
  facts: { forced: boolean; unique: boolean; lostMate: boolean; allowsMate: boolean; category: string; loss: number },
  phase: Phase,
): { explanation: string; motif?: string } {
  const afterBoard = new Chess(move.after)
  const beforeBoard = new Chess(move.before)
  const reply = variation(move.after, after.pv, 8)
  const alternative = variation(move.before, best.pv, 6)
  const preferred = alternative[0]?.san
  const variationSan = alternative.slice(0, 5).map(step => step.san).join(' ')
  const mover = move.color
  if (afterBoard.isCheckmate()) return result('Мат', move.san + ' ставит мат: у соперника нет легального ответа.')
  if (facts.forced) return { explanation: 'В этой позиции был только один легальный ход.' }
  if (facts.lostMate && facts.loss > 0) return result('Упущенный мат', 'Движок находит мат в ' + Math.abs(best.value) + ' после ' + variationSan + '. Сыгранный ход не сохраняет найденный форсированный мат.')
  if (facts.allowsMate) return result('Матовая угроза', 'Сыгранный ход допускает форсированный мат по оценке Stockfish. Ответ: ' + (reply[0]?.san ?? 'см. вариант') + '.')
  if (facts.category === 'brilliant' && sacrifice(move, after)) return result('Тактическая жертва', 'В линии ' + reply.slice(0, 5).map(step => step.san).join(' ') + ' соперник выигрывает материал, но углублённый анализ подтверждает достаточную компенсацию.')
  if (facts.unique && facts.category === 'great') return result('Единственный сильный ход', 'Stockfish подтверждает ' + move.san + '. Следующий по силе вариант заметно хуже для стороны, сделавшей ход.')
  const swing = reply.length > 0 ? material(new Chess(reply.at(-1)!.after), mover) - material(beforeBoard, mover) : 0
  if (facts.loss >= 6 && reply[0]?.captured && swing <= -1) {
    const taken = afterBoard.get(reply[0].to)
    if (taken && !afterBoard.attackers(reply[0].to, mover).length) {
      return result('Незащищённая фигура', 'После ' + move.san + ' без защиты остаётся ' + pieces[taken.type] + ' на ' + reply[0].to + '. Stockfish указывает взятие ' + reply[0].san + '.')
    }
  }
  if (facts.loss >= 5 && reply.length) {
    const tactic = tactical(reply[0], reply.slice(1))
    if (tactic) return tactic
    const finalCapture = reply[2]
    if (reply[0].captured && finalCapture?.captured && swing <= -2 &&
      afterBoard.attackers(reply[0].to, mover).length === 1 &&
      afterBoard.attackers(finalCapture.to, mover).length === 1 &&
      afterBoard.attackers(reply[0].to, mover)[0] === reply[1]?.from &&
      afterBoard.attackers(finalCapture.to, mover)[0] === reply[1]?.from) {
      return result('Перегрузка', 'Фигура на ' + reply[1].from + ' защищала две цели. После ' + reply.slice(0, 3).map(step => step.san).join(' ') + ' соперник выигрывает материал.')
    }
    if (swing <= -2) return result('Потеря материала', 'В варианте ' + reply.map(step => step.san).join(' ') + ' потеря материала составляет ' + Math.abs(swing) + ' пешечных единиц.')
    const oldPawns = pawnStructure(beforeBoard, mover), newPawns = pawnStructure(afterBoard, mover)
    if (newPawns.doubled > oldPawns.doubled || newPawns.isolated > oldPawns.isolated) {
      return result('Пешечная структура', move.san + ' увеличивает число ' + (newPawns.doubled > oldPawns.doubled ? 'сдвоенных' : 'изолированных') + ' пешек. Stockfish предпочитает ' + preferred + '.')
    }
    if (kingZone(afterBoard, mover) >= kingZone(beforeBoard, mover) + 2 && reply.some(step => step.color !== mover && /[+#]$/.test(step.san))) {
      return result('Безопасность короля', 'После ' + move.san + ' соперник контролирует больше полей рядом с королём. В ответном варианте появляется шах.')
    }
    const development = alternative[0]
    if (phase === 'opening' && development && /[nb]/.test(development.piece) && /[18]$/.test(development.from) &&
      !/[18]$/.test(development.to) && (move.piece === 'q' || (/[nb]/.test(move.piece) && !/[18]$/.test(move.from)))) {
      return result('Развитие', 'Stockfish предпочитает развить фигуру с начальной горизонтали ходом ' + preferred + '.')
    }
  }
  if (facts.loss <= 3) {
    const tactic = tactical(move, reply)
    if (tactic) return tactic
    if (move.piece === 'p' && !passed(beforeBoard, mover, move.from) && afterBoard.get(move.to)?.type === 'p' && passed(afterBoard, mover, move.to)) {
      return result('Проходная пешка', 'После ' + move.san + ' у соперника нет пешек, которые могли бы перекрыть продвижение пешки ' + move.to + ' со своего или соседних вертикалей.')
    }
    if (/[+]$/.test(move.san)) return result('Шах', move.san + ' вынуждает соперника защититься от шаха.' + (reply.length ? ' Вариант Stockfish: ' + reply.slice(0, 4).map(step => step.san).join(' ') + '.' : ''))
    const control = (chess: Chess) => center.filter(square => chess.attackers(square, mover).length).length
    if (phase === 'opening' && control(afterBoard) >= control(beforeBoard) + 2) return result('Контроль центра', move.san + ' увеличивает число центральных полей под контролем этой стороны.')
  }
  return { explanation: 'Оценка за белых: ' + evalLabel(best) + ' → ' + evalLabel(after) + '. ' +
    (variationSan ? 'Лучшее продолжение Stockfish: ' + variationSan + '.' : 'В этой позиции Stockfish не предлагает продолжения.') +
    (played.kind === 'mate' ? ' Оценка сыгранного хода: ' + evalLabel(played) + '.' : '') }
}
