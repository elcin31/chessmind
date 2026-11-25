import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cloudEngine, cloudLimits, cloudOptions, gameFingerprint, type CloudMode, type CloudStatus, type GameReference } from '../../src/cloudProtocol'
import { readGame, type Opening } from '../../src/game'
import { analyzeProgressively } from '../../src/progressive'
import { ServerStockfish } from './stockfish'
import { officialPgn, readText, RequestFailure } from './verification'

type BudgetSnapshot = { remainingCpuMs: number; busy: boolean }
type Permit = { release(): Promise<void> }
export type Admission = {
  status(): Promise<BudgetSnapshot>
  // Atomically debit the full reservation and lock the job id and global
  // concurrency. Keep the debit and replay entry even if the job is cancelled.
  reserve(key: string, cpuMs: number): Promise<Permit | 'duplicate' | 'quota' | 'busy'>
}

const disabled: CloudStatus = { available: false, reason: 'quota_guard_unavailable', modes: ['quick', 'standard'], engine: cloudEngine }
const json = (body: object, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, code: string, message: string) => json({ code, message }, status)
const validMonth = /^20\d\d-(0[1-9]|1[0-2])$/
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const keys = (value: object, list: string[]) => Object.keys(value).length === list.length && list.every(key => Object.hasOwn(value, key))

function input(value: unknown): { reference: GameReference; fingerprint: string; mode: CloudMode } {
  if (!object(value) || !keys(value, ['reference', 'fingerprint', 'mode']) ||
    typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    throw new RequestFailure(400, 'invalid', 'Требуется ссылка на игру из официального архива.')
  }
  const { reference: ref, mode, fingerprint } = value
  if (mode !== 'quick' && mode !== 'standard') throw new RequestFailure(422, 'mode', 'Этот режим доступен на устройстве.')
  if (!object(ref) || typeof ref.id !== 'string') throw new RequestFailure(400, 'invalid', 'Неверная ссылка на партию.')
  if (ref.platform === 'lichess' && keys(ref, ['platform', 'id']) && /^[A-Za-z0-9]{8}$/.test(ref.id)) {
    return { reference: { platform: 'lichess', id: ref.id }, fingerprint, mode }
  }
  if (ref.platform === 'chesscom' && keys(ref, ['platform', 'id', 'account', 'month']) && /^\d{1,20}$/.test(ref.id) &&
    typeof ref.account === 'string' && /^[a-z0-9_-]{2,40}$/.test(ref.account) &&
    typeof ref.month === 'string' && validMonth.test(ref.month) && ref.month <= new Date().toISOString().slice(0, 7)) {
    return { reference: { platform: 'chesscom', id: ref.id, account: ref.account, month: ref.month }, fingerprint, mode }
  }
  throw new RequestFailure(400, 'invalid', 'Неверная ссылка на партию.')
}

let book: Record<string, true | Opening> | undefined
async function loadBook() {
  return book ??= JSON.parse(await readFile(resolve('public/eco.json'), 'utf8'))
}

type Dependencies = {
  admission?: Admission;
  enabled?: () => boolean;
  request?: typeof fetch;
  loadBook?: () => Promise<Record<string, true | Opening>>;
}

