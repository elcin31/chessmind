import { Chess } from 'chess.js'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'

await mkdir('public/engine', { recursive: true })
for (const name of await readdir('node_modules/stockfish/bin')) {
  if (/^stockfish-19(?:-lite(?:-single)?|-single)\.(?:js|wasm)$/.test(name)) {
    await cp('node_modules/stockfish/bin/' + name, 'public/engine/' + name)
  }
}
await cp('node_modules/stockfish/Copying.txt', 'public/engine/Copying.txt')
const packages = ['chess.js', 'react', 'react-dom', 'scheduler', 'idb', 'lucide-react']
const notices = await Promise.all(packages.map(async name =>
  name + '\n\n' + await readFile('node_modules/' + name + '/LICENSE', 'utf8')))
await writeFile('public/legal/dependencies.txt', notices.join('\n\n' + '-'.repeat(65) + '\n\n'))
const openings = {}
const graph = {}
const variants = []
const keyFor = fen => fen.split(' ').slice(0, 4).join(' ')
for (const section of ['a', 'b', 'c', 'd', 'e']) {
  const content = await readFile('data/' + section + '.tsv', 'utf8')
  for (const row of content.trim().split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t')
    const chess = new Chess()
    chess.loadPgn(pgn)
    const history = chess.history({ verbose: true })
    variants.push([eco, name, pgn])
    const keys = history.map(move => {
      const before = keyFor(move.before)
      const after = keyFor(move.after)
      const branches = graph[before] ??= {}
      branches[move.san] = after
      return after
    })
    keys.forEach(key => { openings[key] ??= true })
    const key = keys.at(-1)
    if (key && (!Array.isArray(openings[key]) || openings[key][2].length > pgn.length)) openings[key] = [eco, name, pgn]
  }
}
await writeFile('public/eco.json', JSON.stringify(openings))

await writeFile('public/opening-tree.json', JSON.stringify({ graph, variants }))
