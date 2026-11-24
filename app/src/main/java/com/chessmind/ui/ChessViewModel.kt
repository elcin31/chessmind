package com.chessmind.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.chessmind.ChessMindApp
import com.chessmind.chess.Game
import com.chessmind.chess.Move
import com.chessmind.chess.Outcome
import com.chessmind.chess.Position
import com.chessmind.engine.EngineResult
import com.chessmind.engine.EngineSettings
import com.chessmind.engine.Pace
import com.chessmind.screen.BoardTheme
import com.chessmind.screen.Calibration
import com.chessmind.screen.CaptureGate
import com.chessmind.screen.CaptureKey
import com.chessmind.screen.PieceSet
import com.chessmind.screen.TrainingSurface
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal enum class Section(val label: String) {
    HOME("Главная"), ASSISTANT("Ассистент"), ANALYSIS("Анализ"),
    TRAINING("Тренировки"), HISTORY("История"), SETTINGS("Настройки")
}

internal enum class Round(val label: String) { ASSISTED("Ассистент"), TRAINING("Тренировка"), AUTO("Автопилот") }
internal enum class Difficulty(val title: String, val skill: Int, val depth: Int) {
    BEGINNER("Начальная", 0, 5), CLUB("Клубная", 8, 11), MASTER("Мастер", 20, 20)
}

internal data class Preferences(
    val engine: EngineSettings = EngineSettings(),
    val theme: BoardTheme = BoardTheme.WALNUT,
    val pieces: PieceSet = PieceSet.IVORY,
    val opacity: Float = .94f,
)
internal data class Entry(val id: String, val name: String, val time: Long, val game: Game)

internal data class ChessState(
    val section: Section = Section.HOME,
    val prefs: Preferences = Preferences(),
    val active: Round? = null,
    val game: Game = Game(),
    val playerWhite: Boolean = true,
    val flipped: Boolean = false,
    val skill: Difficulty = Difficulty.CLUB,
    val selected: Int? = null,
    val promotion: List<Move> = emptyList(),
    val outcome: Outcome? = null,
    val capture: CaptureKey? = null,
    val calibration: Calibration = Calibration(),
    val replay: Game? = null,
    val ply: Int = 0,
    val result: EngineResult? = null,
    val busy: Boolean = false,
    val autoPaused: Boolean = false,
    val note: String? = null,
    val history: List<Entry> = emptyList(),
)

internal class ChessViewModel(app: Application) : AndroidViewModel(app) {
    private val store = app.getSharedPreferences("chessmind", 0)
    private val engine = (app as ChessMindApp).stockfish
    private val mutable = MutableStateFlow(ChessState(prefs = readSettings()))
    val state = mutable.asStateFlow()
    private var work: Job? = null
    private var resumed = false
    private var focused = false

    init {
        viewModelScope.launch {
            val history = withContext(Dispatchers.Default) { readHistory() }
            if (mutable.value.history.isEmpty()) change { it.copy(history = history) }
        }
    }

    private fun change(update: (ChessState) -> ChessState) {
        mutable.value = update(mutable.value)
        publishSurface()
    }

    fun navigate(section: Section) {
        if (section == mutable.value.section) return
        work?.cancel()
        change { it.copy(section = section, active = null, capture = null, selected = null, promotion = emptyList(),
            busy = false, note = null, autoPaused = false) }
    }

    fun start(round: Round, white: Boolean, difficulty: Difficulty) {
        work?.cancel()
        change { it.copy(
            section = if (round == Round.ASSISTED) Section.ASSISTANT else Section.TRAINING,
            active = round, game = Game(), playerWhite = white, flipped = !white, skill = difficulty,
            selected = null, promotion = emptyList(), outcome = null, capture = null,
            calibration = Calibration(), result = null, busy = false, autoPaused = false, note = null
        ) }
        playBotIfNeeded()
    }

    fun closeRound() {
        work?.cancel()
        change { it.copy(active = null, capture = null, selected = null, promotion = emptyList(), busy = false, note = null) }
    }

    fun flip() = change { it.copy(flipped = !it.flipped) }

