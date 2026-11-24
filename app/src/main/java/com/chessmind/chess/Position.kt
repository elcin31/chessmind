package com.chessmind.chess

private const val START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
private const val PIECES = "PNBRQKpnbrqk"
private const val RIGHTS = "KQkq"
private val knights = listOf(-2 to -1, -2 to 1, -1 to -2, -1 to 2, 1 to -2, 1 to 2, 2 to -1, 2 to 1)
private val diagonals = listOf(-1 to -1, -1 to 1, 1 to -1, 1 to 1)
private val lines = listOf(-1 to 0, 1 to 0, 0 to -1, 0 to 1)
private val adjacent = diagonals + lines
private val empties = Regex("\\.+")

fun squareName(index: Int): String = "${'a' + index % 8}${8 - index / 8}"

fun squareIndex(name: String): Int? =
    if (name.length == 2 && name[0] in 'a'..'h' && name[1] in '1'..'8')
        (8 - name[1].digitToInt()) * 8 + (name[0] - 'a')
    else null

fun placement(board: String): String = board.chunked(8).joinToString("/") { rank ->
    empties.replace(rank) { it.value.length.toString() }
}

data class Move(val from: Int, val to: Int, val promotion: Char? = null) {
    val uci: String get() = squareName(from) + squareName(to) + (promotion?.toString() ?: "")
}

