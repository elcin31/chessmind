const { parentPort } = require('node:worker_threads')
const start = require('stockfish/bin/stockfish-19-lite-single.js')

const engine = start()
engine.listener = line => parentPort.postMessage(line)
parentPort.on('message', command => engine.processCommand(command))
