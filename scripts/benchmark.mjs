import { Chess } from 'chess.js'
import { chromium } from 'playwright'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { immortal, opera } from '../tests/fixtures.ts'

const [url, output] = process.argv.slice(2)
if (!url || !output) throw new Error('node --import tsx scripts/benchmark.mjs <url> <output.ndjson>')

function memory(profile) {
  const processes = readdirSync('/proc').filter(item => /^\d+$/.test(item)).flatMap(id => {
    try {
      const stat = readFileSync('/proc/' + id + '/stat', 'utf8').split(') ').at(-1).split(' ')
      return [{ id: Number(id), parent: Number(stat[1]) }]
    } catch { return [] }
  })
  const root = processes.find(({ id }) => {
    try { return readFileSync('/proc/' + id + '/cmdline', 'utf8').includes('--user-data-dir=' + profile + '\0') }
    catch { return false }
  })
  if (!root) return 0
  const ids = [root.id]
  let pss = 0
  for (const id of ids) {
    ids.push(...processes.filter(item => item.parent === id).map(item => item.id))
    try { pss += Number(readFileSync('/proc/' + id + '/smaps_rollup', 'utf8').match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) }
    catch { /* A Chromium process exited between samples. */ }
  }
  return pss
}

const { appendFileSync } = await import('node:fs')
const profiles = (process.env.BENCH_MODES ?? 'quick,standard,deep,professional').split(',')
const tailPlies = Number(process.env.BENCH_TAIL ?? 0)
const rawGames = process.env.BENCH_GAMES === 'opera' ? [[opera, 'Morphy']] : [[opera, 'Morphy'], [immortal, 'Anderssen']]
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
for (const mode of profiles) {
  const profile = mkdtempSync(join(tmpdir(), 'chessbench-'))
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    viewport: { width: 402, height: 874 },
  })
  try {
    await context.addInitScript(({ threads }) => {
      localStorage.setItem('chessmind-settings', JSON.stringify({ theme: 'system', nickname: '', engine: { threads, hash: 16 } }))
      const original = Worker.prototype.postMessage
      const observed = new WeakMap()
      window.bench = { searches: 0, nodes: 0, depths: 0 }
      Worker.prototype.postMessage = function (message, ...options) {
        if (typeof message === 'string' && message.startsWith('go ')) {
          let search = observed.get(this)
          if (!search) {
            search = { nodes: 0, depth: 0 }
            observed.set(this, search)
            this.addEventListener('message', ({ data }) => {
              if (typeof data !== 'string') return
              for (const line of data.split('\n')) {
                const nodes = line.match(/\bnodes (\d+)/)?.[1]
                const depth = line.match(/^info depth (\d+)/)?.[1]
                if (nodes) search.nodes = Math.max(search.nodes, Number(nodes))
                if (depth) search.depth = Math.max(search.depth, Number(depth))
                if (line.startsWith('bestmove')) {
                  window.bench.nodes += search.nodes
                  window.bench.depths += search.depth
                }
              }
            })
          }
          search.nodes = search.depth = 0
          window.bench.searches++
        }
        return original.call(this, message, ...options)
      }
    }, { threads })
    const page = context.pages()[0]
    await page.goto(url)
    await page.getByText('Офлайн готов').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'PGN', exact: true }).click()
    await page.getByRole('textbox', { name: 'Текст PGN' }).fill(games.map(([pgn]) => pgn).join('\n\n'))
    await page.getByRole('button', { name: 'Импортировать PGN' }).click()
    for (const [, name] of games) {
      await page.locator('.recent-list button').filter({ hasText: name }).click()
      await page.getByRole('combobox', { name: 'Глубина анализа' }).selectOption(mode)
      await page.evaluate(() => Object.assign(window.bench, { searches: 0, nodes: 0, depths: 0 }))
      const idlePss = memory(profile)
      let peakPss = idlePss
      const sample = setInterval(() => { peakPss = Math.max(peakPss, memory(profile)) }, 1500)
      const start = performance.now()
      try {
        await page.getByRole('button', { name: 'Начать анализ' }).click()
        await page.getByRole('heading', { name: /Итоги партии/ }).waitFor({ timeout: 600_000 })
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
              acpl: mean(reviews.flatMap(item => item.cpLoss === null ? [] : [item.cpLoss])) }
          })
          const plies = game.reviews.map(({ before, played, after, category, depth, critical }) =>
            ({ before: [before.kind, before.value], played: [played.kind, played.value], after: [after.kind, after.value], category, depth, critical }))
          return { ...window.bench, metrics, plies, engine: game.reviews.find(item => item.before.engine)?.before.engine }
        }, name)
        const result = { mode, name, tailPlies, seconds, idlePssKiB: idlePss, peakPssKiB: peakPss, ...data }
        appendFileSync(output, JSON.stringify(result) + '\n')
        console.log(mode, name, seconds.toFixed(1) + 's', data.searches + ' searches', data.nodes + ' nodes')
      } finally { clearInterval(sample) }
      await page.goto(url + '/#home')
    }
  } finally {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