class Position private constructor(
    val board: String,
    val whiteToMove: Boolean,
    val castling: String,
    val enPassant: Int?,
    val halfMove: Int,
    val fullMove: Int,
) {
    val fen: String get() = "${placement(board)} ${if (whiteToMove) "w" else "b"} " +
        "${castling.ifEmpty { "-" }} ${enPassant?.let(::squareName) ?: "-"} $halfMove $fullMove"

    val repetitionKey: String get() {
        val target = enPassant?.takeIf { square ->
            legalMoves().any { it.to == square && board[it.from].lowercaseChar() == 'p' }
        }
        return "$board:$whiteToMove:$castling:$target"
    }

    val isCheck: Boolean get() = kingAttacked(whiteToMove)

    val insufficientMaterial: Boolean get() {
        val extras = board.indices.filter { board[it] !in ".kK" }
        return extras.isEmpty() ||
            (extras.size == 1 && board[extras.single()].lowercaseChar() in "bn") ||
            (extras.all { board[it].lowercaseChar() == 'b' } && extras.map { (it / 8 + it % 8) % 2 }.distinct().size == 1)
    }

    fun legalMoves(): List<Move> = pseudoMoves().filter { !advance(it).kingAttacked(whiteToMove) }

    fun play(move: Move): Position? = if (move in legalMoves()) advance(move) else null

    fun playUci(uci: String): Position? = legalMoves().firstOrNull { it.uci == uci }?.let(::advance)

    internal fun advance(move: Move): Position {
        val next = board.toCharArray()
        val piece = next[move.from]
        val pawn = piece.equals('p', true)
        val king = piece.equals('k', true)
        val capture = next[move.to] != '.' || (pawn && move.to == enPassant)
        next[move.from] = '.'
        if (pawn && move.to == enPassant) next[move.to + if (whiteToMove) 8 else -8] = '.'
        next[move.to] = move.promotion?.let { if (whiteToMove) it.uppercaseChar() else it } ?: piece
        if (king && kotlin.math.abs(move.from - move.to) == 2) {
            val kingSide = move.to > move.from
            val rookFrom = if (kingSide) move.from + 3 else move.from - 4
            val rookTo = if (kingSide) move.from + 1 else move.from - 1
            next[rookTo] = next[rookFrom]
            next[rookFrom] = '.'
        }
        val rights = castling.filter { right ->
            val rook = when (right) { 'K' -> 63; 'Q' -> 56; 'k' -> 7; else -> 0 }
            !(king && right.isUpperCase() == whiteToMove) && rook != move.from && rook != move.to
        }
        val target = if (pawn && kotlin.math.abs(move.from - move.to) == 16) (move.from + move.to) / 2 else null
        return Position(next.concatToString(), !whiteToMove, rights, target,
            if (pawn || capture) 0 else halfMove + 1, if (whiteToMove) fullMove else fullMove + 1)
    }

    fun san(move: Move): String = san(move, legalMoves())

    internal fun san(move: Move, candidates: List<Move>): String {
        val piece = board[move.from].uppercaseChar()
        val name = squareName(move.from)
        val capture = board[move.to] != '.' || (piece == 'P' && move.to == enPassant)
        val notation = when {
            piece == 'K' && move.to == move.from + 2 -> "O-O"
            piece == 'K' && move.to == move.from - 2 -> "O-O-O"
            else -> buildString {
                if (piece == 'P') {
                    if (capture) append(name[0])
                } else {
                    append(piece)
                    val rivals = candidates.filter { it != move && it.to == move.to && board[it.from] == board[move.from] }
                    if (rivals.isNotEmpty()) {
                        if (rivals.none { it.from % 8 == move.from % 8 }) append(name[0])
                        else if (rivals.none { it.from / 8 == move.from / 8 }) append(name[1])
                        else append(name)
                    }
                }
                if (capture) append('x')
                append(squareName(move.to))
                move.promotion?.let { append('='); append(it.uppercaseChar()) }
            }
        }
        val result = advance(move)
        if (!result.isCheck) return notation
        return notation + if (result.legalMoves().isEmpty()) "#" else "+"
    }

    private fun kingAttacked(white: Boolean): Boolean = attacked(board.indexOf(if (white) 'K' else 'k'), !white)

    private fun attacked(square: Int, byWhite: Boolean): Boolean {
        fun isPiece(index: Int?, black: Char) = index != null &&
            board[index] == if (byWhite) black.uppercaseChar() else black
        val pawnRow = if (byWhite) 1 else -1
        if (isPiece(offset(square, pawnRow, -1), 'p') || isPiece(offset(square, pawnRow, 1), 'p')) return true
        if (knights.any { (row, file) -> isPiece(offset(square, row, file), 'n') }) return true
        for ((row, file) in adjacent) {
            var current = offset(square, row, file)
            if (isPiece(current, 'k')) return true
            val slider = if (row != 0 && file != 0) 'b' else 'r'
            while (current != null) {
                if (board[current] != '.') {
                    if (isPiece(current, slider) || isPiece(current, 'q')) return true
                    break
                }
                current = offset(current, row, file)
            }
        }
        return false
    }

    private fun pseudoMoves(): List<Move> = buildList {
        for (from in board.indices) {
            val piece = board[from]
            if (piece == '.' || piece.isUpperCase() != whiteToMove) continue
            when (piece.lowercaseChar()) {
                'p' -> addPawnMoves(from, this)
                'n' -> addSteps(from, knights, false, this)
                'b' -> addSteps(from, diagonals, true, this)
                'r' -> addSteps(from, lines, true, this)
                'q' -> addSteps(from, adjacent, true, this)
                'k' -> {
                    addSteps(from, adjacent, false, this)
                    if (from == (if (whiteToMove) 60 else 4) && !attacked(from, !whiteToMove)) {
                        if ((if (whiteToMove) 'K' else 'k') in castling && board[from + 1] == '.' &&
                            board[from + 2] == '.' && !attacked(from + 1, !whiteToMove)
                        ) add(Move(from, from + 2))
                        if ((if (whiteToMove) 'Q' else 'q') in castling && board[from - 1] == '.' &&
                            board[from - 2] == '.' && board[from - 3] == '.' && !attacked(from - 1, !whiteToMove)
                        ) add(Move(from, from - 2))
                    }
                }
            }
        }
    }

    private fun addPawnMoves(from: Int, moves: MutableList<Move>) {
        val direction = if (whiteToMove) -1 else 1
        fun add(to: Int) {
            if (to / 8 == 0 || to / 8 == 7) "qrbn".forEach { moves.add(Move(from, to, it)) }
            else moves.add(Move(from, to))
        }
        val one = offset(from, direction, 0)
        if (one != null && board[one] == '.') {
            add(one)
            val home = if (whiteToMove) 6 else 1
            if (from / 8 == home && board[from + direction * 16] == '.') add(from + direction * 16)
        }
        for (file in listOf(-1, 1)) {
            val to = offset(from, direction, file) ?: continue
            if (to == enPassant || captures(to)) add(to)
        }
    }

    private fun addSteps(from: Int, steps: List<Pair<Int, Int>>, sliding: Boolean, moves: MutableList<Move>) {
        for ((row, file) in steps) {
            var to = offset(from, row, file)
            while (to != null) {
                if (board[to] == '.' || captures(to)) moves.add(Move(from, to))
                if (!sliding || board[to] != '.') break
                to = offset(to, row, file)
            }
        }
    }

    private fun captures(to: Int): Boolean {
        val piece = board[to]
        return piece != '.' && piece.lowercaseChar() != 'k' && piece.isUpperCase() != whiteToMove
    }

    companion object {
        fun initial(): Position = parse(START)

        fun parse(fen: String): Position {
            val fields = fen.trim().split(Regex("\\s+"))
            require(fields.size == 6) { "FEN должен содержать шесть полей" }
            val rows = fields[0].split('/')
            require(rows.size == 8) { "В FEN должно быть восемь рядов" }
            val board = rows.joinToString("") { row ->
                buildString {
                    for (symbol in row) when (symbol) {
                        in PIECES -> append(symbol)
                        in '1'..'8' -> repeat(symbol.digitToInt()) { append('.') }
                        else -> throw IllegalArgumentException("Неизвестный символ позиции")
                    }
                    require(length == 8) { "В ряду должно быть восемь клеток" }
                }
            }
            require(fields[1] in listOf("w", "b")) { "Укажите очередь хода" }
            val white = fields[1] == "w"
            val rights = fields[2].takeUnless { it == "-" } ?: ""
            require(rights.all { it in RIGHTS } && rights.toSet().size == rights.length) { "Неверные права рокировки" }
            val target = fields[3].takeUnless { it == "-" }?.let {
                squareIndex(it) ?: throw IllegalArgumentException("Неверная клетка взятия на проходе")
            }
            val half = fields[4].toIntOrNull()
            val full = fields[5].toIntOrNull()
            require(half != null && half in 0..100_000 && full != null && full in 1..100_000) { "Неверные счётчики ходов" }
            require(board.count { it == 'K' } == 1 && board.count { it == 'k' } == 1) { "Требуется ровно один король каждого цвета" }
            require(board.take(8).none { it.equals('p', true) } && board.takeLast(8).none { it.equals('p', true) }) {
                "Пешка не может стоять на первой или восьмой горизонтали"
            }
            for (side in listOf(true, false)) {
                val pieces = board.filter { it != '.' && it.isUpperCase() == side }.lowercase()
                val pawns = pieces.count { it == 'p' }
                val promotions = listOf('q' to 1, 'r' to 2, 'b' to 2, 'n' to 2).sumOf { (piece, initial) ->
                    (pieces.count { it == piece } - initial).coerceAtLeast(0)
                }
                require(pieces.length <= 16 && pawns + promotions <= 8) { "Невозможное число фигур" }
            }
            for ((right, king, rook) in listOf(Triple('K', 60, 63), Triple('Q', 60, 56), Triple('k', 4, 7), Triple('q', 4, 0))) {
                if (right in rights) {
                    val pieces = if (right.isUpperCase()) "KR" else "kr"
                    require(board[king] == pieces[0] && board[rook] == pieces[1]) { "Нет короля или ладьи для рокировки" }
                }
            }
            if (target != null) {
                val direction = if (white) 8 else -8
                require(target / 8 == (if (white) 2 else 5) && board[target] == '.' &&
                    board[target + direction] == (if (white) 'p' else 'P') && board[target - direction] == '.' && half == 0
                ) { "Клетка взятия на проходе несовместима с последним ходом" }
            }
            val result = Position(board, white, RIGHTS.filter { it in rights }, target, half, full)
            require(!result.kingAttacked(!white)) { "Король стороны, сделавшей последний ход, под шахом" }
            return result
        }
    }
}

private fun offset(from: Int, row: Int, file: Int): Int? {
    val r = from / 8 + row
    val f = from % 8 + file
    return if (r in 0..7 && f in 0..7) 8 * r + f else null
}
