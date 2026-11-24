package com.chessmind.chess

enum class Outcome { CHECKMATE, STALEMATE, MATERIAL, FIFTY_MOVES, REPETITION }

data class Game(val start: Position = Position.initial(), val moves: List<Move> = emptyList(), val positions: List<Position> = listOf(start)) {
    val position: Position get() = positions.last()
    val outcome: Outcome? get() {
        if (position.legalMoves().isEmpty()) return if (position.isCheck) Outcome.CHECKMATE else Outcome.STALEMATE
        if (position.insufficientMaterial) return Outcome.MATERIAL
        if (position.halfMove >= 100) return Outcome.FIFTY_MOVES
        val key = position.repetitionKey
        return if (positions.count { it.repetitionKey == key } >= 3) Outcome.REPETITION else null
    }

    fun add(move: Move): Game? = position.play(move)?.let { copy(moves = moves + move, positions = positions + it) }

    fun addUci(uci: String): Game? =
        position.legalMoves().firstOrNull { it.uci == uci }?.let { move ->
            copy(moves = moves + move, positions = positions + position.advance(move))
        }

    fun through(ply: Int): Game = copy(moves = moves.take(ply), positions = positions.take(ply + 1))

    fun notation(): List<String> = moves.mapIndexed { index, move -> positions[index].san(move) }

    companion object {
        fun importPgn(pgn: String): Game {
            require(pgn.length <= 150_000) { "PGN превышает 150 000 символов" }
            val tags = Regex("""(?m)^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\\r\n])*)"\s*]\s*$""")
            val setup = tags.findAll(pgn).firstOrNull { it.groupValues[1] == "FEN" }?.groupValues?.get(2)
            var game = Game(setup?.let(Position::parse) ?: Position.initial())
            val mainline = buildString {
                var variations = 0
                var comment = false
                var lineComment = false
                for (char in tags.replace(pgn, "")) {
                    when {
                        lineComment -> if (char == '\n') { lineComment = false; append(' ') }
                        comment -> if (char == '}') { comment = false; append(' ') }
                        char == '{' -> comment = true
                        char == ';' -> lineComment = true
                        char == '(' -> variations++
                        char == ')' -> {
                            require(variations > 0) { "Непарная скобка PGN" }
                            variations--
                            append(' ')
                        }
                        variations == 0 -> append(char)
                    }
                }
                require(variations == 0 && !comment) { "Незакрытый комментарий или вариант PGN" }
            }
            val tokens = mainline.replace(Regex("""\d+\.{1,3}|\$\d+"""), " ").split(Regex("""\s+"""))
            var ended = false
            for (token in tokens) {
                if (token.isBlank()) continue
                require(!ended) { "Импортируйте одну партию за раз" }
                if (token in listOf("1-0", "0-1", "1/2-1/2", "*")) { ended = true; continue }
                val normalized = token.replace('0', 'O').trimEnd('!', '?', '+', '#')
                val legal = game.position.legalMoves()
                val move = legal.singleOrNull {
                    it.uci == token || game.position.san(it, legal).trimEnd('+', '#') == normalized
                } ?: throw IllegalArgumentException("Неверный ход PGN: $token")
                require(game.moves.size < 600) { "Поддерживается до 600 полуходов" }
                game = checkNotNull(game.add(move))
            }
            require(game.moves.isNotEmpty() || setup != null) { "В PGN нет ходов или начальной позиции" }
            return game
        }
    }
}
