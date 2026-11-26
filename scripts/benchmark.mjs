import { Chess } from 'chess.js'
import { chromium } from 'playwright'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { immortal, opera } from '../tests/fixtures.ts'

const [url, output] = process.argv.slice(2)
if (!url || !output) throw new Error('node --import tsx scripts/benchmark.mjs <url> <output.ndjson>')

function resources(profile) {
  const processes = readdirSync('/proc').filter(item => /^\d+$/.test(item)).flatMap(id => {
    try {
      const stat = readFileSync('/proc/' + id + '/stat', 'utf8').split(') ').at(-1).split(' ')
      return [{ id: Number(id), parent: Number(stat[1]), cpu: Number(stat[11]) + Number(stat[12]) }]
    } catch { return [] }
  })
  const root = processes.find(({ id }) => {
    try { return readFileSync('/proc/' + id + '/cmdline', 'utf8').includes('--user-data-dir=' + profile + '\0') }
    catch { return false }
  })
  if (!root) return { pss: 0, cpu: 0 }
  const ids = [root.id]
  let pss = 0
  for (const id of ids) {
    ids.push(...processes.filter(item => item.parent === id).map(item => item.id))
    try { pss += Number(readFileSync('/proc/' + id + '/smaps_rollup', 'utf8').match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) }
    catch { /* A Chromium process exited between samples. */ }
  }
  return { pss, cpu: processes.reduce((total, item) => total + (ids.includes(item.id) ? item.cpu : 0), 0) }
}

