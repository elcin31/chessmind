package com.chessmind.screen

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt

internal class Overlay(context: Context, stop: () -> Unit) {
    private val manager = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private var attached = false
    private var collapsed = false
    private var expandedWidth = dp(268)
    private var expandedHeight = dp(175)

    private val params = WindowManager.LayoutParams(
        expandedWidth, expandedHeight, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "ChessMind"
        x = dp(14)
        y = dp(14)
    }

    private val root = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply {
            setColor(0xFF172437.toInt())
            cornerRadius = dp(14).toFloat()
            setStroke(dp(1), 0xFFC8A96B.toInt())
        }
        elevation = dp(8).toFloat()
        setPadding(dp(12), dp(6), dp(6), dp(6))
    }
    private val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
    private val title = TextView(context).apply {
        text = "CHESSMIND"
        setTextColor(0xFFC8A96B.toInt())
        textSize = 12f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER_VERTICAL
        contentDescription = "ChessMind. Переместить окно"
    }
    private val text = TextView(context).apply {
        setTextColor(0xFFF5F1E8.toInt())
        textSize = 14f
        setPadding(dp(2), dp(5), dp(6), 0)
    }
    private val resizeHandle = button(context, "↘", "Изменить размер", null)
    private val collapse = button(context, "−", "Свернуть") {
        collapsed = !collapsed
        text.visibility = if (collapsed) View.GONE else View.VISIBLE
        resizeHandle.visibility = text.visibility
        it.text = if (collapsed) "+" else "−"
        it.contentDescription = if (collapsed) "Развернуть" else "Свернуть"
        params.width = if (collapsed) dp(180) else expandedWidth
        params.height = if (collapsed) dp(52) else expandedHeight
        layout()
    }

    init {
        header.addView(title, LinearLayout.LayoutParams(0, dp(40), 1f))
        header.addView(collapse)
        header.addView(button(context, "×", "Остановить анализ") { stop() })
        root.addView(header)
        root.addView(text, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(context).apply {
            gravity = Gravity.END
            addView(resizeHandle)
        }
        root.addView(footer, LinearLayout.LayoutParams(-1, dp(30)))
        title.setOnTouchListener(gesture({ dx, dy, initialX, initialY ->
            params.x = initialX + dx
            params.y = initialY + dy
            layout()
        }, { params.x to params.y }))
        resizeHandle.setOnTouchListener(gesture({ dx, dy, initialWidth, initialHeight ->
            val bounds = manager.displayBounds()
            expandedWidth = (initialWidth + dx).coerceIn(dp(185), maxOf(dp(185), bounds.width()))
            expandedHeight = (initialHeight + dy).coerceIn(dp(145), maxOf(dp(145), bounds.height()))
            params.width = expandedWidth
            params.height = expandedHeight
            layout()
        }, { expandedWidth to expandedHeight }))
    }

    fun show(message: String, opacity: Float) {
        if (text.text.toString() != message) text.text = message
        val alpha = opacity.coerceIn(.45f, 1f)
        val changed = params.alpha != alpha
        params.alpha = alpha
        if (!attached) {
            constrain()
            manager.addView(root, params)
            attached = true
        } else if (changed) {
            layout()
        }
    }

    fun hide() {
        if (attached) {
            attached = false
            runCatching { manager.removeViewImmediate(root) }
        }
    }

    private fun constrain() {
        val bounds = manager.displayBounds()
        params.width = params.width.coerceAtMost(bounds.width())
        params.height = params.height.coerceAtMost(bounds.height())
        params.x = params.x.coerceIn(0, (bounds.width() - params.width).coerceAtLeast(0))
        params.y = params.y.coerceIn(0, (bounds.height() - params.height).coerceAtLeast(0))
    }

    private fun layout() {
        constrain()
        if (attached) manager.updateViewLayout(root, params)
    }

    private fun dp(value: Int) = (density * value).roundToInt()

    private fun button(context: Context, label: String, name: String, action: ((TextView) -> Unit)?) =
        TextView(context).apply {
            text = label
            textSize = 22f
            setTextColor(Color.rgb(245, 241, 232))
            contentDescription = name
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(43), dp(40))
            if (action != null) setOnClickListener { action(this) }
        }

    private fun gesture(move: (Int, Int, Int, Int) -> Unit, initial: () -> Pair<Int, Int>): View.OnTouchListener {
        var x = 0f
        var y = 0f
        var base = 0 to 0
        return View.OnTouchListener { view, motion ->
            when (motion.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    x = motion.rawX
                    y = motion.rawY
                    base = initial()
                }
                MotionEvent.ACTION_MOVE -> move((motion.rawX - x).toInt(), (motion.rawY - y).toInt(), base.first, base.second)
                MotionEvent.ACTION_UP -> view.performClick()
            }
            true
        }
    }
}
