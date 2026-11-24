package com.chessmind.screen

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.vector.PathParser

enum class BoardTheme(val title: String, val light: Int, val dark: Int) {
    WALNUT("Орех", 0xFFE8DCC5.toInt(), 0xFF9A775D.toInt()),
    TIDE("Морская", 0xFFDAE4D7.toInt(), 0xFF678889.toInt()),
    SLATE("Сланец", 0xFFD4DAE2.toInt(), 0xFF657387.toInt())
}

enum class PieceSet(val title: String) { IVORY("Слоновая кость"), GRAPHIC("Графика") }

object BoardArt {
    const val INSET = 0.18f
    const val UNITS = 8f + 2 * INSET
    private const val MARKER_SIZE = 0.145f
    const val PIECES = ".PNBRQKpnbrqk"

    private data class Shape(val body: Path, val detail: Path)
    private fun shape(body: String, detail: String = "") =
        Shape(PathParser().parsePathString(body).toPath().asAndroidPath(),
            PathParser().parsePathString(detail).toPath().asAndroidPath())

    private val shapes = mapOf(
        'p' to shape(
            "M50 22 A12 12 0 1 1 41 42 C41 54 37 62 32 66 L32 70 L68 70 L68 66 C63 62 59 54 59 42 A12 12 0 0 1 50 22 Z M28 75 L72 75 L76 82 L24 82 Z",
            "M34 70 L66 70"
        ),
        'n' to shape(
            "M31 70 C34 57 57 57 55 44 C50 50 44 50 39 54 L27 48 L39 32 L48 28 L51 18 L59 26 C77 29 78 53 68 70 Z M27 75 L73 75 L77 82 L23 82 Z",
            "M41 37 L45 37 M33 46 L38 46 M62 35 Q73 49 65 61"
        ),
        'b' to shape(
            "M50 19 C53 24 64 32 64 42 C64 50 58 54 55 55 L61 67 L68 70 L32 70 L39 67 L45 55 C41 54 36 50 36 42 C36 32 46 24 50 19 Z M27 75 L73 75 L77 82 L23 82 Z",
            "M54 30 L46 42 M38 49 Q50 53 62 49"
        ),
        'r' to shape(
            "M29 26 L39 26 L39 35 L45 35 L45 26 L55 26 L55 35 L61 35 L61 26 L71 26 L71 43 L64 48 L64 66 L69 70 L31 70 L36 66 L36 48 L29 43 Z M26 75 L74 75 L78 82 L22 82 Z",
            "M35 44 L65 44 M38 64 L62 64"
        ),
        'q' to shape(
            "M24 35 A4 4 0 1 1 28 27 A4 4 0 0 1 31 33 L40 43 L41 25 L50 40 L59 25 L60 43 L69 33 A4 4 0 1 1 76 35 L66 59 L64 69 L36 69 L34 59 Z M29 75 L71 75 L77 82 L23 82 Z M50 17 A4 4 0 1 1 49.99 25 A4 4 0 0 1 50 17 Z",
            "M35 57 Q50 54 65 57 M38 64 L62 64"
        ),
        'k' to shape(
            "M46 17 L54 17 L54 24 L61 24 L61 31 L54 31 L54 38 C62 33 73 37 73 47 C73 53 67 59 65 63 L64 70 L36 70 L35 63 C33 59 27 53 27 47 C27 37 38 33 46 38 L46 31 L39 31 L39 24 L46 24 Z M29 75 L71 75 L77 82 L23 82 Z",
            "M35 56 Q50 51 65 56 M38 64 L62 64 M50 39 L50 50"
        )
    )
    private val drawingPaint = ThreadLocal.withInitial { Paint(Paint.ANTI_ALIAS_FLAG) }
    val marginFraction: Float get() = INSET / UNITS

    fun draw(canvas: Canvas, size: Float, board: String, flipped: Boolean, theme: BoardTheme, set: PieceSet,
             selected: Int?, previous: Pair<Int, Int>?, markers: List<Int>?) {
        val cell = size / UNITS
        val paint = drawingPaint.get()!!
        paint.style = Paint.Style.FILL
        paint.color = 0xFF1F2D40.toInt()
        canvas.drawRect(0f, 0f, size, size, paint)
        if (markers != null) {
            for ((index, color) in markers.withIndex()) {
                val x = (if (index % 2 == 0) INSET / 2 else UNITS - INSET / 2) * cell
                val y = (if (index < 2) INSET / 2 else UNITS - INSET / 2) * cell
                val radius = MARKER_SIZE * cell / 2
                paint.color = color
                canvas.drawRect(x - radius, y - radius, x + radius, y + radius, paint)
            }
        }
        for (display in 0..63) {
            val square = if (flipped) 63 - display else display
            val left = (INSET + display % 8) * cell
            val top = (INSET + display / 8) * cell
            val background = if ((display / 8 + display % 8) % 2 == 0) theme.light else theme.dark
            if (square == selected || square == previous?.first || square == previous?.second) {
                paint.style = Paint.Style.FILL
                paint.color = if (square == selected) 0xFFC69C42.toInt() else 0xFFB89A60.toInt()
                canvas.drawRect(left, top, left + cell, top + cell, paint)
                val border = cell * 0.045f
                drawCell(canvas, left + border, top + border, cell - 2 * border, background, '.',
                    set)
                drawPiece(canvas, left, top, cell, board[square], set)
            } else {
                drawCell(canvas, left, top, cell, background, board[square], set)
            }
        }
    }

    fun drawCell(canvas: Canvas, x: Float, y: Float, cell: Float, background: Int, piece: Char, set: PieceSet) {
        val paint = drawingPaint.get()!!
        paint.style = Paint.Style.FILL
        paint.color = background
        canvas.drawRect(x, y, x + cell, y + cell, paint)
        drawPiece(canvas, x, y, cell, piece, set)
    }

    fun drawPiece(canvas: Canvas, x: Float, y: Float, cell: Float, piece: Char, set: PieceSet) {
        val shape = shapes[piece.lowercaseChar()] ?: return
        val white = piece.isUpperCase()
        val paint = drawingPaint.get()!!
        val saved = canvas.save()
        canvas.translate(x, y)
        canvas.scale(cell / 100, cell / 100)
        if (set == PieceSet.GRAPHIC) canvas.scale(0.93f, 1.05f, 50f, 50f)
        paint.style = Paint.Style.FILL
        paint.color = when (set) {
            PieceSet.IVORY -> if (white) 0xFFFFF8E7.toInt() else 0xFF28364C.toInt()
            PieceSet.GRAPHIC -> if (white) 0xFFF5EEE0.toInt() else 0xFF1F2734.toInt()
        }
        canvas.drawPath(shape.body, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeJoin = Paint.Join.ROUND
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = if (white) 2.8f else 2.2f
        paint.color = if (white) 0xFF3A4350.toInt() else 0xFF172032.toInt()
        canvas.drawPath(shape.body, paint)
        paint.strokeWidth = if (set == PieceSet.GRAPHIC) 3.1f else 2.2f
        paint.color = if (white) 0xFF625138.toInt() else 0xFFE3C892.toInt()
        canvas.drawPath(shape.detail, paint)
        paint.style = Paint.Style.FILL
        paint.color = Color.TRANSPARENT
        canvas.restoreToCount(saved)
    }
}
