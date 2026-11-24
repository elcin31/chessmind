import { Chess, type Color, type Move } from 'chess.js'
import { openDB, type DBSchema } from 'idb'
import type { Line, Review } from './review'

export type Source = 'chesscom' | 'lichess' | 'pgn'
export type Opening = [eco: string, name: string, pgn: string]
export type Mode = 'quick' | 'standard' | 'deep'
export type Game = {
  id: string; pgn: string; initial: string; source: Source; url?: string; owner?: string;
  white: string; black: string; whiteElo?: number; blackElo?: number;
  date: string; timestamp?: number; result: string; time: string; opening?: Opening; book: number;
  moves: number; mode?: Mode; reviews?: Review[]; queued?: boolean
}
export type Practice = { id: string; correct: number; wrong: number; streak: number; due: number; last: number }
interface Store extends DBSchema {
  games: { key: string; value: Game }
  positions: { key: string; value: Line[] }
  archives: { key: string; value: true }
  practice: { key: string; value: Practice }
}
export const db = openDB<Store>('chessmind-review', 1, {
  upgrade(database) {
    database.createObjectStore('games', { keyPath: 'id' })
    database.createObjectStore('positions')
    database.createObjectStore('archives')
    database.createObjectStore('practice', { keyPath: 'id' })
  },
})
export const uci = (move: Move) => move.from + move.to + (move.promotion ?? '')
export const fenKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')
export const playUci = (chess: Chess, move: string) => chess.move({
  from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.slice(4, 5) || undefined,
})
export function gameMoves(game: Game) {
  const chess = new Chess()
  chess.loadPgn(game.pgn)
  return chess.history({ verbose: true })
}
export const playerColor = (game: Game, nickname?: string): Color | undefined => {
  const name = (game.owner || nickname)?.toLowerCase()
  if (name === game.white.toLowerCase()) return 'w'
  if (name === game.black.toLowerCase()) return 'b'
}
export const isComplete = (game: Game) => !!game.reviews && game.reviews.length === game.moves
export const displayDate = (date: string) => date ? new Date(date + 'T12:00:00').toLocaleDateString('ru-RU') : 'Дата неизвестна'

let bookPromise: Promise<Record<string, true | Opening>> | undefined
export const getBook = () => bookPromise ??= fetch('/eco.json').then(response => {
  if (!response.ok) throw new Error('База ECO недоступна.')
  return response.json()
}).catch(error => { bookPromise = undefined; throw error })

export async function parsePgn(pgn: string, source: Source = 'pgn', owner?: string, url?: string): Promise<Game> {
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
  const openingBook = await getBook()
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
  const rating = (value: string) => /^\d+$/.test(value) ? Number(value) : undefined
  return { id, pgn, initial, source, owner, url, white: headers.White === '?' ? 'Белые' : headers.White || 'Белые',
    black: headers.Black === '?' ? 'Чёрные' : headers.Black || 'Чёрные',
    whiteElo: rating(headers.WhiteElo), blackElo: rating(headers.BlackElo),
    date, timestamp, result, time: headers.TimeControl && headers.TimeControl !== '-' ? headers.TimeControl : '', opening, book, moves: history.length }
}

export async function storeGame(game: Game) {
  const transaction = (await db).transaction('games', 'readwrite')
  const saved = await transaction.store.get(game.id)
  if (saved && game.owner && !saved.owner) await transaction.store.put({ ...saved, source: game.source, owner: game.owner, url: game.url })
  if (!saved) await transaction.store.put(game)
  await transaction.done
  return !saved
}