    fun tap(square: Int) {
        val s = mutable.value
        if (s.active == null || s.active == Round.AUTO || s.outcome != null ||
            s.game.position.whiteToMove != s.playerWhite || s.promotion.isNotEmpty()
        ) return
        val piece = s.game.position.board[square]
        if (square == s.selected) {
            change { it.copy(selected = null) }
            return
        }
        if (piece != '.' && piece.isUpperCase() == s.playerWhite) {
            change { it.copy(selected = square) }
            return
        }
        val options = s.game.position.legalMoves().filter { it.from == s.selected && it.to == square }
        when (options.size) {
            0 -> change { it.copy(selected = null) }
            1 -> makeMove(options.single())
            else -> change { it.copy(promotion = options) }
        }
    }

    fun promote(piece: Char?) {
        val move = mutable.value.promotion.firstOrNull { it.promotion == piece }
        if (move != null) makeMove(move) else change { it.copy(promotion = emptyList()) }
    }

    private fun makeMove(move: Move) {
        val s = mutable.value
        val next = s.game.add(move) ?: return
        val outcome = next.outcome
        change { it.copy(game = next, selected = null, promotion = emptyList(), outcome = outcome, note = null) }
        if (outcome != null) save(next, s.active?.label ?: "Партия", feedback = false)
        playBotIfNeeded()
    }

    fun pauseAuto() {
        val s = mutable.value
        if (s.active != Round.AUTO) return
        work?.cancel()
        change { it.copy(autoPaused = !s.autoPaused, busy = false) }
        playBotIfNeeded()
    }

    fun retryBot() = playBotIfNeeded()

    private fun playBotIfNeeded() {
        val s = mutable.value
        if (!resumed || s.active == null || s.outcome != null || s.autoPaused || s.busy ||
            (s.active != Round.AUTO && s.game.position.whiteToMove == s.playerWhite)
        ) return
        change { it.copy(busy = true, note = null) }
        work = viewModelScope.launch {
            try {
                if (s.active == Round.AUTO) delay(180)
                val settings = s.prefs.engine.copy(pace = Pace.FAST, depth = minOf(s.skill.depth, s.prefs.engine.depth))
                val analysis = engine.analyze(s.game, settings, lines = 1, skill = s.skill.skill)
                val move = s.game.position.legalMoves().firstOrNull { it.uci == analysis.best }
                    ?: error("Stockfish не вернул легальный ход")
                if (mutable.value.game != s.game || mutable.value.active != s.active) return@launch
                change { it.copy(busy = false) }
                makeMove(move)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (mutable.value.game == s.game && mutable.value.active == s.active) {
                    change { it.copy(busy = false, note = failure.message ?: "Ошибка Stockfish") }
                }
            }
        }
    }

    fun activityResumed(value: Boolean) {
        resumed = value
        publishSurface()
        if (!value && mutable.value.busy && mutable.value.active != null) {
            work?.cancel()
            change { it.copy(busy = false) }
        }
        if (value) playBotIfNeeded()
    }

    fun activityFocused(value: Boolean) {
        focused = value
        publishSurface()
    }

    fun armCapture(): CaptureKey? {
        if (mutable.value.active != Round.ASSISTED || mutable.value.outcome != null) return null
        val key = CaptureKey.create()
        change { it.copy(capture = key) }
        CaptureGate.status.value = "Ожидание разрешения"
        return key
    }

    fun stopCapture(message: String = "Экранный ассистент выключен") {
        change { it.copy(capture = null) }
        CaptureGate.status.value = message
    }

    fun calibrate(value: Calibration) = change { it.copy(calibration = value) }
    fun opacity(value: Float) = updateSettings(mutable.value.prefs.copy(opacity = value))

    private fun publishSurface() {
        val s = mutable.value
        val key = s.capture
        CaptureGate.surface.value = if (s.active == Round.ASSISTED && key != null) TrainingSurface(
            key, s.game, s.playerWhite, resumed && focused && s.promotion.isEmpty(),
            s.prefs.theme, s.prefs.pieces, s.prefs.engine, s.prefs.opacity, s.calibration, s.outcome != null
        ) else null
    }

