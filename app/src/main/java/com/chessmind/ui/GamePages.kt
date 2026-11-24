package com.chessmind.ui

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chessmind.chess.Game
import com.chessmind.chess.Position
import com.chessmind.chess.placement
import com.chessmind.engine.moveDescription
import com.chessmind.engine.sanLine
import com.chessmind.engine.scoreText
import com.chessmind.screen.Calibration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

@Composable
internal fun RoundPage(state: ChessState, model: ChessViewModel, running: Boolean, captureStatus: String,
                       requestAssistant: () -> Unit, stopAssistant: () -> Unit) {
    val round = state.active ?: return
    val position = state.game.position
    val yourTurn = position.whiteToMove == state.playerWhite
    val status = state.outcome?.let { outcomeText(it, position.whiteToMove) } ?: when {
        state.autoPaused -> "Автопилот на паузе"
        round == Round.AUTO -> if (position.whiteToMove) "Ход белых" else "Ход чёрных"
        yourTurn -> if (position.isCheck) "Ваш ход · Шах" else "Ваш ход"
        else -> "Ход Stockfish"
    }
    var calibrationOpen by rememberSaveable { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = model::closeRound, contentPadding = PaddingValues(0.dp)) { Text("←  Выйти из партии") }
            if (round == Round.ASSISTED) {
                FilledTonalButton(
                    onClick = if (running) stopAssistant else requestAssistant,
                    enabled = state.outcome == null || running,
                    contentPadding = PaddingValues(horizontal = 11.dp),
                ) { Text(if (running) "Остановить захват" else "Включить захват экрана", fontSize = 12.sp) }
            }
        }
        PageTitle(round.label, status)
    }

    ChessBoard(position.board, state.prefs.theme, state.prefs.pieces,
        Modifier.alignBoard(), flipped = state.flipped, selected = state.selected,
        previous = state.game.moves.lastOrNull(), markers = state.capture?.colors,
        onTap = if (round != Round.AUTO && state.outcome == null) model::tap else null)

    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(onClick = model::flip) { Text("Развернуть") }
        if (state.game.moves.isNotEmpty()) TextButton(onClick = { model.save(state.game, round.label) }) { Text("Сохранить") }
        if (round == Round.AUTO && state.outcome == null) TextButton(onClick = model::pauseAuto) {
            Text(if (state.autoPaused) "Продолжить" else "Пауза")
        }
    }

    if (round == Round.ASSISTED) {
        Text(captureStatus.lineSequence().first(), color = Muted, fontSize = 13.sp)
        if (running) {
            TextButton(onClick = { calibrationOpen = !calibrationOpen }) {
                Text(if (calibrationOpen) "Скрыть калибровку" else "Калибровка и прозрачность")
            }
            if (calibrationOpen) {
                Text("Если окно перекрывает клетки, перетащите его за заголовок.", color = Muted, fontSize = 13.sp)
                Step("Сдвиг по горизонтали", state.calibration.x, -.2f.. .2f) {
                    model.calibrate(state.calibration.copy(x = it))
                }
                Step("Сдвиг по вертикали", state.calibration.y, -.2f.. .2f) {
                    model.calibrate(state.calibration.copy(y = it))
                }
                Step("Размер области", state.calibration.zoom, -.45f.. .45f) {
                    model.calibrate(state.calibration.copy(zoom = it))
                }
                Step("Непрозрачность · ${(state.prefs.opacity * 100).roundToInt()}%", state.prefs.opacity, .45f..1f) {
                    model.opacity(it)
                }
                TextButton(onClick = { model.calibrate(Calibration()) }) { Text("Сбросить калибровку") }
            }
        }
    }
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.note?.let {
        Text(it, color = Muted, fontSize = 14.sp)
        if (!state.busy && state.outcome == null && (!yourTurn || round == Round.AUTO) && it != "Добавлено в историю") {
            OutlinedButton(model::retryBot) { Text("Повторить ход бота") }
        }
    }

    if (state.game.moves.isNotEmpty()) Notation(state.game, state.game.moves.size)
    if (state.promotion.isNotEmpty()) {
        AlertDialog(onDismissRequest = { model.promote(null) }, title = { Text("Превращение пешки") },
            text = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (option in state.promotion) {
                        val symbol = checkNotNull(option.promotion)
                        PieceTile(if (position.whiteToMove) symbol.uppercaseChar() else symbol, state.prefs.pieces, Modifier.size(51.dp)) {
                            model.promote(symbol)
                        }
                    }
                }
            }, confirmButton = {}, dismissButton = { TextButton({ model.promote(null) }) { Text("Отмена") } })
    }
}

