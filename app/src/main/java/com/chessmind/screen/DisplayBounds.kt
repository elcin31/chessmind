package com.chessmind.screen

import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.view.WindowManager

internal fun WindowManager.displayBounds(maximum: Boolean = false): Rect {
    if (Build.VERSION.SDK_INT >= 30) {
        return (if (maximum) maximumWindowMetrics else currentWindowMetrics).bounds
    }
    val size = Point()
    @Suppress("DEPRECATION")
    defaultDisplay.getRealSize(size)
    return Rect(0, 0, size.x, size.y)
}
