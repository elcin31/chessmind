package com.chessmind.screen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import com.chessmind.ChessMindApp
import com.chessmind.R
import com.chessmind.chess.Game
import com.chessmind.engine.moveDescription
import com.chessmind.engine.sanLine
import com.chessmind.engine.scoreText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

class AssistantService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var frameThread: HandlerThread
    private lateinit var frames: Handler
    private lateinit var power: PowerManager
    private var overlay: Overlay? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var search: Job? = null
    private var key: CaptureKey? = null
    private var attemptedFen: String? = null
    private var cached: Pair<String, String>? = null
    private var contentVisible = true
    private var stopping = false
    private var accepted: Accepted? = null

    // Only the frame thread accesses the following fields.
    private val recognizer = Recognizer()
    private var tracker: PositionTracker? = null
    private var trackerKey: CaptureKey? = null
    private var lastFrameAt = 0L
    private var lastEpoch: TrainingSurface? = null

    private data class Accepted(val surface: TrainingSurface, val game: Game)

    private val callbacks = object : MediaProjection.Callback() {
        override fun onStop() {
            finish("Доступ к экрану завершён")
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            if (!stopping && display != null) {
                runCatching { resize(width, height) }.onFailure { finish("Область захвата недоступна") }
            }
        }

        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            contentVisible = isVisible
            if (!isVisible) suspendOutput("Окно тренировки скрыто", hide = true)
        }
    }

    private val thermalListener = PowerManager.OnThermalStatusChangedListener { status ->
        if (status >= PowerManager.THERMAL_STATUS_CRITICAL) {
            suspendOutput("Пауза из-за нагрева устройства")
        }
    }

    override fun onCreate() {
        super.onCreate()
        power = getSystemService(PowerManager::class.java)
        power.addThermalStatusListener(mainExecutor, thermalListener)
        frameThread = HandlerThread("ChessMind кадры").apply { start() }
        frames = Handler(frameThread.looper)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            finish("Экранный ассистент выключен")
            return START_NOT_STICKY
        }
        if (projection != null) return START_NOT_STICKY
        val surface = CaptureGate.surface.value
        val supplied = intent?.getIntArrayExtra(KEY)?.toList()
        val result = intent?.getIntExtra(RESULT, 0) ?: 0
        val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(DATA, Intent::class.java)
            else @Suppress("DEPRECATION") intent?.getParcelableExtra<Intent>(DATA)
        if (surface == null || supplied != surface.key.colors || data == null || !Settings.canDrawOverlays(this)) {
            finish("Для запуска откройте тренировку и разрешите плавающее окно")
            return START_NOT_STICKY
        }
        key = surface.key
        runCatching {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            val manager = getSystemService(MediaProjectionManager::class.java)
            val capture = checkNotNull(manager.getMediaProjection(result, data))
            projection = capture
            capture.registerCallback(callbacks, main)
            val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            resize(bounds.width(), bounds.height())
            overlay = Overlay(this) { finish("Экранный ассистент выключен") }
            CaptureGate.running.value = true
            CaptureGate.status.value = "Поиск доски…"
            scope.launch {
                CaptureGate.surface.collect { active ->
                    when {
                        active == null || active.key != key -> finish("Тренировочная сессия завершена")
                        !active.visible -> suspendOutput("Ожидание активного окна тренировки", hide = true)
                        active.gameOver -> suspendOutput("Партия завершена")
                        active.game.position.whiteToMove != active.playerWhite -> suspendOutput("Ход Stockfish")
                        accepted?.surface?.let { it != active } == true -> suspendOutput("Проверяю позицию…")
                    }
                }
            }
        }.onFailure { finish("Не удалось запустить захват: ${it.localizedMessage.orEmpty()}") }
        return START_NOT_STICKY
    }

    private fun resize(width: Int, height: Int) {
        require(width > 0 && height > 0)
        val scale = minOf(1f, 900f / maxOf(width, height))
        val w = (width * scale).roundToInt().coerceAtLeast(1)
        val h = (height * scale).roundToInt().coerceAtLeast(1)
        if (reader?.width == w && reader?.height == h) return
        val density = resources.displayMetrics.densityDpi
        val next = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        next.setOnImageAvailableListener(::readFrame, frames)
        try {
            val existing = display
            if (existing == null) {
                display = checkNotNull(projection?.createVirtualDisplay(
                    "ChessMind Training", w, h, density, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    next.surface, null, main
                ))
            } else {
                existing.resize(w, h, density)
                existing.surface = next.surface
            }
        } catch (failure: Exception) {
            next.close()
            throw failure
        }
        val old = reader
        reader = next
        if (old != null) frames.post { old.close() }
    }

    private fun readFrame(source: ImageReader) {
        val surface = CaptureGate.surface.value
        val thermal = power.currentThermalStatus
        val save = thermal >= PowerManager.THERMAL_STATUS_MODERATE || power.isPowerSaveMode
        val interval = if (save) 430L else 180L
        val now = SystemClock.elapsedRealtime()
        if (surface != null && surface.visible && lastEpoch == surface && now - lastFrameAt < interval) {
            frames.removeCallbacksAndMessages(delayedFrame)
            frames.postAtTime({ readFrame(source) }, delayedFrame, SystemClock.uptimeMillis() + interval - (now - lastFrameAt))
            return
        }
        val image = runCatching { source.acquireLatestImage() }.getOrNull() ?: return
        image.use {
            if (surface == null || !surface.visible || surface.gameOver || thermal >= PowerManager.THERMAL_STATUS_CRITICAL) return
            lastEpoch = surface
            lastFrameAt = now
            val localKey = surface.key
            if (trackerKey != localKey) {
                trackerKey = localKey
                tracker = PositionTracker(surface.game)
            }
            val observed = recognizer.read(
                ImageFrame(image), localKey.colors, surface.theme, surface.pieces, surface.calibration, save
            )
            val current = tracker
            val game = observed?.let { current?.update(it, surface.game) }
            main.post { acceptFrame(surface, game) }
        }
    }

    private fun acceptFrame(surface: TrainingSurface, game: Game?) {
        if (stopping || !contentVisible || !isCurrent(surface)) return
        if (game == null) {
            suspendOutput("Пауза · доска не подтверждена")
            return
        }
        if (game.position.whiteToMove != surface.playerWhite) return
        accepted = Accepted(surface, game)
        val fen = game.position.fen
        cached?.takeIf { it.first == fen }?.let {
            show(it.second, surface)
            return
        }
        if (attemptedFen == fen) return
        search?.cancel()
        attemptedFen = fen
        show("Stockfish считает…", surface)
        search = scope.launch {
            try {
                val analysis = (application as ChessMindApp).stockfish.analyze(game, surface.settings)
                if (!isCurrent(surface) || accepted?.game?.position?.fen != fen || !contentVisible) return@launch
                val best = analysis.best ?: return@launch show("Нет доступных ходов", surface)
                val bestSan = sanLine(game.position, listOf(best))
                val bestLine = analysis.variations.firstOrNull { it.moves.firstOrNull() == best }
                val alternatives = analysis.variations.filter { it.moves.firstOrNull() != best }
                    .map { sanLine(game.position, it.moves, 1) }.filter { it.isNotEmpty() }
                val result = buildString {
                    append("Лучший ход  $bestSan\n")
                    append(moveDescription(game.position, best))
                    append("\nОценка  ${scoreText(bestLine, game.position.whiteToMove)}")
                    if (alternatives.isNotEmpty()) append("\nЕщё  ${alternatives.joinToString(", ")}")
                }
                cached = fen to result
                show(result, surface)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (isCurrent(surface)) show(failure.message ?: "Stockfish недоступен", surface)
            }
        }
    }

    private fun isCurrent(surface: TrainingSurface): Boolean =
        surface.key == key && surface.visible && !surface.gameOver && CaptureGate.surface.value == surface

    private fun suspendOutput(message: String, hide: Boolean = false) {
        search?.cancel()
        search = null
        attemptedFen = null
        accepted = null
        CaptureGate.status.value = message
        val active = CaptureGate.surface.value
        if (hide || active == null || !active.visible || active.key != key) overlay?.hide()
        else show(message, active)
    }

    private fun show(message: String, surface: TrainingSurface) {
        CaptureGate.status.value = message
        if (Settings.canDrawOverlays(this)) {
            runCatching { overlay?.show(message, surface.opacity) }.onFailure { finish("Плавающее окно недоступно") }
        } else {
            finish("Разрешение плавающего окна отозвано")
        }
    }

    private fun notification(): Notification {
        val channel = NotificationChannel(CHANNEL, "Экранный ассистент", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        val stop = PendingIntent.getService(this, 0, Intent(this, AssistantService::class.java).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_chessmind)
            .setContentTitle("ChessMind")
            .setContentText("Захват локальной тренировки")
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Остановить", stop).build())
            .build()
    }

    private fun finish(message: String) {
        if (stopping) return
        stopping = true
        CaptureGate.status.value = message
        overlay?.hide()
        stopSelf()
    }

    override fun onDestroy() {
        stopping = true
        scope.cancel()
        overlay?.hide()
        power.removeThermalStatusListener(thermalListener)
        projection?.unregisterCallback(callbacks)
        display?.release()
        reader?.let { source ->
            frames.removeCallbacksAndMessages(delayedFrame)
            frames.post { source.close() }
        }
        frameThread.quitSafely()
        projection?.stop()
        CaptureGate.running.value = false
        super.onDestroy()
    }

    private class ImageFrame(image: Image) : RgbFrame {
        override val width = image.width
        override val height = image.height
        private val plane = image.planes[0]
        private val bytes = plane.buffer
        private val rowStride = plane.rowStride
        private val pixelStride = plane.pixelStride
        override fun pixel(x: Int, y: Int): Int {
            val index = y * rowStride + x * pixelStride
            return ((bytes.get(index).toInt() and 255) shl 16) or
                ((bytes.get(index + 1).toInt() and 255) shl 8) or (bytes.get(index + 2).toInt() and 255)
        }
    }

    private val delayedFrame = Any()

    companion object {
        const val DATA = "projectionData"
        const val RESULT = "projectionResult"
        const val KEY = "trainingKey"
        private const val CHANNEL = "chessmind.screen"
        private const val STOP = "com.chessmind.STOP"
        private const val NOTIFICATION_ID = 15
    }
}
