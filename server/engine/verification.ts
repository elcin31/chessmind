import type { GameReference } from '../../src/cloudProtocol'
import { cloudLimits } from '../../src/cloudProtocol'

export class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function readText(stream: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal) {
  if (!stream) return ''
  signal?.throwIfAborted()
  const reader = stream.getReader()
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, text = ''
  try {
    for (;;) {
      const part = await reader.read()
      signal?.throwIfAborted()
      if (part.done) return text + decoder.decode()
      total += part.value.byteLength
      if (total > maximum) {
        void reader.cancel().catch(() => {})
        throw new RequestFailure(413, 'size', 'Превышен лимит размера записи.')
      }
      text += decoder.decode(part.value, { stream: true })
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
}

const lichessFinished = new Set(['mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime', 'cheat', 'noStart', 'unknownFinish', 'variantEnd'])
const chesscomFinished = new Set(['win', 'checkmated', 'agreed', 'repetition', 'timeout', 'resigned', 'stalemate',
  'lose', 'insufficient', '50move', 'abandoned', 'timevsinsufficient', 'treated', 'kingofthehill', 'threecheck', 'bughousepartnerlose'])

export async function officialPgn(reference: GameReference, signal: AbortSignal, request = fetch) {
  const provider = reference.platform
  // Build the URL from validated identifiers. Redirects are rejected.
  const url = provider === 'lichess'
    ? 'https://lichess.org/game/export/' + reference.id + '?pgnInJson=true&clocks=false&evals=false&opening=false'
    : 'https://api.chess.com/pub/player/' + reference.account + '/games/' + reference.month.replace('-', '/')
  let response: Response
  try { response = await request(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }) }
  catch {
    signal.throwIfAborted()
    throw new RequestFailure(503, 'provider', 'Архив партии временно недоступен.')
  }
  if (response.status === 429) throw new RequestFailure(429, 'provider', 'Архив ограничил запросы. Попробуйте позже.')
  if (!response.ok) throw new RequestFailure(response.status === 404 ? 404 : 503, 'provider', 'Запись в официальном архиве недоступна.')
  let pgn: unknown
  try {
    const data = JSON.parse(await readText(response.body, provider === 'lichess' ? 96 * 1024 : 6 * 1024 ** 2, signal))
    if (provider === 'lichess' && data.id === reference.id && data.variant === 'standard' && lichessFinished.has(data.status)) {
      pgn = data.pgn
    } else if (provider === 'chesscom' && Array.isArray(data.games)) {
      const record = data.games.find((game: { url?: string }) => typeof game?.url === 'string' &&
        new RegExp('^https://(?:www\\.)?chess\\.com/game/(?:live|daily)/' + reference.id + '$').test(game.url))
      if (record?.rules === 'chess' && Number.isSafeInteger(record.end_time) && record.end_time > 0 &&
        record.end_time <= Date.now() / 1000 && chesscomFinished.has(record.white?.result) && chesscomFinished.has(record.black?.result)) pgn = record.pgn
    }
  } catch (error) {
    if (error instanceof RequestFailure) throw error
    signal.throwIfAborted()
    throw new RequestFailure(503, 'provider', 'Архив вернул неподдерживаемый ответ.')
  }
  if (typeof pgn !== 'string') throw new RequestFailure(422, 'unverified', 'Официальный архив не подтвердил завершённую стандартную партию.')
  if (Buffer.byteLength(pgn) > cloudLimits.pgnBytes) throw new RequestFailure(413, 'size', 'Запись партии превышает облачный лимит.')
  return pgn
}