    fun updateSettings(prefs: Preferences) {
        store.edit().putString("pace", prefs.engine.pace.name).putInt("depth", prefs.engine.depth)
            .putInt("threads", prefs.engine.threads).putInt("hash", prefs.engine.hash)
            .putString("theme", prefs.theme.name).putString("pieces", prefs.pieces.name)
            .putFloat("opacity", prefs.opacity).apply()
        change { it.copy(prefs = prefs) }
    }

    fun loadText(input: String, pgn: Boolean) {
        work?.cancel()
        change { it.copy(busy = true, note = null) }
        work = viewModelScope.launch {
            try {
                val game = withContext(Dispatchers.Default) {
                    if (pgn) Game.importPgn(input) else Game(Position.parse(input))
                }
                openReplay(game)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                change { it.copy(busy = false, note = failure.message ?: "Не удалось прочитать позицию") }
            }
        }
    }

    fun openReplay(game: Game) {
        work?.cancel()
        change { it.copy(section = Section.ANALYSIS, replay = game, ply = game.moves.size,
            active = null, capture = null, result = null, busy = false, note = null) }
    }

    fun ply(value: Int) {
        if (value == mutable.value.ply) return
        work?.cancel()
        change { it.copy(ply = value.coerceIn(0, it.replay?.moves?.size ?: 0), result = null, busy = false, note = null) }
    }

    fun analyze() {
        val s = mutable.value
        val game = s.replay?.through(s.ply) ?: return
        if (s.busy || s.result != null) return
        change { it.copy(busy = true, note = null) }
        work = viewModelScope.launch {
            try {
                val result = engine.analyze(game, s.prefs.engine)
                if (mutable.value.replay == s.replay && mutable.value.ply == s.ply) {
                    change { it.copy(result = result, busy = false) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                change { it.copy(busy = false, note = failure.message ?: "Ошибка Stockfish") }
            }
        }
    }

    fun save(game: Game, name: String, feedback: Boolean = true) {
        val entry = Entry(UUID.randomUUID().toString(), name, System.currentTimeMillis(), game)
        val list = listOf(entry) + mutable.value.history.filterNot {
            it.game.start.fen == game.start.fen && it.game.moves == game.moves
        }.take(39)
        val json = JSONArray()
        for (item in list) {
            json.put(JSONObject().put("id", item.id).put("name", item.name).put("time", item.time)
                .put("fen", item.game.start.fen).put("moves", JSONArray(item.game.moves.map { it.uci })))
        }
        store.edit().putString("history", json.toString()).apply()
        change { it.copy(history = list, note = if (feedback) "Добавлено в историю" else it.note) }
    }

    private fun readSettings(): Preferences {
        fun <T : Enum<T>> pick(key: String, choices: List<T>, fallback: T): T =
            choices.firstOrNull { it.name == store.getString(key, null) } ?: fallback
        return Preferences(
            EngineSettings(pick("pace", Pace.entries, Pace.STANDARD), store.getInt("depth", 20),
                store.getInt("threads", 2), store.getInt("hash", 24)),
            pick("theme", BoardTheme.entries, BoardTheme.WALNUT),
            pick("pieces", PieceSet.entries, PieceSet.IVORY),
            store.getFloat("opacity", .94f)
        )
    }

    private fun readHistory(): List<Entry> {
        val json = runCatching { JSONArray(store.getString("history", "[]")) }.getOrElse { return emptyList() }
        return (0 until minOf(json.length(), 40)).mapNotNull { index ->
            runCatching {
                val item = json.getJSONObject(index)
                var game = Game(Position.parse(item.getString("fen")))
                val moves = item.getJSONArray("moves")
                for (ply in 0 until moves.length()) game = checkNotNull(game.addUci(moves.getString(ply)))
                Entry(item.getString("id"), item.getString("name"), item.getLong("time"), game)
            }.getOrNull()
        }
    }
}

internal fun outcomeText(outcome: Outcome, whiteToMove: Boolean): String = when (outcome) {
    Outcome.CHECKMATE -> if (whiteToMove) "Мат · выиграли чёрные" else "Мат · выиграли белые"
    Outcome.STALEMATE -> "Пат · ничья"
    Outcome.MATERIAL -> "Недостаточно фигур · ничья"
    Outcome.FIFTY_MOVES -> "Правило 50 ходов · ничья"
    Outcome.REPETITION -> "Троекратное повторение · ничья"
}
