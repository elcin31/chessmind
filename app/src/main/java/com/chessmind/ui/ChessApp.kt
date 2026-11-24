package com.chessmind.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chessmind.R
import com.chessmind.chess.Game
import com.chessmind.engine.Pace
import com.chessmind.screen.BoardTheme
import com.chessmind.screen.CaptureGate
import com.chessmind.screen.PieceSet
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

internal val Ink = Color(0xFF101B2D)
internal val Cream = Color(0xFFF5F1E8)
internal val Gold = Color(0xFFC8A96B)
internal val Panel = Color(0xFF1B2A3E)
internal val Muted = Color(0xFFB3BFCC)
private val Rule = Color(0xFF354457)
private val WarmInk = Color(0xFF423826)
private val contentWidth = 530.dp

private val colors = darkColorScheme(
    primary = Gold, onPrimary = Ink, secondary = Cream, onSecondary = Ink,
    background = Ink, onBackground = Cream, surface = Ink, onSurface = Cream,
    surfaceVariant = Panel, onSurfaceVariant = Muted, outline = Rule,
    error = Color(0xFFF2A795),
)

@Composable
internal fun ChessApp(model: ChessViewModel, requestAssistant: () -> Unit, stopAssistant: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val running by CaptureGate.running.collectAsStateWithLifecycle()
    val captureStatus by CaptureGate.status.collectAsStateWithLifecycle()
    var manual by rememberSaveable { mutableStateOf(false) }

    fun open(section: Section) {
        manual = false
        model.navigate(section)
    }
    BackHandler(manual || state.active != null || state.section != Section.HOME) {
        when {
            manual -> manual = false
            state.active != null -> model.closeRound()
            else -> open(Section.HOME)
        }
    }

    MaterialTheme(colorScheme = colors) {
        Scaffold(
            containerColor = Ink,
            topBar = { Header(state.section, { open(Section.HOME) }, { open(Section.SETTINGS) }) },
            bottomBar = { Navigation(state.section, ::open) },
        ) { insets ->
            Box(Modifier.fillMaxSize().padding(insets), contentAlignment = Alignment.TopCenter) {
                key(state.section, state.active, manual) {
                    Column(
                        Modifier.widthIn(max = contentWidth).fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 20.dp).padding(top = 14.dp, bottom = 22.dp),
                        verticalArrangement = Arrangement.spacedBy(15.dp)
                    ) {
                        when {
                            state.active != null -> RoundPage(state, model, running, captureStatus, requestAssistant, stopAssistant)
                            manual -> ManualPage(state.prefs, onAccept = { game ->
                                model.openReplay(game)
                                manual = false
                            }, onClose = { manual = false })
                            state.section == Section.HOME -> HomePage(::open)
                            state.section == Section.ASSISTANT -> SetupPage(true, model::start)
                            state.section == Section.TRAINING -> SetupPage(false, model::start)
                            state.section == Section.ANALYSIS -> AnalysisPage(state, model) { manual = true }
                            state.section == Section.HISTORY -> HistoryPage(state.history, model)
                            state.section == Section.SETTINGS -> SettingsPage(state.prefs, model::updateSettings)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(section: Section, home: () -> Unit, settings: () -> Unit) {
    Column(Modifier.background(Ink).statusBarsPadding()) {
        Row(
            Modifier.height(58.dp).fillMaxWidth().padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(Modifier.clickable(onClick = home), verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.ic_chessmind), null, Modifier.size(34.dp))
                Spacer(Modifier.width(9.dp))
                Text("ChessMind", fontFamily = FontFamily.Serif, fontWeight = FontWeight.Bold, fontSize = 24.sp)
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = settings, enabled = section != Section.SETTINGS) { Text("Настройки", fontSize = 12.sp) }
        }
        HorizontalDivider(color = Rule)
    }
}

@Composable
private fun Navigation(current: Section, open: (Section) -> Unit) {
    Column(Modifier.background(Ink)) {
        HorizontalDivider(color = Rule)
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(54.dp)) {
            val sections = listOf(Section.HOME, Section.ASSISTANT, Section.ANALYSIS, Section.TRAINING, Section.HISTORY)
            for (section in sections) {
                val selected = section == current
                Box(
                    Modifier.weight(1f).fillMaxHeight().clickable { open(section) },
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(if (selected) 17.dp else 5.dp, 2.dp)
                            .background(if (selected) Gold else Rule, RoundedCornerShape(1.dp)))
                        Spacer(Modifier.height(5.dp))
                        Text(section.label, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (selected) Gold else Muted, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
        }
    }
}

@Composable
internal fun PageTitle(text: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text, color = Cream, fontSize = 33.sp, lineHeight = 36.sp, fontFamily = FontFamily.Serif)
        if (subtitle != null) Text(subtitle, color = Muted, fontSize = 14.sp, lineHeight = 20.sp)
    }
}

@Composable
private fun HomePage(open: (Section) -> Unit) {
    val preview = remember { Game.importPgn("1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3") }
    Column(
        Modifier.clip(RoundedCornerShape(14.dp)).background(Cream).padding(17.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("Тренировка\nсо Stockfish", color = Ink, fontFamily = FontFamily.Serif, fontSize = 36.sp, lineHeight = 36.sp)
        Text("Сыграйте партию с ботом или разберите свою позицию. Всё работает офлайн.",
            color = WarmInk, lineHeight = 20.sp, fontSize = 14.sp)
        ChessBoard(preview.position.board, BoardTheme.WALNUT, PieceSet.IVORY,
            Modifier.align(Alignment.CenterHorizontally).widthIn(max = 330.dp).fillMaxWidth(), previous = preview.moves.last())
        Button(onClick = { open(Section.TRAINING) }, modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Cream)) {
            Text("Начать тренировку")
        }
    }
    ActionRow("Ассистент", "Подсказки в локальной партии с ботом") { open(Section.ASSISTANT) }
    ActionRow("Анализ позиции", "Импорт PGN, FEN и ручная расстановка") { open(Section.ANALYSIS) }
}

@Composable
private fun ActionRow(title: String, detail: String, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Panel).clickable(onClick = click)
        .padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Text(detail, color = Muted, fontSize = 12.sp)
        }
        Text("→", color = Gold, fontSize = 19.sp)
    }
}

