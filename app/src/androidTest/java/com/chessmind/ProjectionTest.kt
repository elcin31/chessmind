package com.chessmind

import android.app.UiAutomation
import android.content.Intent
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.chessmind.screen.CaptureGate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProjectionTest {
    @Test fun consentRecommendationAndLeavingTraining() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("projection") == "true")
        val runner = InstrumentationRegistry.getInstrumentation()
        val ui = runner.uiAutomation
        val app = runner.targetContext
        val original = Regex("SYSTEM_ALERT_WINDOW: (\\w+)")
            .find(shell(ui, "appops get com.chessmind SYSTEM_ALERT_WINDOW"))?.groupValues?.get(1) ?: "default"
        shell(ui, "appops set com.chessmind SYSTEM_ALERT_WINDOW allow")
        assertTrue(Settings.canDrawOverlays(app))
        val activity = runner.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            select(ui, "Ассистент")
            select(ui, "Открыть доску ассистента")
            select(ui, "Включить захват экрана")
            select(ui, "Cancel")
            await("отказ в доступе") { CaptureGate.status.value.contains("не разрешён") }
            assertFalse(CaptureGate.running.value)

            select(ui, "Включить захват экрана")
            val shareMode = awaitNode(ui, "A single app", "Share one app", "One app", "A single application",
                "Entire screen", "Share entire screen")
            if (!label(shareMode).contains("entire screen", ignoreCase = true)) {
                press(ui, shareMode)
                select(ui, "Entire screen", "Share entire screen")
            }
            select(ui, "Start now", "Start", "Start recording", "Share")
            await("первая подсказка", 25_000) {
                CaptureGate.running.value && CaptureGate.status.value.startsWith("Лучший ход")
            }
            select(ui, "e2, Пешка")
            select(ui, "e4, Пусто")
            await("ход бота и обновление подсказки", 25_000) {
                CaptureGate.surface.value?.let { it.game.moves.size >= 2 && CaptureGate.status.value.startsWith("Лучший ход") } == true
            }
            shell(ui, "input keyevent KEYCODE_HOME")
            await("отзыв захвата при уходе с тренировки") { !CaptureGate.running.value && CaptureGate.surface.value == null }
        } finally {
            runner.runOnMainSync { activity.finish() }
            shell(ui, "appops set com.chessmind SYSTEM_ALERT_WINDOW $original")
        }
    }

    private fun select(ui: UiAutomation, vararg names: String) = press(ui, awaitNode(ui, *names))

    private fun press(ui: UiAutomation, node: AccessibilityNodeInfo) {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        shell(ui, "input tap ${bounds.centerX()} ${bounds.centerY()}")
    }

    private fun awaitNode(ui: UiAutomation, vararg names: String): AccessibilityNodeInfo {
        var matching: AccessibilityNodeInfo? = null
        var latest = emptyList<AccessibilityNodeInfo>()
        try {
            await(names.joinToString(" / ")) {
                latest = ui.rootInActiveWindow?.let { tree(it).toList() }.orEmpty()
                matching = latest.firstOrNull { node ->
                    node.isVisibleToUser && names.any { name ->
                        val value = label(node)
                        value.equals(name, true) || (name.contains(',') && value.startsWith(name, true))
                    }
                }
                matching != null
            }
        } catch (failure: AssertionError) {
            throw AssertionError("Нет элемента ${names.joinToString()} рядом с: " +
                latest.map(::label).filter { it.isNotBlank() }.distinct().joinToString(), failure)
        }
        return checkNotNull(matching)
    }

    private fun tree(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        yield(node)
        for (index in 0 until node.childCount) node.getChild(index)?.let { yieldAll(tree(it)) }
    }

    private fun label(node: AccessibilityNodeInfo): String = (node.text ?: node.contentDescription).orEmpty().toString()

    private fun await(description: String, timeout: Long = 10_000, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeout
        do {
            if (condition()) return
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < until)
        throw AssertionError("$description; статус ассистента: ${CaptureGate.status.value}")
    }

    private fun shell(ui: UiAutomation, command: String) =
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(command)).bufferedReader().use { it.readText() }
}
