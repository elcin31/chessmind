import { Chess, type Color, type Move } from 'chess.js'
import type { ComputeEngine, ComputeSource, Energy } from './cloudProtocol.js'
import type { Draft } from './progressive.js'
import type { Review } from './review.js'
import { drawState } from './rules.js'

export type Source = 'chesscom' | 'lichess' | 'pgn'
export type Opening = [eco: string, name: string, pgn: string]
export type LegacyMode = 'lite' | 'quick' | 'standard' | 'deep' | 'professional'
export type ReviewMode = 'smart' | 'deep-review'
export type Mode = LegacyMode | ReviewMode
export type Methodology = 1 | 2 | 3
export const reviewModes = { smart: 'Обычный', 'deep-review': 'Глубокий' } as const
export const reviewMode = (mode?: Mode): ReviewMode =>
  mode === 'deep' || mode === 'professional' || mode === 'deep-review' ? 'deep-review' : 'smart'
export const adaptiveMode = (mode?: Mode): mode is ReviewMode => mode === 'smart' || mode === 'deep-review'
export type EngineOptions = { multiplier?: number; full?: boolean; threads?: 1 | 2; hash?: 16 | 32 | 64; cache?: number; workers?: 1 | 2 | 3 | 4; energy?: Energy }
export type Analysis = { mode: Mode; compute?: ComputeEngine; methodology?: Methodology; options?: EngineOptions; reviews: Review[] }
export const methodologyVersion = 3
export const cloudEngine = 'stockfish-19.0.1-lite-single' as const
export const analysisKey = (game: Pick<Game, 'methodology' | 'mode' | 'options' | 'compute'>) =>
  [game.methodology ?? 1, game.mode ?? 'standard',
    ...(game.mode === 'lite' ? ['lite', 1, 1, 16] : [
      game.options?.full ? 'full' : 'lite', game.mode === 'smart' ? 1 : game.options?.multiplier ?? 1, game.options?.threads ?? 'auto', game.options?.hash ?? 'auto',
    ]),
    ...(game.compute === 'cloud' ? ['cloud', cloudEngine] : adaptiveMode(game.mode) ? ['local', 'stockfish-19.0.1', game.options?.energy ?? 'balanced', game.options?.workers ?? 'auto'] : [])].join(':')
export type Game = {
  id: string; pgn: string; initial: string; source: Source; url?: string; owner?: string;
  white: string; black: string; whiteElo?: number; blackElo?: number;
  date: string; timestamp?: number; result: string; time: string; opening?: Opening; book: number;
  moves: number; mode?: Mode; reviews?: Review[]; queued?: boolean; queuedAt?: number; methodology?: Methodology; options?: EngineOptions; savedAnalyses?: Analysis[]; savedDrafts?: Record<string, Draft>; draft?: Draft; cloudDraft?: Draft; cloudCacheHit?: boolean; localElapsedMs?: number; queueSource?: ComputeSource; compute?: ComputeEngine; autoPreviewPaused?: boolean; loadPaused?: boolean
}
export const uci = (move: Move) => move.from + move.to + (move.promotion ?? '')
export const fenKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')
export const playUci = (chess: Chess, move: string) => chess.move({
  from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.slice(4, 5) || undefined,
})
const moveCache = new Map<string, { pgn: string; moves: Move[] }>()
export function gameMoves(game: Game) {
  const cached = moveCache.get(game.id)
  if (cached?.pgn === game.pgn) return cached.moves
  const chess = new Chess()
  chess.loadPgn(game.pgn)
  const moves = chess.history({ verbose: true })
  moveCache.set(game.id, { pgn: game.pgn, moves })
  if (moveCache.size > 150) moveCache.delete(moveCache.keys().next().value!)
  return moves
}
export const playerColor = (game: Game, nickname?: string): Color | undefined => {
  const name = (game.owner || nickname)?.toLowerCase()
  if (name === game.white.toLowerCase()) return 'w'
  if (name === game.black.toLowerCase()) return 'b'
}
export const isComplete = (game: Game) => !!game.reviews && game.reviews.length === game.moves
export const displayDate = (date: string) => date ? new Date(date + 'T12:00:00').toLocaleDateString('ru-RU') : 'Дата неизвестна'

export async function readGame(pgn: string, loadBook: () => Promise<Record<string, true | Opening>>,
  source: Source = 'pgn', owner?: string, url?: string, legacy = false): Promise<Game> {
  const chess = new Chess()
  chess.loadPgn(pgn)
  const headers = chess.getHeaders()
  const variant = headers.Variant?.toLowerCase()
  if (variant && !['standard', 'chess', 'from position'].includes(variant)) throw new Error('Поддерживаются стандартные шахматы.')
  const result = headers.Result
  const textResult = pgn.replace(/\{[^}]*\}|;[^\n]*/g, '').trim().match(/(?:^|\s)(1-0|0-1|1\/2-1\/2|\*)$/)?.[1]
  if (!['1-0', '0-1', '1/2-1/2'].includes(result) || textResult !== result) {
    throw new Error('PGN должен содержать итог завершённой партии (1-0, 0-1 или 1/2-1/2).')
  }
  const history = chess.history({ verbose: true })
  if (!history.length) throw new Error('В партии нет ходов.')
  if (chess.isCheckmate() && result !== (chess.turn() === 'w' ? '0-1' : '1-0')) throw new Error('Результат PGN противоречит мату на доске.')
  if ((chess.isStalemate() || chess.isInsufficientMaterial()) && result !== '1/2-1/2') throw new Error('Результат PGN противоречит ничейной позиции.')
  const repetitions = new Map<string, number>()
  for (const [index, fen] of [history[0].before, ...history.map(move => move.after)].entries()) {
    const key = fenKey(fen)
    const count = (repetitions.get(key) ?? 0) + 1
    repetitions.set(key, count)
    if (!legacy && drawState(new Chess(fen), count)?.automatic && (index < history.length || result !== '1/2-1/2')) {
      throw new Error('PGN противоречит правилу автоматической ничьей.')
    }
  }
  const openingBook = await loadBook()
  let book = 0
  let opening: Opening | undefined
  history.forEach((move, index) => {
    const match = openingBook[fenKey(move.after)]
    if (match && index === book) book++
    if (match && match !== true) opening = match
  })
  const iso = (headers.UTCDate || headers.Date || '').replaceAll('.', '-')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(Date.parse(iso)) ? iso : ''
  const utc = /^\d{2}:\d{2}:\d{2}$/.test(headers.UTCTime) && date ? Date.parse(date + 'T' + headers.UTCTime + 'Z') : NaN
  const timestamp = Number.isFinite(utc) ? utc : undefined
  const initial = history[0].before
  const identity = [headers.White?.toLowerCase(), headers.Black?.toLowerCase(), timestamp ?? date, result, initial, history.map(uci).join(' ')].join('|')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  const rating = (value: string) => /^\d+$/.test(value) ? historicalRating(Number(value)) : undefined
  return { id, pgn, initial, source, owner, url, white: headers.White === '?' ? 'Белые' : headers.White || 'Белые',
    black: headers.Black === '?' ? 'Чёрные' : headers.Black || 'Чёрные',
    whiteElo: rating(headers.WhiteElo), blackElo: rating(headers.BlackElo),
    date, timestamp, result, time: headers.TimeControl && headers.TimeControl !== '-' ? headers.TimeControl : '', opening, book, moves: history.length }
}

export const historicalRating = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