const { appendFileSync } = await import('node:fs')
const profiles = (process.env.BENCH_MODES ?? 'quick,standard,deep,professional').split(',')
const tailPlies = Number(process.env.BENCH_TAIL ?? 0)
const longGame = readFileSync(new URL('../benchmarks/2.0.6-games.pgn', import.meta.url), 'utf8')
  .split(/(?=^\[Event )/m).find(pgn => pgn.includes('https://lichess.org/vb3w3rmn'))
const rawGames = [[opera, 'Morphy', 'opera'], [immortal, 'Anderssen', 'immortal'],
  ...(process.env.BENCH_LONG === '1' ? [[longGame, 'nichiren1967', 'long']] : [])]
  .filter(([, , name]) => !process.env.BENCH_GAMES || process.env.BENCH_GAMES === name)
const games = rawGames.map(([pgn, name]) => {
  if (!tailPlies) return [pgn, name]
  const game = new Chess()
  game.loadPgn(pgn)
  const headers = game.getHeaders()
  const moves = game.history({ verbose: true }).slice(-tailPlies)
  const body = moves.map(move => move.before.split(' ')[5] + (move.color === 'w' ? '. ' : '... ') + move.san).join(' ')
  const tags = Object.entries({ ...headers, SetUp: '1', FEN: moves[0].before })
    .map(([key, value]) => '[' + key + ' "' + value + '"]').join('\n')
  return [tags + '\n\n' + body + ' ' + headers.Result, name]
})
const threads = process.env.BENCH_THREADS === 'auto' ? undefined : 1
const requestedWorkers = Number(process.env.BENCH_WORKERS) || undefined
const cores = Number(process.env.BENCH_CORES) || undefined
const memoryGiB = Number(process.env.BENCH_MEMORY) || undefined
const energy = process.env.BENCH_ENERGY ?? 'balanced'
const mobile = process.env.BENCH_MOBILE === '1'
const cpuHz = Number(process.env.BENCH_CPU_HZ ?? 100)
for (const mode of profiles) {
  const profile = mkdtempSync(join(tmpdir(), 'chessbench-'))
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    viewport: { width: 393, height: 873 },
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36' } : {}),
  })
  try {
    await context.addInitScript(({ threads, requestedWorkers, cores, memoryGiB, energy }) => {
      if (cores) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores })
      if (memoryGiB) Object.defineProperty(navigator, 'deviceMemory', { get: () => memoryGiB })
      let previousTick = performance.now()
      setInterval(() => {
        const now = performance.now()
        if (window.bench.start) window.bench.lag.push(Math.max(0, now - previousTick - 50))
        previousTick = now
      }, 50)
      localStorage.setItem('chessmind-settings', JSON.stringify({ theme: 'system', nickname: '', computeSource: 'local', engine: { threads, hash: 16, workers: requestedWorkers, energy } }))
      const original = Worker.prototype.postMessage
      const observed = new WeakMap()
      window.bench = { searches: 0, repeatedSearches: 0, nodes: 0, depths: 0, peakWorkers: 0, peakThreads: 0, phases: {} }
      const running = new Set()
      let activeSince = 0, idleSince = 0, continuousMs = 0
      let unique = new Set()
      const observeIdle = now => {
        const idle = now - idleSince
        if (idle < 100) continuousMs += idle
        else continuousMs = 0
      }
      const observer = new MutationObserver(() => {
        if (!window.bench.start) return
        const node = document.querySelector('.analysis-progress')
        const phase = node?.dataset.stage
        const elapsed = performance.now() - window.bench.start
        if (phase) window.bench.phases[phase] ??= elapsed
        if (document.querySelector('[data-preview-ready]')) window.bench.phases.preview ??= elapsed
        window.bench.peakThreads = Math.max(window.bench.peakThreads, Number(node?.dataset.threads ?? 0))
      })
      observer.observe(document, { attributes: true, childList: true, subtree: true })
      Worker.prototype.postMessage = function (message, ...options) {
        if (typeof message === 'string' && message.startsWith('position ')) {
          const state = observed.get(this) ?? {}
          state.position = message
          observed.set(this, state)
        }
        if (typeof message === 'string' && message.startsWith('setoption name MultiPV ')) {
          const state = observed.get(this) ?? {}
          state.multi = message
          observed.set(this, state)
        }
        if (typeof message === 'string' && message.startsWith('go ')) {
          let search = observed.get(this)
          if (!search?.attached) {
            search = { ...search, nodes: 0, depth: 0, attached: true }
            observed.set(this, search)
            this.addEventListener('message', ({ data }) => {
              if (typeof data !== 'string') return
              for (const line of data.split('\n')) {
                const nodes = line.match(/\bnodes (\d+)/)?.[1]
                const depth = line.match(/^info depth (\d+)/)?.[1]
                if (nodes) search.nodes = Math.max(search.nodes, Number(nodes))
                if (depth) search.depth = Math.max(search.depth, Number(depth))
                if (line.startsWith('bestmove')) {
                  running.delete(this)
                  if (!running.size) {
                    idleSince = performance.now()
                    const active = idleSince - activeSince
                    window.bench.activeMs += active
                    continuousMs += active
                    window.bench.longestMs = Math.max(continuousMs, window.bench.longestMs)
                  }
                  window.bench.nodes += search.nodes
                  window.bench.depths += search.depth
                }
              }
            })
          }
          if (!window.bench.searches) unique = new Set()
          const key = [search.position, search.multi, message].join('\n')
          if (unique.has(key)) window.bench.repeatedSearches++
          unique.add(key)
          search.nodes = search.depth = 0
          window.bench.searches++
          if (!running.size) {
            activeSince = performance.now()
            if (window.bench.searches === 1) continuousMs = 0
            else observeIdle(activeSince)
          }
          running.add(this)
          window.bench.peakWorkers = Math.max(running.size, window.bench.peakWorkers)
        }
        return original.call(this, message, ...options)
      }
    }, { threads, requestedWorkers, cores, memoryGiB, energy })
    const page = context.pages()[0]
    page.on('dialog', dialog => dialog.accept())
    await page.route(/^https:\/\//, route => route.abort())
    await page.goto(url)
    await page.getByText('Офлайн готов').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'PGN', exact: true }).click()
    await page.getByRole('textbox', { name: 'Текст PGN' }).fill(games.map(([pgn]) => pgn).join('\n\n'))
    await page.getByRole('button', { name: 'Импортировать PGN' }).click()
    for (const [, name] of games) {
      await page.locator('.recent-list button').filter({ hasText: name }).click()
      await page.getByRole('combobox', { name: /^(Тип разбора|Глубина анализа)$/ }).selectOption(mode)
      await page.evaluate(() => Object.assign(window.bench, {
        searches: 0, repeatedSearches: 0, nodes: 0, depths: 0, peakWorkers: 0, peakThreads: 0, phases: {}, activeMs: 0, longestMs: 0, lag: [], start: performance.now(),
      }))
      const idle = resources(profile)
      let peakPss = idle.pss
      const sample = setInterval(() => { peakPss = Math.max(peakPss, resources(profile).pss) }, 350)
      const start = performance.now()
      try {
        await page.getByRole('button', { name: 'Начать анализ' }).click()
        await page.getByRole('heading', { name: /Итоги партии/ }).or(page.locator('.banner[role="alert"]')).first().waitFor({ timeout: 600_000 })
        const failure = page.locator('.banner[role="alert"]')
        if (await failure.count()) throw new Error(await failure.innerText())
        const seconds = (performance.now() - start) / 1000
        const data = await page.evaluate(async name => {
          const records = await new Promise((resolve, reject) => {
            const open = indexedDB.open('chessmind-review')
            open.onsuccess = () => {
              const all = open.result.transaction('games').objectStore('games').getAll()
              all.onsuccess = () => { open.result.close(); resolve(all.result) }
              all.onerror = () => reject(all.error)
            }
            open.onerror = () => reject(open.error)
          })
          const game = records.find(item => item.white === name)
          const metrics = ['w', 'b'].map(color => {
            const reviews = game.reviews.filter(item => item.color === color && !item.forced)
            const mean = values => values.reduce((total, value) => total + value, 0) / values.length
            const accuracy = reviews.map(item => item.accuracy)
            const harmonic = accuracy.includes(0) ? 0 : 1 / mean(accuracy.map(value => 1 / value))
            return { color, accuracy: (harmonic + mean(accuracy)) / 2,
              acpl: mean(reviews.flatMap(item => item.cpLoss === null ? [] : [item.cpLoss])), esl: mean(reviews.map(item => item.loss)) }
          })
          const plies = game.reviews.map(({ before, played, after, category, depth, critical, reliable, explanation, motif }) =>
            ({ before: [before.kind, before.value], played: [played.kind, played.value], after: [after.kind, after.value],
              best: before.pv[0], wdl: played.wdl, category, depth, critical, reliable, explanation, motif }))
          return { ...window.bench, metrics, plies, engine: game.reviews.find(item => item.before.engine)?.before.engine }
        }, name)
        const { lag, ...measurements } = data
        lag.sort((a, b) => a - b)
        const final = resources(profile)
        const result = { mode, name, tailPlies, seconds, requestedWorkers, cores, mobile, memoryGiB, energy,
          cpuSeconds: (final.cpu - idle.cpu) / cpuHz, activeRatio: data.activeMs / (seconds * 1000),
          lagP95Ms: lag[Math.floor(lag.length * .95)], lagMaxMs: lag.at(-1),
          previewSeconds: data.phases.preview === undefined ? undefined : data.phases.preview / 1000,
          criticalSeconds: data.phases.final === undefined || data.phases.critical === undefined ? undefined : (data.phases.final - data.phases.critical) / 1000,
          nps: Math.round(data.nodes / seconds), activeNps: Math.round(data.nodes * 1000 / data.activeMs), idlePssKiB: idle.pss, peakPssKiB: Math.max(peakPss, final.pss), ...measurements }
        const warmStart = performance.now()
        await page.reload()
        await page.getByRole('button', { name: 'Анализ готов' }).waitFor({ timeout: 15_000 })
        result.cachedMs = performance.now() - warmStart
        result.cachedSearches = await page.evaluate(() => window.bench.searches)
        appendFileSync(output, JSON.stringify(result) + '\n')
        console.log(mode, name, seconds.toFixed(1) + 's', 'preview=' + result.previewSeconds?.toFixed(2), 'workers=' + data.peakWorkers, data.searches + ' searches', data.nodes + ' nodes')
      } finally { clearInterval(sample) }
      await page.goto(url + '/#home')
    }
  } finally {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
