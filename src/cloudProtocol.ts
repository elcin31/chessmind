import { gameMoves, uci, type Game } from './game.js'

export type ComputeSource = 'local' | 'cloud' | 'auto'
export type ComputeEngine = Exclude<ComputeSource, 'auto'>
export type Energy = 'eco' | 'balanced' | 'turbo'
export type CloudMode = 'smart' | 'quick' | 'standard'

export { cloudEngine } from './game.js'
export const cloudLimits = {
  jobCpuMs: 20_000, reservationCpuMs: 30_000, jobWallMs: 25_000, monthCpuMs: 3_600_000,
  jobsPerMonth: 120, concurrent: 1, requestBytes: 1024, pgnBytes: 48 * 1024,
  plies: { smart: 60, quick: 100, standard: 40 },
} as const

export type CloudStatus = {
  available: boolean; reason?: 'quota_guard_unavailable' | 'disabled' | 'unavailable' | 'quota' | 'rate' | 'network' | 'offline';
  remainingCpuMs?: number; busy?: boolean; cacheAvailable?: boolean; modes?: CloudMode[]; engine?: string;
}

export type GameReference =
  | { platform: 'lichess'; id: string }
  | { platform: 'chesscom'; id: string; account: string; month: string }

export const cloudOptions = { threads: 1, hash: 16 } as const

export const supportedCloudMode = (mode: unknown): mode is CloudMode => mode === 'smart' || mode === 'quick' || mode === 'standard'

export function referenceFor(game: Game): GameReference | undefined {
  if (!game.url || game.source === 'pgn') return
  try {
    const url = new URL(game.url)
    if (url.protocol !== 'https:') return
    if (game.source === 'lichess' && url.host === 'lichess.org') {
      const id = /^\/([A-Za-z0-9]{8})\/?$/.exec(url.pathname)?.[1]
      if (id) return { platform: 'lichess', id }
    }
    if (game.source === 'chesscom' && ['www.chess.com', 'chess.com'].includes(url.host)) {
      const id = /^\/game\/(?:live|daily)\/([0-9]{1,20})\/?$/.exec(url.pathname)?.[1]
      const account = game.owner ?? game.white
      const month = game.date.slice(0, 7)
      if (id && /^[a-zA-Z0-9_-]{2,40}$/.test(account) && /^20\d\d-(?:0[1-9]|1[0-2])$/.test(month)) {
        return { platform: 'chesscom', id, account: account.toLowerCase(), month }
      }
    }
  } catch { /* A game without an official reference remains available locally. */ }
}

export async function gameFingerprint(game: Game) {
  const bytes = new TextEncoder().encode([game.initial, game.result, ...gameMoves(game).map(uci)].join('|'))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
