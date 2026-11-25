import { openDB, type DBSchema } from 'idb'
import { deviceCapabilities } from './device.js'
import { waitFor } from './loadControl.js'

interface QueueDatabase extends DBSchema {
  state: { key: string; value: { owner?: string; expires?: number; finished?: number } }
}
const queueName = 'chessmind-queue'
// Keep ownership for longer than the engine watchdog during tab suspension.
const leaseMs = 160_000
let storage: ReturnType<typeof openDB<QueueDatabase>> | undefined

async function updateLease(update: (state: QueueDatabase['state']['value']) => QueueDatabase['state']['value'] | undefined) {
  storage ??= openDB<QueueDatabase>('chessmind-analysis-queue', 1, {
    upgrade(database) { database.createObjectStore('state') },
  })
  const tx = (await storage).transaction('state', 'readwrite')
  const state = await tx.store.get(queueName) ?? {}
  const next = update(state)
  if (next) await tx.store.put(next, queueName)
  await tx.done
  return !!next
}

export async function withAnalysisLock<T>(controller: AbortController, run: () => Promise<T>, ifAvailable = false): Promise<T | undefined> {
  const { signal } = controller
  if (navigator.locks) return navigator.locks.request(queueName, ifAvailable ? { ifAvailable } : { signal },
    async lock => lock ? run() : undefined)

  const owner = crypto.randomUUID()
  const claim = () => updateLease(state => (state.expires ?? 0) > Date.now() ? undefined :
    { ...state, owner, expires: Date.now() + leaseMs })
  while (!(await claim())) {
    if (ifAvailable) return
    await waitFor(400, signal)
    signal.throwIfAborted()
  }
  const lost = () => controller.abort(new Error('Очередь анализа перешла в другую вкладку.'))
  const heartbeat = setInterval(() => {
    void updateLease(state => state.owner === owner && (state.expires ?? 0) > Date.now()
      ? { ...state, expires: Date.now() + leaseMs } : undefined)
      .then(renewed => { if (!renewed) lost() }, lost)
  }, 4000)
  try {
    signal.throwIfAborted()
    return await run()
  } finally {
    clearInterval(heartbeat)
    await updateLease(state => state.owner === owner ? { finished: state.finished } : undefined)
  }
}

export async function waitBetweenGames(signal: AbortSignal, eco: boolean) {
  let finished = 0
  await updateLease(state => { finished = state.finished ?? 0 }).catch(() => {})
  const delay = (eco ? 3500 : deviceCapabilities().mobile ? 2500 : 750) - (Date.now() - finished)
  if (delay > 0) await waitFor(delay, signal)
  signal.throwIfAborted()
}

export async function markGameFinished() {
  await updateLease(state => ({ ...state, finished: Date.now() })).catch(() => {})
}
