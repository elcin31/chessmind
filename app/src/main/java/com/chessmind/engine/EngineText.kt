package com.chessmind.engine

import com.chessmind.chess.Position
import com.chessmind.chess.squareName
import java.util.Locale

fun scoreText(line: Variation?, whiteToMove: Boolean): String {
    val sign = if (whiteToMove) 1 else -1
    line?.mate?.let {
        if (it == 0) return "Мат"
        return "Мат ${if (it * sign > 0) "белых" else "чёрных"} за ${kotlin.math.abs(it)}"
    }
    return line?.cp?.let { String.format(Locale.US, "%+.2f", it * sign / 100.0) } ?: "—"
}

fun sanLine(position: Position, moves: List<String>, length: Int = 7): String {
    var current = position
    val notation = mutableListOf<String>()
    for (uci in moves.take(length)) {
        val move = current.legalMoves().firstOrNull { it.uci == uci } ?: break
        notation += current.san(move)
        current = current.advance(move)
    }
    return notation.joinToString(" ")
}

fun moveDescription(position: Position, uci: String): String {
    val move = position.legalMoves().firstOrNull { it.uci == uci } ?: return uci
    val name = when (position.board[move.from].lowercaseChar()) {
        'p' -> "Пешка"
        'n' -> "Конь"
        'b' -> "Слон"
        'r' -> "Ладья"
        'q' -> "Ферзь"
        else -> "Король"
    }
    return "$name · ${squareName(move.from)} → ${squareName(move.to)}"
}
