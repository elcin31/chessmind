import { openDB, type DBSchema } from 'idb'
import type { Game, Source } from './library'

export type ProfileSource = Exclude<Source, 'pgn'>
export type Profile = { saved: number; ttl: number; avatar?: string; image?: Blob; title?: string }
interface ProfileStore extends DBSchema {
  profiles: { key: string; value: Profile; indexes: { saved: number } }
}

const day = 86_400_000
const requests = new Map<string, Promise<Profile | undefined>>()
const history = new Map<string, { value?: Profile; until: number }>()
let database: ReturnType<typeof openDB<ProfileStore>> | undefined
let tail: Promise<unknown> = Promise.resolve()
let nextRequest = 0
let writes = 0
const blocked: Partial<Record<ProfileSource, number>> = {}
const storage = () => database ??= openDB<ProfileStore>('chessmind-player-profiles', 1, {
  upgrade(db) { db.createObjectStore('profiles').createIndex('saved', 'saved') },
})
const profileKey = (source: ProfileSource) => 'chessmind-profile-retry-' + source

export function retryAfter(value: string | null, now = Date.now()) {
  const relative = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value ?? '') - now
  return Math.max(1000, Number.isFinite(relative) ? relative : 60_000)
}

export function profileRetryAt(source: ProfileSource) {
  try { return Math.max(blocked[source] ?? 0, Number(localStorage.getItem(profileKey(source))) || 0) }
  catch { return blocked[source] ?? 0 }
}

function avatarUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    const host = url.hostname
    if (url.protocol === 'https:' && !url.username && !url.password &&
      (host === 'chess.com' || host.endsWith('.chess.com') || host === 'chesscomfiles.com' || host.endsWith('.chesscomfiles.com'))) return url.href
  } catch { /* Leave the standard profile icon visible. */ }
}

async function loadImage(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok || !/^image\/(?:jpeg|png|gif|webp|avif)(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) return
    if (Number(response.headers.get('Content-Length')) > 320_000) return
    const image = await response.blob()
    if (image.size <= 320_000) return image
  } catch { /* A same-origin or CORP-enabled native image can still render. */ }
}

function remember(key: string, value: Profile | undefined, until: number) {
  history.set(key, { value, until })
  if (history.size > 256) history.delete(history.keys().next().value!)
  return value
}

async function persist(key: string, record: Profile) {
  try {
    const db = await storage()
    await db.put('profiles', record, key)
    if (++writes % 20 !== 1) return
    const tx = db.transaction('profiles', 'readwrite')
    let excess = await tx.store.count() - 180
    let cursor = excess > 0 ? await tx.store.index('saved').openKeyCursor() : null
    while (cursor && excess-- > 0) {
      await tx.store.delete(cursor.primaryKey)
      cursor = await cursor.continue()
    }
    await tx.done
  } catch { /* Profiles are optional while browsing the local library. */ }
}

export function requestProfile(source: ProfileSource, name: string) {
  const username = name.toLowerCase().trim()
  if (!/^[a-z0-9_-]{2,40}$/.test(username)) return Promise.resolve(undefined)
  const key = source + ':' + username
  const saved = history.get(key)
  if (saved && saved.until > Date.now()) return Promise.resolve(saved.value)
  const active = requests.get(key)
  if (active) return active
  const work = (async () => {
    const stored = await storage().then(db => db.get('profiles', key)).catch(() => undefined)
    if (stored && stored.saved + stored.ttl > Date.now()) return remember(key, stored, stored.saved + stored.ttl)
    const run = tail.then(async () => {
      const now = Date.now()
      const until = profileRetryAt(source)
      if (until > now) return remember(key, stored, until)
      if (nextRequest > now) await new Promise(resolve => setTimeout(resolve, nextRequest - now))
      if (!navigator.onLine || document.hidden) return remember(key, stored, Date.now() + 5000)
      nextRequest = Date.now() + 800
      const route = source === 'chesscom' ? 'https://api.chess.com/pub/player/' : 'https://lichess.org/api/user/'
      try {
        const response = await fetch(route + encodeURIComponent(username), {
          credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000),
        })
        if (response.status === 429) {
          const retry = Date.now() + retryAfter(response.headers.get('Retry-After'))
          blocked[source] = retry
          try { localStorage.setItem(profileKey(source), String(retry)) } catch { /* In-memory cooldown still applies. */ }
          return remember(key, stored, retry)
        }
        if (response.status !== 404 && !response.ok) return remember(key, stored, Date.now() + 300_000)
        const payload = response.ok ? await response.json() : {}
        const avatar = source === 'chesscom' ? avatarUrl(payload.avatar) : undefined
        const title = typeof payload.title === 'string' && /^(?:GM|IM|FM|CM|NM|WGM|WIM|WFM|WCM|BOT)$/.test(payload.title) ? payload.title : undefined
        const image = avatar === stored?.avatar && stored?.image ? stored.image : avatar ? await loadImage(avatar) : undefined
        const record = { saved: Date.now(), ttl: (avatar || title ? 7 : 1) * day, avatar, image, title }
        await persist(key, record)
        return remember(key, record, record.saved + record.ttl)
      } catch { return remember(key, stored, Date.now() + 300_000) }
    })
    tail = run.then(() => undefined, () => undefined)
    return run
  })().finally(() => requests.delete(key))
  requests.set(key, work)
  return work
}

export function profileSource(game: Game): ProfileSource | undefined {
  if (game.source !== 'pgn') return game.source
  const site = /^\[Site\s+"([^"]+)"\]/m.exec(game.pgn)?.[1].toLowerCase()
  if (site && /^(?:https?:\/\/)?(?:www\.)?chess\.com(?:\/|$)/.test(site)) return 'chesscom'
  if (site && /^(?:https?:\/\/)?(?:www\.)?lichess\.org(?:\/|$)/.test(site)) return 'lichess'
}
