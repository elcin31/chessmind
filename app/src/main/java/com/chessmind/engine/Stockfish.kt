package com.chessmind.engine

import android.content.Context
import android.os.PowerManager
import com.chessmind.chess.Game
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.BufferedWriter
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

enum class Pace(val milliseconds: Int, val title: String) {
    FAST(360, "Быстрый"), STANDARD(950, "Стандартный"), DEEP(3_800, "Глубокий")
}

data class EngineSettings(
    val pace: Pace = Pace.STANDARD,
    val depth: Int = 20,
    val threads: Int = 2,
    val hash: Int = 24,
)

data class Variation(val rank: Int, val depth: Int, val cp: Int?, val mate: Int?, val moves: List<String>)
data class EngineResult(val best: String?, val variations: List<Variation>, val milliseconds: Long)

internal fun parseVariation(line: String): Variation? {
    if (!line.startsWith("info ")) return null
    val words = line.split(' ')
    if ("upperbound" in words || "lowerbound" in words) return null
    fun value(key: String): String? {
        val index = words.indexOf(key)
        return if (index >= 0) words.getOrNull(index + 1) else null
    }
    val type = value("score") ?: return null
    val score = words.getOrNull(words.indexOf("score") + 2)?.toIntOrNull() ?: return null
    val depth = value("depth")?.toIntOrNull() ?: return null
    val rank = value("multipv")?.toIntOrNull() ?: 1
    val pv = words.indexOf("pv")
    if (pv < 0 || pv == words.lastIndex || type !in listOf("cp", "mate")) return null
    return Variation(rank, depth, score.takeIf { type == "cp" }, score.takeIf { type == "mate" }, words.drop(pv + 1))
}

class Stockfish(context: Context) {
    private val executable = File(context.applicationInfo.nativeLibraryDir, "libstockfish.so")
    private val power = context.getSystemService(PowerManager::class.java)
    private val mutex = Mutex()
    private var session: Session? = null

    suspend fun analyze(game: Game, settings: EngineSettings, lines: Int = 3, skill: Int = 20): EngineResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                try {
                    val thermal = power.currentThermalStatus
                    check(thermal < PowerManager.THERMAL_STATUS_CRITICAL) { "Анализ приостановлен из-за нагрева" }
                    val hot = thermal >= PowerManager.THERMAL_STATUS_SEVERE || power.isPowerSaveMode
                    val threads = if (hot) 1 else settings.threads.coerceIn(1, 4)
                    val hash = settings.hash.coerceIn(8, 96)
                    val millis = if (hot) minOf(settings.pace.milliseconds, 500) else settings.pace.milliseconds
                    val depth = settings.depth.coerceIn(1, 30)
                    val limit = minOf(lines, game.position.legalMoves().size)
                    if (limit <= 0) return@withLock EngineResult(null, emptyList(), 0)

                    val start = System.nanoTime()
                    val engine = session?.takeIf { it.process.isAlive } ?: Session(executable).also {
                        session?.close()
                        session = it
                        it.send("uci")
                        it.until(12_000) { line -> line == "uciok" }
                    }
                    engine.option("Threads", threads)
                    engine.option("Hash", hash)
                    engine.option("MultiPV", limit)
                    engine.option("Skill Level", skill.coerceIn(0, 20))
                    engine.send("isready")
                    engine.until(12_000) { it == "readyok" }
                    val history = game.moves.joinToString(" ") { it.uci }
                    engine.send("position fen ${game.start.fen}" + if (history.isEmpty()) "" else " moves $history")
                    engine.send("go movetime $millis depth $depth")
                    val variations = mutableMapOf<Int, MutableMap<Int, Variation>>()
                    val bestLine = engine.until(millis + 8_000) { line ->
                        parseVariation(line)?.let { variations.getOrPut(it.depth) { mutableMapOf() }[it.rank] = it }
                        line.startsWith("bestmove ")
                    }
                    val best = bestLine.split(' ').getOrNull(1)?.takeIf { it != "(none)" && it != "0000" }
                    val completed = variations.keys.sortedDescending().firstOrNull { variations.getValue(it).size >= limit }
                    val candidates = (completed ?: variations.keys.maxOrNull())?.let { variations.getValue(it).values }
                        .orEmpty().sortedBy { it.rank }
                    val ranked = if (best == null) candidates else candidates.sortedByDescending { it.moves.firstOrNull() == best }
                    EngineResult(best, ranked, (System.nanoTime() - start) / 1_000_000)
                } catch (failure: Exception) {
                    session?.close()
                    session = null
                    throw failure
                }
            }
        }

    suspend fun close() = withContext(Dispatchers.IO) {
        mutex.withLock {
            session?.close()
            session = null
        }
    }

    private class Session(executable: File) {
        val process: Process = ProcessBuilder(executable.absolutePath).redirectErrorStream(true).start()
        private val input: BufferedWriter = process.outputStream.bufferedWriter()
        private val output = LinkedBlockingQueue<String>(256)
        private val options = mutableMapOf<String, Int>()
        private val reader = Thread({
            try {
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { output.put(it) }
                }
            } catch (_: Exception) {
                // Closing the process also closes its pipe.
            }
        }, "Stockfish UCI").apply { isDaemon = true; start() }

        fun send(command: String) {
            input.write(command)
            input.newLine()
            input.flush()
        }

        fun option(name: String, value: Int) {
            if (options[name] == value) return
            send("setoption name $name value $value")
            options[name] = value
        }

        suspend fun until(timeoutMs: Int, predicate: (String) -> Boolean): String {
            val until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.toLong())
            val context = currentCoroutineContext()
            while (System.nanoTime() < until) {
                context.ensureActive()
                val line = output.poll(30, TimeUnit.MILLISECONDS)
                if (line != null && predicate(line)) return line
                check(process.isAlive || output.isNotEmpty()) { "Stockfish завершил работу" }
            }
            error("Stockfish не ответил вовремя")
        }

        fun close() {
            process.destroyForcibly()
            reader.interrupt()
            runCatching { input.close() }
        }
    }
}
