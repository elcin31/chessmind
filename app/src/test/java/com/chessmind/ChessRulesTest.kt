package com.chessmind

import com.chessmind.chess.Game
import com.chessmind.chess.Outcome
import com.chessmind.chess.Position
import com.chessmind.chess.squareIndex
import com.chessmind.engine.parseVariation
import org.junit.Assert.*
import org.junit.Test

class ChessRulesTest {
    @Test fun initialPerft() {
        val start = Position.initial()
        assertEquals(20L, perft(start, 1))
        assertEquals(400L, perft(start, 2))
        assertEquals(8_902L, perft(start, 3))
        assertEquals(197_281L, perft(start, 4))
    }

    @Test fun castlingAndPinnedPiecePerft() {
        val start = Position.parse("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
        assertEquals(48L, perft(start, 1))
        assertEquals(2_039L, perft(start, 2))
        assertEquals(97_862L, perft(start, 3))
    }

    @Test fun enPassantFenAndCapture() {
        var game = Game()
        for (move in listOf("e2e4", "a7a6", "e4e5", "d7d5")) game = game.addUci(move)!!
        assertEquals("rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3", game.position.fen)
        val next = game.addUci("e5d6")!!.position
        assertEquals('.', next.board[squareIndex("d5")!!])
        assertEquals('P', next.board[squareIndex("d6")!!])
        assertNull(next.enPassant)
        assertEquals(next.fen, Position.parse(next.fen).fen)
    }

    @Test fun enPassantExposingKingIsIllegal() {
        val position = Position.parse("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")
        assertNull(position.playUci("e5d6"))
    }

    @Test fun rookCaptureAndCastlingChangeRights() {
        val position = Position.parse("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        assertEquals("Kk", position.playUci("a1a8")!!.castling)
        val castle = position.playUci("e1c1")!!
        assertEquals("kq", castle.castling)
        assertEquals('R', castle.board[squareIndex("d1")!!])
        val throughCheck = Position.parse("r3kr1r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        assertNull(throughCheck.playUci("e1g1"))
    }

    @Test fun fourPromotionsAndSan() {
        val position = Position.parse("7k/P7/8/8/8/8/8/7K w - - 0 1")
        val moves = position.legalMoves().filter { it.from == 8 }
        assertEquals(setOf("a7a8q", "a7a8r", "a7a8b", "a7a8n"), moves.map { it.uci }.toSet())
        assertEquals("a8=Q+", position.san(moves.first { it.promotion == 'q' }))
    }

    @Test fun pgnCommentsVariationsResultsAndMate() {
        val pgn = """[Event "Test"]
            |
            |1. f3 {quiet} e5 (1... d5 (1... c5)) 2. g4?! Qh4# 0-1""".trimMargin()
        val game = Game.importPgn(pgn)
        assertEquals(listOf("f3", "e5", "g4", "Qh4#"), game.notation())
        assertEquals(Outcome.CHECKMATE, game.outcome)
        assertThrows(IllegalArgumentException::class.java) { Game.importPgn("1. e5") }
        assertThrows(IllegalArgumentException::class.java) { Game.importPgn("1. e4 * 1. d4 *") }
    }

    @Test fun repetitionAndDraws() {
        val game = Game.importPgn("1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8")
        assertEquals(Outcome.REPETITION, game.outcome)
        assertEquals(Outcome.STALEMATE, Game(Position.parse("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).outcome)
        assertEquals(Outcome.MATERIAL, Game(Position.parse("7k/8/8/8/8/8/2N5/7K w - - 0 1")).outcome)
        assertEquals(Outcome.FIFTY_MOVES, Game(Position.parse("7k/8/8/8/8/8/2R5/7K w - - 100 51")).outcome)
    }

    @Test fun invalidFenRejected() {
        val bad = listOf(
            "8/8/8/8/8/8/8/8 w - - 0 1",
            "7k/8/8/8/8/8/2R5/7K w K - 0 1",
            "7k/8/8/8/8/8/2R5/7K w - e6 0 1",
            "7k/8/8/8/8/8/8/4KP2 w - - 0 1",
            "4k3/4R3/8/8/8/8/8/7K w - - 0 1"
        )
        for (fen in bad) assertThrows(fen, IllegalArgumentException::class.java) { Position.parse(fen) }
    }

    @Test fun uciParsingAndBounds() {
        val line = parseVariation("info depth 18 seldepth 24 multipv 2 score cp -34 nodes 420 pv e2e4 e7e5")!!
        assertEquals(2, line.rank)
        assertEquals(-34, line.cp)
        assertEquals(listOf("e2e4", "e7e5"), line.moves)
        assertEquals(3, parseVariation("info depth 8 score mate 3 pv g7g8q")!!.mate)
        assertNull(parseVariation("info depth 8 score cp 8 lowerbound pv d2d4"))
    }

    private fun perft(position: Position, depth: Int): Long =
        if (depth == 0) 1 else position.legalMoves().sumOf { perft(position.advance(it), depth - 1) }
}
