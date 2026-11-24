package com.chessmind

import android.app.Application
import com.chessmind.engine.Stockfish

class ChessMindApp : Application() {
    val stockfish by lazy { Stockfish(this) }
}