@Composable
private fun SetupPage(assistant: Boolean, start: (Round, Boolean, Difficulty) -> Unit) {
    var white by rememberSaveable { mutableStateOf(true) }
    var difficulty by rememberSaveable { mutableStateOf(Difficulty.CLUB) }
    PageTitle(
        if (assistant) "Экранный ассистент" else "Тренировки",
        if (assistant) "Подсказки Stockfish в партии против бота на доске ChessMind. Для плавающего окна Android запросит два разрешения."
        else "Выберите сторону и силу соперника или наблюдайте за партией двух движков."
    )
    Field("Ваш цвет") { Chips(listOf("Белые", "Чёрные"), if (white) "Белые" else "Чёрные", { it }) { white = it == "Белые" } }
    Field("Сложность") { Chips(Difficulty.entries, difficulty, { it.title }) { difficulty = it } }
    Button({ start(if (assistant) Round.ASSISTED else Round.TRAINING, white, difficulty) }, Modifier.fillMaxWidth()) {
        Text(if (assistant) "Открыть доску ассистента" else "Играть со Stockfish")
    }
    if (!assistant) ActionRow("Автопилот", "Stockfish играет за обе стороны") { start(Round.AUTO, true, difficulty) }
}

@Composable
internal fun <T> Chips(options: List<T>, selected: T, label: (T) -> String, onSelect: (T) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        options.forEach { item -> FilterChip(selected = item == selected, onClick = { onSelect(item) },
            label = { Text(label(item), maxLines = 1) },
            colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Gold, selectedLabelColor = Ink)) }
    }
}

@Composable
internal fun Field(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        content()
    }
}

@Composable
private fun SettingsPage(prefs: Preferences, update: (Preferences) -> Unit) {
    PageTitle("Настройки")
    Field("Скорость анализа") {
        Chips(Pace.entries, prefs.engine.pace, { it.title }) { update(prefs.copy(engine = prefs.engine.copy(pace = it))) }
        Text("Бюджет поиска · ${prefs.engine.pace.milliseconds} мс", color = Muted, fontSize = 12.sp)
    }
    Step("Глубина до ${prefs.engine.depth}", prefs.engine.depth.toFloat(), 1f..30f, 28) {
        update(prefs.copy(engine = prefs.engine.copy(depth = it.roundToInt())))
    }
    Step("Потоки · ${prefs.engine.threads}", prefs.engine.threads.toFloat(), 1f..4f, 2) {
        update(prefs.copy(engine = prefs.engine.copy(threads = it.roundToInt())))
    }
    Step("Память хеша · ${prefs.engine.hash} МБ", prefs.engine.hash.toFloat(), 8f..96f, 10) {
        update(prefs.copy(engine = prefs.engine.copy(hash = it.roundToInt())))
    }
    HorizontalDivider(color = Rule)
    Field("Цвет доски") { Chips(BoardTheme.entries, prefs.theme, { it.title }) { update(prefs.copy(theme = it)) } }
    Field("Фигуры") { Chips(PieceSet.entries, prefs.pieces, { it.title }) { update(prefs.copy(pieces = it)) } }
    Step("Непрозрачность окна · ${(prefs.opacity * 100).roundToInt()}%", prefs.opacity, .45f..1f) {
        update(prefs.copy(opacity = it))
    }
    Text("ChessMind 1.0 · Stockfish 17.1 · GPLv3", color = Muted, fontSize = 12.sp)
}

@Composable
internal fun Step(title: String, value: Float, range: ClosedFloatingPointRange<Float>, steps: Int = 0, update: (Float) -> Unit) {
    Field(title) { Slider(value, update, valueRange = range, steps = steps) }
}

@Composable
private fun HistoryPage(entries: List<Entry>, model: ChessViewModel) {
    PageTitle("История", if (entries.isEmpty()) "Завершённые и сохранённые партии появятся здесь." else null)
    val format = remember { DateFormat.getDateInstance(DateFormat.MEDIUM) }
    for (entry in entries) key(entry.id) {
        ActionRow(entry.name, "${format.format(Date(entry.time))} · Полуходов: ${entry.game.moves.size}") {
            model.openReplay(entry.game)
        }
    }
}
