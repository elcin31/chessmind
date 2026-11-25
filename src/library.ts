import { openDB, type DBSchema } from 'idb'
import type { Line, Review } from './review.js'

import { historicalRating, readGame, type Game, type Opening, type Source } from './game.js'
export * from './game.js'

export type Practice = { id: string; correct: number; wrong: number; streak: number; due: number; last: number }
interface Store extends DBSchema {
  games: { key: string; value: Game; indexes: { url: string } }
  positions: { key: string; value: Line[] | { lines: Line[]; used: number; hits?: number }; indexes: { used: number } }
  archives: { key: string; value: true }
  practice: { key: string; value: Practice }
}
export const db = openDB<Store>('chessmind-review', 2, {
  upgrade(database, version, _next, transaction) {
    if (version < 1) {
      database.createObjectStore('games', { keyPath: 'id' })
      database.createObjectStore('positions')
      database.createObjectStore('archives')
      database.createObjectStore('practice', { keyPath: 'id' })
    }
    if (version < 2) {
      transaction.objectStore('games').createIndex('url', 'url')
      transaction.objectStore('positions').createIndex('used', 'used')
    }
  },
})
let bookPromise: Promise<Record<string, true | Opening>> | undefined
export const getBook = () => bookPromise ??= fetch('/eco.json').then(response => {
  if (!response.ok) throw new Error('База ECO недоступна.')
  return response.json()
}).catch(error => { bookPromise = undefined; throw error })

export function parsePgn(pgn: string, source: Source = 'pgn', owner?: string, url?: string, legacy = false) {
  return readGame(pgn, getBook, source, owner, url, legacy)
}

export async function storeGame(game: Game) {
  const transaction = (await db).transaction('games', 'readwrite')
  const saved = await transaction.store.get(game.id) ?? (game.url ? await transaction.store.index('url').get(game.url) : undefined)
  if (saved) {
    const owner = game.owner && !saved.owner ? { source: game.source, owner: game.owner, url: game.url } : {}
    const whiteElo = saved.whiteElo ?? game.whiteElo
    const blackElo = saved.blackElo ?? game.blackElo
    if (owner.owner || whiteElo !== saved.whiteElo || blackElo !== saved.blackElo) {
      await transaction.store.put({ ...saved, ...owner, whiteElo, blackElo })
    }
  }
  if (!saved) await transaction.store.put(game)
  await transaction.done
  return !saved
}

async function* readLines(input: string | Blob) {
  if (typeof input === 'string') {
    yield* input.split(/\r?\n/)
    return
  }
  const reader = input.stream().getReader()
  const decode = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const chunk = await reader.read()
      pending += chunk.done ? decode.decode() : decode.decode(chunk.value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop()!
      yield* lines
      if (chunk.done) break
    }
    if (pending) yield pending
  } finally { await reader.cancel(); reader.releaseLock() }
}

export async function* splitPgn(input: string | Blob) {
  let body: string[] = []
  let moves = false, comment = false
  for await (const line of readLines(input)) {
    const heading = !comment && /^\s*\[[A-Za-z][\w]*\s+"/.test(line)
    if (heading && moves) {
      yield body.join('\n').trim()
      body = []
      moves = false
    }
    body.push(line)
    if (heading) continue
    for (const char of line) {
      if (char === ';' && !comment) break
      if (char === '{') comment = true
      else if (char === '}') comment = false
      else if (!comment && char.trim()) moves = true
    }
  }
  if (body.length) yield body.join('\n').trim()
}

export async function importPgn(text: string | Blob, source: Source = 'pgn', owner?: string, signal?: AbortSignal, onProgress?: (status: string) => void) {
  let added = 0, skipped = 0, invalid = 0
  let firstError = ''
  for await (const pgn of splitPgn(text)) {
    signal?.throwIfAborted()
    try {
      const game = await parsePgn(pgn, source, owner)
      if (await storeGame(game)) added++
      else skipped++
    } catch (error) {
      invalid++
      firstError ||= error instanceof Error ? error.message : 'Некорректный PGN.'
    }
    const processed = added + skipped + invalid
    if (processed % 25 === 0) onProgress?.('Обработано партий: ' + processed)
  }
  if (!added && !skipped) throw new Error(firstError || 'Добавьте текст PGN.')
  return { added, skipped, invalid }
}

const cooldown = new Map<string, number>()
async function request(url: string, accept?: string, signal?: AbortSignal, progress?: (status: string) => void) {
  const host = new URL(url).host
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted()
    const remaining = (cooldown.get(host) ?? 0) - Date.now()
    if (remaining > 0) {
      if (remaining > 60_000) throw new Error('Сервис ограничил запросы. Повторите через ' + Math.ceil(remaining / 1000) + ' с.')
      progress?.('Ждём ' + Math.ceil(remaining / 1000) + ' с перед повторным запросом…')
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, remaining)
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const timeout = AbortSignal.timeout(45_000)
    let response: Response
    try { response = await fetch(url, { headers: accept ? { Accept: accept } : {}, signal: signal ? AbortSignal.any([timeout, signal]) : timeout }) }
    catch {
      signal?.throwIfAborted()
      throw new Error('Не удалось подключиться к сервису. Проверьте сеть или импортируйте PGN.')
    }
    if (response.status === 429) {
      const header = response.headers.get('Retry-After')
      const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? '') - Date.now()
      cooldown.set(host, Date.now() + (Number.isFinite(wait) ? Math.max(1000, wait) : 60_000))
      continue
    }
    if (response.status === 404) throw new Error('Пользователь или архив не найден.')
    if (!response.ok) throw new Error('Сервис импорта недоступен (HTTP ' + response.status + '). Можно загрузить PGN.')
    return response
  }
  throw new Error('Сервис по-прежнему ограничивает запросы. Повторите попытку позже.')
}

