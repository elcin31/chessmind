import { useMemo, useState } from 'react'
import type { Color } from 'chess.js'
import { Chart } from './Charts'
import { displayDate, gameMoves, isComplete, playerColor, timeLabel, type Game } from './library'
import { Empty, number, percent } from './ReviewScreen'
import { average, errors, phases, summarize, type Phase } from './review'

function outcome(game: Game, color: Color) {
  return game.result === '1/2-1/2' ? 0 : (game.result === '1-0') === (color === 'w') ? 1 : -1
}
function record(games: Game[], nickname: string) {
  const results = games.map(game => outcome(game, playerColor(game, nickname)!))
  return [1, 0, -1].map(value => results.filter(result => result === value).length)
}
function groups(games: Game[], nickname: string, key: (game: Game) => string) {
  const entries = new Map<string, Game[]>()
  for (const game of games) {
    const label = key(game)
    const list = entries.get(label) ?? []
    list.push(game)
    entries.set(label, list)
  }
  return [...entries].map(([label, games]) => {
    const [win, draw, loss] = record(games, nickname)
    return { label, games, win, draw, loss, score: (win + draw / 2) / games.length }
  }).sort((first, second) => second.games.length - first.games.length)
}

export function Statistics({ games, nickname, open }: { games: Game[]; nickname: string; open: (game: Game) => void }) {
  const [source, setSource] = useState('')
  const own = games.filter(game => playerColor(game, nickname) && (!source || game.source === source))
  const complete = own.filter(isComplete)
  const sides = complete.map(game => ({ game, color: playerColor(game, nickname)! }))
  const playerReviews = sides.flatMap(({ game, color }) => game.reviews!.filter(move => move.color === color))
  const report = summarize(playerReviews)
  const [wins, draws, losses] = record(own, nickname)
  const accuracy = sides.filter(({ game }) => game.date).sort((first, second) => first.game.date.localeCompare(second.game.date))
    .flatMap(({ game, color }) => {
      const value = summarize(game.reviews!, color).accuracy
      return value === undefined ? [] : [{ game, value }]
    })
  const rates = own.filter(game => game.date).sort((first, second) => first.date.localeCompare(second.date)).flatMap(game => {
    const value = playerColor(game, nickname) === 'w' ? game.whiteElo : game.blackElo
    return value === undefined ? [] : [{ game, value }]
  })
  const motifs = Object.entries(playerReviews.filter(move => errors.includes(move.category) && move.motif)
    .reduce<Record<string, number>>((acc, move) => { acc[move.motif!] = (acc[move.motif!] ?? 0) + 1; return acc }, {})).sort((a, b) => b[1] - a[1])
  const byOpening = groups(own.filter(game => game.opening), nickname, game => game.opening!.slice(0, 2).join(' '))
  const successful = [...byOpening].sort((first, second) => second.score - first.score || second.games.length - first.games.length)
  const groupsTable = (title: string, rows: ReturnType<typeof groups>) => <section className="panel"><h3>{title}</h3><table>
    <thead><tr><th>Группа</th><th>Партий</th><th>В / Н / П</th><th>Очки</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}>
      <td>{row.label}</td><td>{row.games.length}</td><td>{row.win} / {row.draw} / {row.loss}</td><td>{percent(row.score * 100)}</td>
    </tr>)}</tbody></table>{!rows.length && <p className="muted">Недостаточно данных.</p>}</section>

  return <>
    <div className="filters"><label>Источник <select value={source} onChange={event => setSource(event.target.value)}>
      <option value="">Все источники</option><option value="chesscom">Chess.com</option><option value="lichess">Lichess</option><option value="pgn">PGN</option>
    </select></label></div>
    {!own.length ? <div className="panel"><Empty title="Недостаточно партий" message="Импортируйте историю своего аккаунта или укажите никнейм для партий PGN в настройках." /></div> : <>
      <div className="kpis"><div className="panel"><span>Партий игрока</span><strong>{own.length}</strong></div>
        <div className="panel"><span>Проанализировано</span><strong>{complete.length}</strong></div>
        <div className="panel"><span>В / Н / П</span><strong>{Math.round(wins / own.length * 100)}% / {Math.round(draws / own.length * 100)}% / {Math.round(losses / own.length * 100)}%</strong></div></div>
      <div className="stats-grid">
        <section className="panel"><h3>Динамика рейтинга</h3>
          {!source && new Set(rates.map(item => item.game.source)).size > 1 ? <p className="muted">Выберите источник, чтобы сравнивать рейтинги одной платформы.</p> :
            <Chart values={rates.map(item => item.value)} labels={rates.map(item => displayDate(item.game.date) + ' · ' + item.value)} onSelect={index => open(rates[index].game)} caption={rates.length + ' партий с рейтингом'} />}</section>
        <section className="panel"><h3>Динамика точности</h3><Chart values={accuracy.map(item => item.value)} labels={accuracy.map(item => displayDate(item.game.date) + ' · ' + percent(item.value))} onSelect={index => open(accuracy[index].game)} caption={accuracy.length + ' проанализированных партий'} /></section>
        {groupsTable('Результаты по цвету', groups(own, nickname, game => playerColor(game, nickname) === 'w' ? 'Белые' : 'Чёрные'))}
        {groupsTable('Контроль времени', groups(own, nickname, game => timeLabel(game.time)).slice(0, 15))}
        {groupsTable('Успешные дебюты', successful.slice(0, 5))}
        {groupsTable('Проблемные дебюты', [...successful].reverse().slice(0, 5))}
        <section className="panel"><h3>Качество игры <span className="muted">· {complete.length} партий</span></h3><table><tbody>
          <tr><td>ACPL ({report.cpSample} ходов)</td><td>{number(report.acpl)}</td></tr>
          <tr><td>Грубых ошибок на партию</td><td>{number(complete.length ? report.counts.blunder / complete.length : undefined)}</td></tr>
          {(Object.keys(phases) as Phase[]).map(phase => {
            const phaseReport = summarize(playerReviews, undefined, phase)
            return <tr key={phase}><td>{phases[phase]} ({phaseReport.sample} ходов)</td><td>{percent(phaseReport.accuracy)}</td></tr>
          })}</tbody></table></section>
        <section className="panel"><h3>Тактические ошибки</h3>
          {motifs.length ? <><table><tbody>{motifs.slice(0, 7).map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td></tr>)}</tbody></table>
            <p className="summary-note">Начните с темы «{motifs[0][0]}»: она встречалась чаще остальных распознанных мотивов. Повторите соответствующие позиции в тренажёре.</p></> :
            <p className="muted">Пока нет подтверждённых мотивов.</p>}</section>
      </div>
    </>}
  </>
}

