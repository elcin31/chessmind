package com.chessmind.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.chessmind.chess.Move
import com.chessmind.chess.squareName
import com.chessmind.screen.BoardArt
import com.chessmind.screen.BoardTheme
import com.chessmind.screen.PieceSet

@Composable
internal fun ChessBoard(
    board: String,
    theme: BoardTheme,
    pieces: PieceSet,
    modifier: Modifier = Modifier,
    flipped: Boolean = false,
    selected: Int? = null,
    previous: Move? = null,
    markers: List<Int>? = null,
    onTap: ((Int) -> Unit)? = null,
) {
    BoxWithConstraints(modifier.aspectRatio(1f)) {
        val inset = maxWidth * BoardArt.marginFraction
        Canvas(Modifier.fillMaxSize()) {
            BoardArt.draw(drawContext.canvas.nativeCanvas, size.width, board, flipped, theme, pieces,
                selected, previous?.let { it.from to it.to }, markers)
        }
        if (onTap != null) {
            Column(Modifier.fillMaxSize().padding(inset)) {
                for (row in 0..7) {
                    Row(Modifier.weight(1f)) {
                        for (column in 0..7) {
                            val display = row * 8 + column
                            val square = if (flipped) 63 - display else display
                            Box(Modifier.weight(1f).fillMaxSize()
                                .semantics { contentDescription = "${squareName(square)}, ${pieceLabel(board[square])}" }
                                .clickable(interactionSource = null, indication = null) { onTap(square) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun PieceTile(piece: Char, set: PieceSet, modifier: Modifier, selected: Boolean = false, onClick: () -> Unit) {
    Box(modifier.clip(RoundedCornerShape(6)).background(if (selected) Gold else Panel)
        .semantics { contentDescription = pieceLabel(piece) }.clickable(onClick = onClick)) {
        Canvas(Modifier.fillMaxSize()) {
            if (piece == '.') {
                drawLine(if (selected) Ink else Cream, center.copy(x = center.x * .65f),
                    center.copy(x = center.x * 1.35f), strokeWidth = size.width * .05f)
            } else {
                BoardArt.drawPiece(drawContext.canvas.nativeCanvas, 0f, 0f, size.width, piece, set)
            }
        }
    }
}

internal fun pieceLabel(piece: Char): String {
    if (piece == '.') return "Пусто"
    val name = when (piece.lowercaseChar()) {
        'p' -> "Пешка"
        'n' -> "Конь"
        'b' -> "Слон"
        'r' -> "Ладья"
        'q' -> "Ферзь"
        else -> "Король"
    }
    return "$name · ${if (piece.isUpperCase()) "белые" else "чёрные"}"
}
