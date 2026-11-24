package com.chessmind.screen

import android.graphics.Bitmap
import android.graphics.Canvas
import com.chessmind.chess.Game
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

internal fun interface ColorSource {
    fun pixel(x: Int, y: Int): Int
}

internal interface RgbFrame : ColorSource {
    val width: Int
    val height: Int
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
        val grid = if (reduced || cell < 37) 16 else 20
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
            sampleInto(sample, grid, leftCell, topCell, step, frame)
            val options = templates.getOrPut(isLight to (grid == 16)) { createTemplates(grid, background, set) }
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
            if (error > 20f || margin < 2.7f) return null
            confidence = minOf(confidence, (1f - error / 48f) * (margin / 6f).coerceAtMost(1f))
            position.append(symbol)
        }
        return ObservedBoard(position.toString(), confidence)
    }

    private fun createTemplates(grid: Int, background: Int, set: PieceSet): List<IntArray> {
        val size = 96
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val source = ColorSource(bitmap::getPixel)
        return try {
            BoardArt.PIECES.map { piece ->
                BoardArt.drawCell(canvas, 0f, 0f, size.toFloat(), background, piece, set)
                IntArray(grid * grid).also { sampleInto(it, grid, 0f, 0f, size.toFloat(), source) }
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun sampleInto(output: IntArray, grid: Int, x: Float, y: Float, size: Float, source: ColorSource) {
        // Compare low-pass samples so a thin outline does not move between bins after downscaling.
        val radius = size * .0224f
        for (row in 0 until grid) {
            val centerY = y + size * (.115f + .77f * (row + .5f) / grid) - .5f
            for (col in 0 until grid) {
                val centerX = x + size * (.115f + .77f * (col + .5f) / grid) - .5f
                val redGreenBlue = averageRgb(centerX, centerY, radius, source)
                output[row * grid + col] = redGreenBlue
            }
        }
    }

    private fun averageRgb(x: Float, y: Float, radius: Float, source: ColorSource): Int {
        var red = 0f
        var green = 0f
        var blue = 0f
        for (row in -1..1) {
            val sampleY = y + row * radius
            val iy = sampleY.toInt()
            val wy = sampleY - iy
            for (col in -1..1) {
                val sampleX = x + col * radius
                val ix = sampleX.toInt()
                val wx = sampleX - ix
                for (dy in 0..1) {
                    val vertical = if (dy == 0) 1f - wy else wy
                    for (dx in 0..1) {
                        val weight = vertical * if (dx == 0) 1f - wx else wx
                        val color = source.pixel(ix + dx, iy + dy)
                        red += (color shr 16 and 255) * weight
                        green += (color shr 8 and 255) * weight
                        blue += (color and 255) * weight
                    }
                }
            }
        }
        return ((red / 9).roundToInt() shl 16) or ((green / 9).roundToInt() shl 8) or (blue / 9).roundToInt()
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
        val points = colors.indices.map { index ->
            val x = sumX[index].toFloat() / count[index]
            val y = sumY[index].toFloat() / count[index]
            refinePoint(frame, x.roundToInt(), y.roundToInt(), step * 3, colors[index])
                ?: return null
        }
        return points.takeIf { validMarkers(frame, it, colors) }
    }

    private fun refinePoint(frame: RgbFrame, x: Int, y: Int, radius: Int, color: Int): Point? {
        var sumX = 0f
        var sumY = 0f
        var count = 0
        for (row in (y - radius).coerceAtLeast(0)..(y + radius).coerceAtMost(frame.height - 1)) {
            for (col in (x - radius).coerceAtLeast(0)..(x + radius).coerceAtMost(frame.width - 1)) {
                if (distance(frame.pixel(col, row), color) <= 9) {
                    sumX += col + .5f
                    sumY += row + .5f
                    count++
                }
            }
        }
        return if (count > 0) Point(sumX / count, sumY / count) else null
    }

    private fun validMarkers(frame: RgbFrame, points: List<Point>, colors: List<Int>): Boolean =
        points.indices.all { index ->
            val x = points[index].x.toInt()
            val y = points[index].y.toInt()
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