export async function importAccount(
  source: Exclude<Source, 'pgn'>, name: string, onProgress: (status: string) => void, older = false, signal?: AbortSignal,
) {
  if (!/^[\w-]{2,40}$/.test(name)) throw new Error('Проверьте никнейм. Допустимы латиница, цифры, дефис и подчёркивание.')
  name = name.toLowerCase()
  if (source === 'lichess') {
    const previous = (await (await db).getAll('games')).filter(game => game.source === source && game.owner === name && game.timestamp !== undefined)
    const endpoint = new URL('https://lichess.org/api/games/user/' + encodeURIComponent(name))
    const params = endpoint.searchParams
    params.set('max', '100')
    params.set('pgnInJson', 'true')
    params.set('clocks', 'true')
    params.set('ongoing', 'false')
    params.set('finished', 'true')
    params.set('perfType', 'ultraBullet,bullet,blitz,rapid,classical,correspondence')
    const timestamps = previous.map(game => game.timestamp!)
    if (older && timestamps.length) params.set('until', String(Math.min(...timestamps) - 1))
    if (!older && timestamps.length) {
      params.set('since', String(Math.max(...timestamps) + 1))
      params.set('sort', 'dateAsc')
    }
    onProgress('Загружаем завершённые партии Lichess…')
    const payload = await (await request(endpoint.href, 'application/x-ndjson', signal, onProgress)).text()
    let added = 0, skipped = 0, invalid = 0
    for (const row of payload.split('\n').filter(line => line.trim())) {
      signal?.throwIfAborted()
      try {
        const item = JSON.parse(row)
        if (item.variant !== 'standard' || ['created', 'started', 'aborted'].includes(item.status) || typeof item.pgn !== 'string') { invalid++; continue }
        const game = await parsePgn(item.pgn, source, name, 'https://lichess.org/' + item.id)
        game.whiteElo ??= historicalRating(item.players?.white?.rating)
        game.blackElo ??= historicalRating(item.players?.black?.rating)
        if (Number.isSafeInteger(item.createdAt)) game.timestamp = item.createdAt
        if (await storeGame(game)) added++
        else skipped++
      } catch { invalid++ }
    }
    if (invalid && !added && !skipped) throw new Error('Lichess не вернул пригодных для разбора партий.')
    return { added, skipped, invalid, warning: '' }
  }
  const endpoint = 'https://api.chess.com/pub/player/' + encodeURIComponent(name) + '/games/archives'
  const data: { archives: string[] } = await (await request(endpoint, undefined, signal, onProgress)).json()
  if (!Array.isArray(data.archives)) throw new Error('Неожиданный ответ архива Chess.com.')
  const archives = [...data.archives].reverse()
  const storage = await db
  const syncKey = 'sync-2:' + name
  const needsRecheck = !older && archives.length > 1 && !await storage.get('archives', syncKey)
  const eligible = []
  for (const archive of archives) {
    if (!/^https:\/\/api\.chess\.com\/pub\/player\/[\w-]+\/games\/\d{4}\/\d{2}$/.test(archive)) continue
    if ((!older && archive === archives[0]) || (needsRecheck && archive === archives[1]) || !await storage.get('archives', archive)) eligible.push(archive)
  }
  const batch = (older ? eligible.filter(archive => archive !== archives[0]) : eligible).slice(0, 3)
  let added = 0, skipped = 0, invalid = 0
  let warning = ''
  for (const [index, archive] of batch.entries()) {
    onProgress('Chess.com · архив ' + (index + 1) + ' из ' + batch.length)
    let games: Array<{ pgn?: string; rules: string; url: string; white?: { rating?: number }; black?: { rating?: number } }>
    try {
      const payload = await (await request(archive, undefined, signal, onProgress)).json()
      if (!Array.isArray(payload.games)) throw new Error('Неверный формат архива.')
      games = payload.games
    } catch (error) {
      signal?.throwIfAborted()
      warning = (error instanceof Error ? error.message : 'Часть архивов не загрузилась.') + ' Месяц: ' + archive.slice(-7) + '.'
      break
    }
    for (const item of games) {
      signal?.throwIfAborted()
      if (!item.pgn || item.rules !== 'chess') { invalid++; continue }
      try {
        const game = await parsePgn(item.pgn, source, name, item.url)
        game.whiteElo ??= historicalRating(item.white?.rating)
        game.blackElo ??= historicalRating(item.black?.rating)
        if (await storeGame(game)) added++
        else skipped++
      } catch { invalid++ }
    }
    if (archive !== archives[0]) {
      const checkpoint = storage.transaction('archives', 'readwrite')
      await checkpoint.store.put(true, archive)
      if (archive === archives[1] && needsRecheck) await checkpoint.store.put(true, syncKey)
      await checkpoint.done
    }
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
