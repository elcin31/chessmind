package com.chessmind.screen

import android.graphics.Bitmap
import android.graphics.Canvas
import com.chessmind.chess.Game
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

internal interface RgbFrame {
    val width: Int
    val height: Int
    fun pixel(x: Int, y: Int): Int
}

internal data class Calibration(val x: Float = 0f, val y: Float = 0f, val zoom: Float = 0f)
internal data class BoardArea(val x: Float, val y: Float, val size: Float) {
    fun adjusted(calibration: Calibration): BoardArea {
        val cell = size / 8
        val change = calibration.zoom * cell
        return BoardArea(x + calibration.x * cell - change / 2, y + calibration.y * cell - change / 2, size + change)
    }

    fun fits(frame: RgbFrame) = x >= 0 && y >= 0 && size >= 128f &&
        x + size <= frame.width && y + size <= frame.height
}

private data class Point(val x: Float, val y: Float)
internal data class ObservedBoard(val display: String, val confidence: Float)

internal class Recognizer {
    private var anchors: List<Point>? = null
    private var anchorKey: List<Int>? = null
    private val templates = mutableMapOf<Pair<Boolean, Boolean>, List<IntArray>>()
    private var scheme: Pair<BoardTheme, PieceSet>? = null

    fun read(frame: RgbFrame, markers: List<Int>, theme: BoardTheme, set: PieceSet,
             calibration: Calibration, reduced: Boolean): ObservedBoard? {
        if (anchorKey != markers) {
            anchors = null
            anchorKey = markers
        }
        val points = anchors?.takeIf { validMarkers(frame, it, markers) }
            ?: locate(frame, markers)?.also { anchors = it }
            ?: return null
        val left = (points[0].x + points[2].x) / 2
        val top = (points[0].y + points[1].y) / 2
        val spanX = (points[1].x + points[3].x) / 2 - left
        val spanY = (points[2].y + points[3].y) / 2 - top
        if (spanX < 135 || abs(spanX - spanY) > max(3f, spanX * .016f) ||
            abs(points[0].y - points[1].y) > 4 || abs(points[0].x - points[2].x) > 4 ||
            abs(points[3].y - points[2].y) > 4 || abs(points[3].x - points[1].x) > 4
        ) return null
        val cell = (spanX + spanY) / 2 / (8 + BoardArt.INSET)
        val area = BoardArea(left + cell * BoardArt.INSET / 2, top + cell * BoardArt.INSET / 2, 8 * cell)
            .adjusted(calibration)
        if (!area.fits(frame)) return null

        val current = theme to set
        if (scheme != current) {
            scheme = current
            templates.clear()
        }
        val grid = if (reduced || cell < 37) 12 else 18
        val sample = IntArray(grid * grid)
        val position = StringBuilder(64)
        var confidence = 1f
        for (index in 0..63) {
            val col = index % 8
            val row = index / 8
            val isLight = (row + col) % 2 == 0
            val background = if (isLight) theme.light else theme.dark
            val leftCell = area.x + col * area.size / 8
            val topCell = area.y + row * area.size / 8
            val step = area.size / 8
            if (distance(frame.pixel((leftCell + step * .12f).toInt(), (topCell + step * .12f).toInt()), background) > 45)
                return null
            sampleInto(sample, grid, leftCell, topCell, step, frame::pixel)
            val options = templates.getOrPut(isLight to (grid == 12)) { createTemplates(grid, background, set) }
            var best = Int.MAX_VALUE
            var next = Int.MAX_VALUE
            var symbol = '.'
            for ((option, template) in options.withIndex()) {
                var score = 0
                for (pixel in sample.indices) score += distance(sample[pixel], template[pixel])
                if (score < best) {
                    next = best
                    best = score
                    symbol = BoardArt.PIECES[option]
                } else if (score < next) {
                    next = score
                }
            }
            val error = best / (3f * sample.size)
            val margin = (next - best) / (3f * sample.size)
            if (error > 22f || margin < 3.2f) return null
            confidence = minOf(confidence, (1f - error / 40f) * (margin / 8f).coerceAtMost(1f))
            position.append(symbol)
        }
        return ObservedBoard(position.toString(), confidence)
    }

    private fun createTemplates(grid: Int, background: Int, set: PieceSet): List<IntArray> {
        val size = 96
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        return try {
            BoardArt.PIECES.map { piece ->
                BoardArt.drawCell(canvas, 0f, 0f, size.toFloat(), background, piece, set)
                IntArray(grid * grid).also { sampleInto(it, grid, 0f, 0f, size.toFloat(), bitmap::getPixel) }
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun sampleInto(output: IntArray, grid: Int, x: Float, y: Float, size: Float, pixel: (Int, Int) -> Int) {
        for (row in 0 until grid) {
            val sy = (y + size * (.115f + .77f * (row + .5f) / grid)).toInt()
            for (col in 0 until grid) {
                val sx = (x + size * (.115f + .77f * (col + .5f) / grid)).toInt()
                output[row * grid + col] = pixel(sx, sy)
            }
        }
    }

    private fun locate(frame: RgbFrame, colors: List<Int>): List<Point>? {
        val step = max(2, minOf(frame.width, frame.height) / 300)
        val sumX = IntArray(4)
        val sumY = IntArray(4)
        val count = IntArray(4)
        for (y in 0 until frame.height step step) {
            for (x in 0 until frame.width step step) {
                val pixel = frame.pixel(x, y)
                for (index in colors.indices) {
                    if (distance(pixel, colors[index]) <= 6) {
                        sumX[index] += x
                        sumY[index] += y
                        count[index]++
                        break
                    }
                }
            }
        }
        if (count.any { it == 0 }) return null
        val points = colors.indices.map { Point(sumX[it].toFloat() / count[it], sumY[it].toFloat() / count[it]) }
        return points.takeIf { validMarkers(frame, it, colors) }
    }

    private fun validMarkers(frame: RgbFrame, points: List<Point>, colors: List<Int>): Boolean =
        points.indices.all { index ->
            val x = points[index].x.roundToInt()
            val y = points[index].y.roundToInt()
            x in 0 until frame.width && y in 0 until frame.height && distance(frame.pixel(x, y), colors[index]) <= 12
        }
}

private fun distance(a: Int, b: Int): Int =
    abs((a shr 16 and 255) - (b shr 16 and 255)) + abs((a shr 8 and 255) - (b shr 8 and 255)) + abs((a and 255) - (b and 255))

internal class PositionTracker(start: Game) {
    var game = start
        private set

    fun update(observed: ObservedBoard, trusted: Game): Game? {
        val forward = observed.display == trusted.position.board
        val flipped = observed.display.reversed() == trusted.position.board
        if (forward == flipped || observed.confidence < .48f) return null
        if (game.start.fen != trusted.start.fen || trusted.moves.size < game.moves.size ||
            trusted.moves.take(game.moves.size) != game.moves
        ) return null
        val missing = trusted.moves.size - game.moves.size
        if (missing > 2) return null
        var reconstructed = game
        for (move in trusted.moves.drop(game.moves.size)) {
            reconstructed = reconstructed.addUci(move.uci) ?: return null
        }
        if (reconstructed.position.board != (if (flipped) observed.display.reversed() else observed.display)) return null
        game = reconstructed
        return reconstructed
    }
}
