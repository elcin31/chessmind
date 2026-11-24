package com.chessmind.screen

import com.chessmind.chess.Game
import com.chessmind.engine.EngineSettings
import kotlinx.coroutines.flow.MutableStateFlow
import java.security.SecureRandom

internal data class CaptureKey(val colors: List<Int>) {
    companion object {
        fun create(): CaptureKey {
            val random = SecureRandom()
            val bands = listOf(0xFF1661CC, 0xFFDC208A, 0xFF20BF59, 0xFFEA6520)
            return CaptureKey(bands.map { band ->
                (band.toInt() and 0xFFF0F0F0.toInt()) or
                    (random.nextInt(16) shl 16) or (random.nextInt(16) shl 8) or random.nextInt(16)
            })
        }
    }
}

internal data class TrainingSurface(
    val key: CaptureKey,
    val game: Game,
    val playerWhite: Boolean,
    val visible: Boolean,
    val theme: BoardTheme,
    val pieces: PieceSet,
    val settings: EngineSettings,
    val opacity: Float,
    val calibration: Calibration,
    val gameOver: Boolean,
)

internal object CaptureGate {
    val surface = MutableStateFlow<TrainingSurface?>(null)
    val running = MutableStateFlow(false)
    val status = MutableStateFlow("Экранный ассистент выключен")
}