export async function importPgn(text: string, source: Source = 'pgn', owner?: string) {
  const parts = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
    .split(/\n(?=\s*\[Event\s)|(?<=\n)\s*\n(?=\s*\[(?:Site|White|Black|Date|Result)\s)/)
    .map(part => part.trim()).filter(Boolean)
  let added = 0
  let skipped = 0
  let invalid = 0
  let firstError = ''
  for (const pgn of parts) {
    try {
      const game = await parsePgn(pgn, source, owner)
      if (await storeGame(game)) added++
      else skipped++
    } catch (error) {
      invalid++
      firstError ||= error instanceof Error ? error.message : 'Некорректный PGN.'
    }
  }
  if (!parts.length || invalid === parts.length) throw new Error(firstError || 'Добавьте текст PGN.')
  return { added, skipped, invalid }
}

async function request(url: string, accept?: string) {
  let response: Response
  try {
    response = await fetch(url, { headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new Error('Не удалось подключиться к сервису. Проверьте сеть или импортируйте PGN.')
  }
  if (response.status === 404) throw new Error('Пользователь или архив не найден.')
  if (response.status === 429) throw new Error('Сервис ограничил частоту запросов. Повторите попытку позже.')
  if (!response.ok) throw new Error('Сервис импорта недоступен (HTTP ' + response.status + '). Можно загрузить PGN.')
  return response
}

export async function importAccount(
  source: Exclude<Source, 'pgn'>, name: string, onProgress: (status: string) => void, older = false,
) {
  if (!/^[\w-]{2,40}$/.test(name)) throw new Error('Проверьте никнейм. Допустимы латиница, цифры, дефис и подчёркивание.')
  name = name.toLowerCase()
  if (source === 'lichess') {
    const previous = (await (await db).getAll('games')).filter(game => game.source === source && game.owner === name && game.timestamp !== undefined)
    const endpoint = new URL('https://lichess.org/api/games/user/' + encodeURIComponent(name))
    const params = endpoint.searchParams
    params.set('max', '100')
    params.set('pgnInJson', 'true')
    params.set('clocks', 'false')
    params.set('ongoing', 'false')
    params.set('finished', 'true')
    params.set('perfType', 'ultraBullet,bullet,blitz,rapid,classical,correspondence')
    const timestamps = previous.map(game => game.timestamp!)
    if (older && timestamps.length) params.set('until', String(Math.min(...timestamps) - 1))
    if (!older && timestamps.length) {
      params.set('since', String(Math.max(...timestamps)))
      params.set('sort', 'dateAsc')
    }
    onProgress('Загружаем завершённые партии Lichess…')
    const payload = await (await request(endpoint.href, 'application/x-ndjson')).text()
    let added = 0, skipped = 0, invalid = 0
    for (const row of payload.split('\n').filter(line => line.trim())) {
      try {
        const item = JSON.parse(row)
        if (item.variant !== 'standard' || ['created', 'started', 'aborted'].includes(item.status) || typeof item.pgn !== 'string') { invalid++; continue }
        const game = await parsePgn(item.pgn, source, name, 'https://lichess.org/' + item.id)
        if (Number.isSafeInteger(item.createdAt)) game.timestamp = item.createdAt
        if (await storeGame(game)) added++
        else skipped++
      } catch { invalid++ }
    }
    if (invalid && !added && !skipped) throw new Error('Lichess не вернул пригодных для разбора партий.')
    return { added, skipped, invalid, warning: '' }
  }
  const endpoint = 'https://api.chess.com/pub/player/' + encodeURIComponent(name) + '/games/archives'
  const data: { archives: string[] } = await (await request(endpoint)).json()
  if (!Array.isArray(data.archives)) throw new Error('Неожиданный ответ архива Chess.com.')
  const archives = [...data.archives].reverse()
  const storage = await db
  const eligible = []
  for (const archive of archives) {
    if (!/^https:\/\/api\.chess\.com\/pub\/player\/[\w-]+\/games\/\d{4}\/\d{2}$/.test(archive)) continue
    if ((archive === archives[0] && !older) || !await storage.get('archives', archive)) eligible.push(archive)
  }
  const batch = eligible.slice(0, 3)
  let added = 0, skipped = 0, invalid = 0
  let warning = ''
  for (const [index, archive] of batch.entries()) {
    onProgress('Chess.com · архив ' + (index + 1) + ' из ' + batch.length)
    let games: Array<{ pgn?: string; rules: string; url: string }>
    try {
      const payload = await (await request(archive)).json()
      if (!Array.isArray(payload.games)) throw new Error('Неверный формат архива.')
      games = payload.games
    } catch (error) {
      warning = (error instanceof Error ? error.message : 'Часть архивов не загрузилась.') + ' Месяц: ' + archive.slice(-7) + '.'
      continue
    }
    for (const item of games) {
      if (!item.pgn || item.rules !== 'chess') { invalid++; continue }
      try {
        if (await storeGame(await parsePgn(item.pgn, source, name, item.url))) added++
        else skipped++
      } catch { invalid++ }
    }
    await storage.put('archives', true, archive)
  }
  if (warning && !added && !skipped) throw new Error(warning)
  return { added, skipped, invalid, warning }
}

export function timeLabel(time: string) {
  const match = time.match(/^(\d+)(?:\+(\d+))?$/)
  if (!match) return time || '—'
  const seconds = Number(match[1])
  const base = seconds >= 60 ? (seconds / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' мин' : seconds + ' с'
  return match[2] ? base + ' + ' + match[2] + ' с' : base
}