export function engineHandler(deps: Dependencies = {}) {
  const enabled = deps.enabled ?? (() => process.env.CHESSMIND_CLOUD_ENABLED === '1')
  return async (request: Request) => {
    const path = new URL(request.url).pathname
    const gate = deps.admission
    if (path === '/api/engine/status' && request.method === 'GET') {
      if (!gate) return json(disabled)
      if (!enabled()) return json({ ...disabled, reason: 'disabled' })
      try {
        const state = await gate.status()
        const available = state.remainingCpuMs >= cloudLimits.reservationCpuMs
        return json({ available, reason: available ? undefined : 'quota', ...state, modes: disabled.modes, engine: cloudEngine,
          estimateSeconds: { quick: 8, standard: 18 } })
      } catch { return json(disabled) }
    }
    if (path !== '/api/engine/analyze') return fail(404, 'not_found', 'Маршрут недоступен.')
    if (request.method !== 'POST') return fail(405, 'method', 'Используйте POST.')
    if (!gate || !enabled()) return fail(503, !gate ? 'quota_guard_unavailable' : 'disabled', 'Облачный анализ временно недоступен.')
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail(403, 'origin', 'Запрос с другого сайта отклонён.')
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail(415, 'type', 'Требуется JSON.')
    if (Number(request.headers.get('content-length')) > cloudLimits.requestBytes) return fail(413, 'size', 'Запрос превышает лимит размера.')

    const started = performance.now()
    const startedCpu = process.cpuUsage()
    const stop = new AbortController()
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(cloudLimits.jobWallMs), stop.signal])
    let permit: Permit | undefined
    try {
      const query = input(JSON.parse(await readText(request.body, cloudLimits.requestBytes, signal)))
      signal.throwIfAborted()
      const reserved = await gate.reserve([query.reference.platform, query.reference.id, query.mode].join(':'), cloudLimits.reservationCpuMs)
      if (typeof reserved === 'string') return fail(429, reserved, reserved === 'quota' ? 'Облачный лимит исчерпан.' :
        reserved === 'duplicate' ? 'Эта партия уже запрашивалась в выбранном режиме.' : 'Облачный движок занят.')
      permit = reserved

      const pgn = await officialPgn(query.reference, signal, deps.request)
      let game
      try { game = await readGame(pgn, deps.loadBook ?? loadBook, query.reference.platform) }
      catch { throw new RequestFailure(422, 'illegal', 'Запись партии не прошла проверку шахматных правил.') }
      if (game.moves > cloudLimits.plies[query.mode]) throw new RequestFailure(422, 'plies', 'Партия слишком длинная для этого облачного режима.')
      if (await gameFingerprint(game) !== query.fingerprint) throw new RequestFailure(422, 'mismatch', 'Партия в архиве отличается от записи на устройстве.')
      const options = cloudOptions
      game = { ...game, mode: query.mode, options, methodology: 2 as const, compute: 'cloud' as const }

      const release = permit
      permit = undefined
      let engine: ServerStockfish | undefined
      let cpuMs = 0
      let pendingSample = false
      const cpu = async () => {
        const worker = await engine?.cpuMs()
        const host = process.cpuUsage(startedCpu)
        cpuMs = Math.max(cpuMs, (host.user + host.system) / 1000, worker ?? 0)
        return cpuMs
      }
      // process.cpuUsage includes the engine thread. The independent sample also
      // provides a check that the worker is still measurable.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          let connected = true
          const send = (data: object) => {
            if (!connected || request.signal.aborted) return
            try { controller.enqueue(encoder.encode(JSON.stringify(data) + '\n')) }
            catch { connected = false; stop.abort() }
          }
          const meter = setInterval(() => {
            if (pendingSample || signal.aborted) return
            pendingSample = true
            void cpu().then(value => {
              if (value >= cloudLimits.jobCpuMs) stop.abort(new DOMException('CPU budget', 'TimeoutError'))
            }).catch(() => {
              if (engine && !signal.aborted) stop.abort(new DOMException('CPU measurement', 'TimeoutError'))
            }).finally(() => { pendingSample = false })
          }, 100)
          const run = async () => {
            let last = -Infinity
            let stage = ''
            try {
              send({ type: 'start', fingerprint: query.fingerprint, engine: cloudEngine, mode: query.mode, options })
              const result = await analyzeProgressively(game, query.mode, signal, async (draft, progress) => {
                const now = performance.now()
                if (stage !== progress.stage || now - last >= 180 || progress.instant === progress.moves + 1 && progress.stage === 'instant') {
                  stage = progress.stage
                  last = now
                  send({ type: 'progress', draft, progress })
                }
              }, sample => send({ type: 'telemetry', sample }), false, async settings => {
                engine = new ServerStockfish(signal, settings, sample => send({ type: 'telemetry', sample }))
                return engine
              })
              send({ type: 'done', ...result, metrics: {
                cpuMs: await cpu(), wallMs: performance.now() - started, searches: engine?.searches ?? 0,
                nodes: engine?.nodes ?? 0, engineBootMs: engine?.bootMs ?? 0, rssKiB: process.memoryUsage.rss() / 1024,
              } })
            } catch {
              if (!request.signal.aborted) send({ type: 'error', code: signal.aborted ? 'budget' : 'engine',
                message: signal.aborted ? 'Лимит облачного запуска исчерпан. Готовые позиции сохранены.' : 'Облачный движок прервал работу.',
                metrics: { cpuMs, wallMs: performance.now() - started, searches: engine?.searches ?? 0, nodes: engine?.nodes ?? 0,
                  engineBootMs: engine?.bootMs ?? 0, rssKiB: process.memoryUsage.rss() / 1024 } })
            } finally {
              clearInterval(meter)
              await engine?.close().catch(() => {})
              await release.release().catch(() => {})
              if (connected) { try { controller.close() } catch { /* A client can cancel concurrently. */ } }
            }
          }
          void run()
        },
        cancel() { stop.abort() },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } })
    } catch (error) {
      if (error instanceof RequestFailure) return fail(error.status, error.code, error.message)
      if (error instanceof SyntaxError || error instanceof TypeError) return fail(400, 'invalid', 'Некорректный JSON.')
      if (signal.aborted) return fail(503, 'budget', 'Время проверки архивной записи истекло.')
      return fail(503, 'unavailable', 'Облачный анализ временно недоступен.')
    } finally { await permit?.release().catch(() => {}) }
  }
}

// This Web Standard entry point can be deployed as a Node.js Function once the
// project has an atomic global admission provider. Production routing currently
// serves a static status document and rejects the compute path at the edge.
export default { fetch: engineHandler() }
