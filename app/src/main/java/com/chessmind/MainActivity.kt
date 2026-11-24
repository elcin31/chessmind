package com.chessmind

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import com.chessmind.screen.AssistantService
import com.chessmind.screen.CaptureGate
import com.chessmind.ui.ChessApp
import com.chessmind.ui.ChessViewModel

class MainActivity : ComponentActivity() {
    private val model by viewModels<ChessViewModel>()
    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val key = model.state.value.capture
        if (result.resultCode != Activity.RESULT_OK || data == null || key == null) {
            model.stopCapture("Захват экрана не разрешён")
        } else {
            val intent = Intent(this, AssistantService::class.java)
                .putExtra(AssistantService.DATA, data)
                .putExtra(AssistantService.RESULT, result.resultCode)
                .putExtra(AssistantService.KEY, key.colors.toIntArray())
            runCatching { startForegroundService(intent) }
                .onFailure { model.stopCapture("Android не запустил захват. Откройте тренировку и повторите.") }
        }
    }
    private val overlay = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (Settings.canDrawOverlays(this)) requestCapture()
        else model.stopCapture("Разрешите ChessMind показывать окно поверх других приложений")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ChessApp(model, ::requestAssistant, ::stopAssistant) }
    }

    override fun onResume() {
        super.onResume()
        model.activityResumed(true)
    }

    override fun onPause() {
        model.activityResumed(false)
        super.onPause()
    }

    override fun onStop() {
        if (CaptureGate.running.value) stopAssistant()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        model.activityFocused(hasFocus)
    }

    private fun requestAssistant() {
        if (Settings.canDrawOverlays(this)) {
            requestCapture()
        } else {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            runCatching { overlay.launch(intent) }
                .onFailure { model.stopCapture("Выдайте разрешение на плавающие окна в настройках Android") }
        }
    }

    private fun requestCapture() {
        model.armCapture() ?: return
        val manager = getSystemService(MediaProjectionManager::class.java)
        runCatching { capture.launch(manager.createScreenCaptureIntent()) }
            .onFailure { model.stopCapture("Системный диалог захвата недоступен") }
    }

    private fun stopAssistant() {
        model.stopCapture()
        stopService(Intent(this, AssistantService::class.java))
    }
}