export function Openings({ games, nickname, open }: { games: Game[]; nickname: string; open: (game: Game, ply?: number) => void }) {
  const [search, setSearch] = useState('')
  const grouped = useMemo(() => {
    const items = new Map<string, Game[]>()
    for (const game of games) {
      if (!game.opening) continue
      const key = game.opening.slice(0, 2).join(' ')
      const list = items.get(key) ?? []
      list.push(game)
      items.set(key, list)
    }
    return [...items].sort((a, b) => b[1].length - a[1].length)
  }, [games])
  return <>
    <div className="filters"><input aria-label="Поиск дебюта" placeholder="Название или код ECO" value={search} onChange={event => setSearch(event.target.value)} /></div>
    {!grouped.length && <div className="panel"><Empty title="Дебюты появятся после импорта" message="ChessMind определяет дебют по достигнутой позиции с учётом перестановки ходов." /></div>}
    <div className="opening-list">{grouped.filter(([label]) => label.toLowerCase().includes(search.toLowerCase())).map(([label, items]) => {
      const own = items.filter(game => playerColor(game, nickname))
      const [win, draw, loss] = record(own, nickname)
      const early = items.flatMap(game => {
        const move = game.reviews?.find(review => review.phase === 'opening' && errors.includes(review.category) &&
          (!playerColor(game, nickname) || review.color === playerColor(game, nickname)))
        return move ? [{ game, move }] : []
      })
      return <details key={label} className="panel"><summary><b>{label}</b><span>{items.length} партий</span></summary>
        <p>{items[0].opening![2]}</p><p className="muted">Личный результат (В / Н / П): {own.length ? win + ' / ' + draw + ' / ' + loss : '—'}</p>
        {early.length > 0 && <h4>Ранние ошибки · {early.length} партий</h4>}
        <div className="action-row">{early.slice(0, 8).map(({ game, move }) => <button key={game.id} onClick={() => open(game, move.index + 1)}>
          {gameMoves(game)[move.index].san} · {game.white} – {game.black}</button>)}</div>
      </details>
    })}</div>
  </>
}
