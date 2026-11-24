package com.chessmind

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.chessmind.chess.Game
import com.chessmind.chess.Position
import com.chessmind.engine.EngineSettings
import com.chessmind.engine.Pace
import com.chessmind.screen.*
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceTest {
    @Test fun launchAndRejectUnapprovedSurface() {
        val runner = InstrumentationRegistry.getInstrumentation()
        val activity = runner.startActivitySync(Intent(runner.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        runner.waitForIdleSync()
        assertNotNull(activity.window.decorView)
        assertNull(CaptureGate.surface.value)
        assertFalse(CaptureGate.running.value)
        runner.runOnMainSync { activity.finish() }
    }

    @Test fun allSkinsOrientationsAndAdaptiveSampling() {
        val markers = listOf(0xFF1863CD, 0xFFDB258A, 0xFF27BF53, 0xFFEB6521).map { it.toInt() }
        val game = Game.importPgn("1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3")
        for (theme in BoardTheme.entries) for (set in PieceSet.entries) for (flipped in listOf(false, true)) {
            for (boardSize in listOf(246, 488)) {
                val recognizer = Recognizer()
                val bitmap = Bitmap.createBitmap(510, 700, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                canvas.translate(8f, 48f)
                BoardArt.draw(canvas, boardSize.toFloat(), game.position.board, flipped, theme, set, 52, 50 to 42, markers)
                val frame = BitmapFrame(bitmap)
                val seen = recognizer.read(frame, markers, theme, set, Calibration(), boardSize < 300)
                assertNotNull("$theme $set $flipped $boardSize", seen)
                val tracked = PositionTracker(game).update(seen!!, game)
                assertEquals("$theme $set $flipped $boardSize; confidence ${seen.confidence}", game.position.fen, tracked?.position?.fen)
                val wrong = markers.toMutableList().apply { set(0, 0xFFFF0000.toInt()) }
                assertNull(recognizer.read(frame, wrong, theme, set, Calibration(), false))
                bitmap.recycle()
            }
        }
    }

    @Test fun continuityAndTrust() {
        val start = Game()
        val tracker = PositionTracker(start)
        val twoMoves = start.addUci("e2e4")!!.addUci("c7c5")!!
        val observed = ObservedBoard(twoMoves.position.board, .92f)
        assertNull(tracker.update(observed, start))
        assertNull(tracker.update(observed.copy(confidence = .1f), twoMoves))
        assertEquals(twoMoves.position.fen, tracker.update(observed, twoMoves)?.position?.fen)
        assertNull(tracker.update(ObservedBoard(start.position.board, 1f), start))
    }

    @Test fun packagedEngineMultiPvMateAndCancellation() = runBlocking {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as ChessMindApp
        val engine = app.stockfish
        try {
            val settings = EngineSettings(Pace.FAST, 12, 1, 16)
            val game = Game()
            val initial = engine.analyze(game, settings)
            assertTrue(game.position.legalMoves().any { it.uci == initial.best })
            assertEquals(3, initial.variations.size)
            val mate = Game(Position.parse("7k/8/5KQ1/8/8/8/8/8 w - - 0 1"))
            val mating = engine.analyze(mate, settings)
            assertEquals(1, mating.variations.firstOrNull()?.mate)
            val future = async { engine.analyze(game, settings.copy(pace = Pace.DEEP, depth = 30)) }
            delay(170)
            val cancelledAt = SystemClock.elapsedRealtime()
            future.cancelAndJoin()
            assertTrue(SystemClock.elapsedRealtime() - cancelledAt < 1_500)
            assertNotNull(engine.analyze(game, settings).best)
        } finally {
            engine.close()
        }
    }

    @Test fun measureWarmEngineBudgets() = runBlocking {
        val engine = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as ChessMindApp).stockfish
        val middle = Game.importPgn("1. e4 c5 2. Nf3 d6")
        try {
            engine.analyze(Game(), EngineSettings(pace = Pace.FAST))
            for (pace in Pace.entries) {
                val result = engine.analyze(middle, EngineSettings(pace = pace))
                assertTrue(middle.position.legalMoves().any { it.uci == result.best })
                Log.i("ChessMindBenchmark", "${pace.name} ${result.milliseconds} ms, depth ${result.variations.firstOrNull()?.depth}")
            }
        } finally {
            engine.close()
        }
    }

    private class BitmapFrame(private val bitmap: Bitmap) : RgbFrame {
        override val width = bitmap.width
        override val height = bitmap.height
        override fun pixel(x: Int, y: Int) = bitmap.getPixel(x, y)
    }
}