@Composable
internal fun AnalysisPage(state: ChessState, model: ChessViewModel, openManual: () -> Unit) {
    var format by rememberSaveable { mutableStateOf("PGN") }
    var text by rememberSaveable { mutableStateOf("") }
    PageTitle("Анализ")
    OutlinedButton(onClick = openManual, modifier = Modifier.fillMaxWidth()) { Text("Расставить фигуры вручную") }
    Chips(listOf("PGN", "FEN"), format, { it }) { format = it; text = "" }
    OutlinedTextField(text, { text = it.take(150_000) }, modifier = Modifier.fillMaxWidth(),
        label = { Text(if (format == "PGN") "Текст партии PGN" else "Позиция FEN") },
        minLines = if (format == "PGN") 2 else 1, maxLines = 5)
    Button(onClick = { model.loadText(text, format == "PGN") },
        enabled = text.isNotBlank() && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Загрузить") }
    val game = state.replay
    state.note?.let { Text(it, color = Muted, fontSize = 14.sp) }
    if (game == null) {
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        return
    }
    val position = game.positions[state.ply]
    ChessBoard(position.board, state.prefs.theme, state.prefs.pieces, Modifier.alignBoard(),
        flipped = state.flipped, previous = game.moves.getOrNull(state.ply - 1))
    if (game.moves.isNotEmpty()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton({ model.ply(state.ply - 1) }, enabled = state.ply > 0) { Text("←") }
            Text("${state.ply} / ${game.moves.size}", fontSize = 14.sp)
            OutlinedButton({ model.ply(state.ply + 1) }, enabled = state.ply < game.moves.size) { Text("→") }
        }
        Notation(game, state.ply, model::ply)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = model::flip) { Text("Развернуть") }
        val clipboard = LocalClipboard.current
        val scope = rememberCoroutineScope()
        TextButton(onClick = {
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("FEN", position.fen))) }
        }) { Text("Копировать FEN") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(model::analyze, enabled = !state.busy && state.result == null) { Text("Рассчитать") }
        OutlinedButton({ model.save(game, if (game.moves.isEmpty()) "Позиция" else "Анализ партии") }) { Text("Сохранить") }
    }
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.result?.let { result ->
        Column(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(8.dp)).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (result.best == null) {
                Text(if (position.isCheck) "Мат" else "Пат", fontWeight = FontWeight.SemiBold)
            } else {
                Text(moveDescription(position, result.best), fontWeight = FontWeight.SemiBold)
                for (line in result.variations) {
                    Text("${scoreText(line, position.whiteToMove)}    ${sanLine(position, line.moves)}",
                        color = if (line.moves.firstOrNull() == result.best) Gold else Cream,
                        fontFamily = FontFamily.Monospace, fontSize = 14.sp)
                }
                Text("${result.milliseconds} мс · Stockfish 17.1", color = Muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun Notation(game: Game, ply: Int, navigate: ((Int) -> Unit)? = null) {
    val notation by produceState(emptyList(), game) {
        value = withContext(Dispatchers.Default) { game.notation() }
    }
    val scroll = rememberScrollState()
    if (navigate == null) LaunchedEffect(notation.size, scroll.maxValue) { scroll.scrollTo(scroll.maxValue) }
    Row(Modifier.fillMaxWidth().horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        for ((index, move) in notation.withIndex()) {
            val number = game.positions[index].fullMove
            val label = when {
                game.positions[index].whiteToMove -> "$number. $move"
                index == 0 -> "$number… $move"
                else -> move
            }
            if (navigate == null) {
                Text(label, color = if (index == ply - 1) Gold else Muted,
                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 6.dp), fontSize = 14.sp)
            } else {
                FilterChip(selected = index == ply - 1, onClick = { navigate(index + 1) }, label = { Text(label) })
            }
        }
    }
}

@Composable
internal fun ManualPage(prefs: Preferences, onAccept: (Game) -> Unit, onClose: () -> Unit) {
    var board by rememberSaveable { mutableStateOf(Position.initial().board) }
    var selected by rememberSaveable { mutableStateOf('K') }
    var white by rememberSaveable { mutableStateOf(true) }
    var rights by rememberSaveable { mutableStateOf("KQkq") }
    var target by rememberSaveable { mutableStateOf("-") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    TextButton(onClose, contentPadding = PaddingValues(0.dp)) { Text("←  К анализу") }
    PageTitle("Расстановка", "Выберите фигуру и коснитесь клетки.")
    ChessBoard(board, prefs.theme, prefs.pieces, Modifier.alignBoard(), onTap = { index ->
        board = board.replaceRange(index, index + 1, selected.toString())
        error = null
    })
    for (palette in listOf("KQRBNP.", "kqrbnp")) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (piece in palette) {
                PieceTile(piece, prefs.pieces, Modifier.weight(1f).aspectRatio(1f), piece == selected) { selected = piece }
            }
            if (palette.length == 6) Spacer(Modifier.weight(1f))
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton({ board = ".".repeat(64); rights = "-"; target = "-"; error = null }) { Text("Очистить") }
        TextButton({ board = Position.initial().board; rights = "KQkq"; target = "-"; white = true; error = null }) {
            Text("Начальная")
        }
    }
    Field("Очередь хода") { Chips(listOf("Белые", "Чёрные"), if (white) "Белые" else "Чёрные", { it }) { white = it == "Белые" } }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(rights, { rights = it.take(4) }, label = { Text("Рокировка") },
            supportingText = { Text("KQkq или –") }, singleLine = true, modifier = Modifier.weight(1f))
        OutlinedTextField(target, { target = it.take(2) }, label = { Text("На проходе") },
            supportingText = { Text("Клетка или –") }, singleLine = true, modifier = Modifier.weight(1f))
    }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button(onClick = {
        val fen = "${placement(board)} ${if (white) "w" else "b"} ${rights.trim().ifEmpty { "-" }} ${target.trim().ifEmpty { "-" }} 0 1"
        runCatching { Game(Position.parse(fen)) }.onSuccess(onAccept).onFailure { error = it.message }
    }, modifier = Modifier.fillMaxWidth()) { Text("Проверить и открыть позицию") }
}

private fun Modifier.alignBoard(): Modifier = widthIn(max = 490.dp).fillMaxWidth()
