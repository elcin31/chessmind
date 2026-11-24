import { useMemo, useState } from 'react'
import type { Color } from 'chess.js'
import { budgets } from './engine'
import { Chart } from './Charts'
import { readClocks } from './pgn'
import { OpeningTree } from './OpeningTree'
import { analysisKey, displayDate, gameMoves, isComplete, playerColor, timeLabel, type Game } from './library'
import { Empty, number, percent } from './ReviewScreen'
import { average, categories, errors, expectation, phases, summarize, type Phase } from './review'

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
  const [profile, setProfile] = useState('')
  const [rolling, setRolling] = useState(10)
  const own = games.filter(game => playerColor(game, nickname) && (!source || game.source === source))
  const profiles = new Map(own.filter(isComplete).map(game => [analysisKey(game), game]))
  const current = profiles.has(profile) ? profile : [...profiles.keys()].sort().at(-1) ?? ''
  const complete = own.filter(game => isComplete(game) && analysisKey(game) === current)
  const sides = complete.map(game => ({ game, color: playerColor(game, nickname)! }))
  const playerReviews = sides.flatMap(({ game, color }) => game.reviews!.filter(move => move.color === color))
  const report = summarize(playerReviews)
  const actualEngines = new Set(playerReviews.flatMap(move => move.before.engine ? [move.before.engine] : []))
  const [wins, draws, losses] = record(own, nickname)
  const chronological = sides.filter(({ game }) => game.date)
    .sort((first, second) => first.game.date.localeCompare(second.game.date) || (first.game.timestamp ?? 0) - (second.game.timestamp ?? 0))
    .map(({ game, color }) => ({ game, report: summarize(game.reviews!, color) }))
  const accuracy = chronological.flatMap(({ game, report }) => report.accuracy === undefined ? [] : [{ game, value: report.accuracy }])
  const rollingAccuracy = accuracy.slice(rolling - 1).map(({ game }, index) => ({
    game, value: average(accuracy.slice(index, index + rolling).map(item => item.value))!,
  }))
  const acpl = chronological.flatMap(({ game, report }) => report.acpl === undefined ? [] : [{ game, value: report.acpl }])
  const decisions = playerReviews.filter(move => !move.forced)
  const mistake = (category: typeof decisions[number]['category']) => errors.includes(category)
  const heatmap = Array.from({ length: 8 }, (_, index) => {
    const lower = index * 5 + 1
    const moves = decisions.filter(move => {
      const ply = Math.floor(move.index / 2) + 1
      return ply >= lower && (index === 7 || ply < lower + 5)
    })
    return { label: index === 7 ? '36+' : lower + '–' + (lower + 4), trials: moves.length,
      errors: moves.filter(move => mistake(move.category)).length }
  })
  const skills = Object.entries(phases).map(([phase, label]) => {
    const all = decisions.filter(move => move.phase === phase)
    const half = Math.floor(chronological.length / 2)
    const period = (items: typeof chronological) => {
      const keys = new Set(items.map(item => item.game.id))
      return sides.filter(item => keys.has(item.game.id)).flatMap(({ game, color }) =>
        game.reviews!.filter(move => move.color === color && move.phase === phase && !move.forced))
    }
    const previous = period(chronological.slice(0, half)), recent = period(chronological.slice(-half || chronological.length))
    return { label, trials: all.length, errors: all.filter(move => mistake(move.category)).length,
      previous: previous.length >= 12 ? average(previous.map(move => move.loss)) : undefined,
      recent: recent.length >= 12 ? average(recent.map(move => move.loss)) : undefined }
  }).sort((a, b) => (b.errors / (b.trials || 1)) - (a.errors / (a.trials || 1)))
  const timed = useMemo(() => sides.flatMap(({ game, color }) => {
    if (!/%clk|%emt/.test(game.pgn)) return []
    const clock = readClocks(game.pgn, gameMoves(game), game.time)
    return game.reviews!.flatMap(move => move.color === color && !move.forced && clock[move.index]?.spent !== undefined ?
      [{ spent: clock[move.index].spent!, loss: move.loss }] : [])
  }), [games, current, source, nickname])
  const opportunities = (winning: boolean) => sides.filter(({ game, color }) => game.reviews!.some(move => move.color === color &&
    move.depth >= 12 && (winning ? expectation(move.before, color) >= 85 : expectation(move.before, color) <= 15)))
  const ahead = opportunities(true), behind = opportunities(false)
  const converted = ahead.filter(({ game, color }) => outcome(game, color) === 1).length
  const saved = behind.filter(({ game, color }) => outcome(game, color) >= 0).length
  const strengths = [...skills].reverse().find(item => item.trials >= 20 && item.errors / item.trials <= 0.15)
  const plan = skills.filter(item => item.trials >= 20 && item.errors >= 3).slice(0, 2)

  const rates = own.filter(game => game.date).sort((first, second) => first.date.localeCompare(second.date)).flatMap(game => {
    const value = playerColor(game, nickname) === 'w' ? game.whiteElo : game.blackElo
    return value === undefined ? [] : [{ game, value }]
  })
  const motifs = Object.entries(playerReviews.filter(move => errors.includes(move.category) && move.motif)
    .reduce<Record<string, number>>((acc, move) => { acc[move.motif!] = (acc[move.motif!] ?? 0) + 1; return acc }, {})).sort((a, b) => b[1] - a[1])
  const byOpening = groups(own.filter(game => game.opening), nickname, game => game.opening!.slice(0, 2).join(' '))
  const successful = [...byOpening].sort((first, second) => second.score - first.score || second.games.length - first.games.length)
  const qualityGroups = (key: (game: Game, color: Color) => string) => {
    const entries = new Map<string, { games: number; lines: typeof playerReviews }>()
    for (const { game, color } of sides) {
      const name = key(game, color)
      const group = entries.get(name) ?? { games: 0, lines: [] }
      group.games++
      for (const move of game.reviews!) if (move.color === color) group.lines.push(move)
      entries.set(name, group)
    }
    return [...entries].sort((a, b) => b[1].games - a[1].games).slice(0, 12)
  }
  const groupsTable = (title: string, rows: ReturnType<typeof groups>) => <section className="panel"><h3>{title}</h3><table>
    <thead><tr><th>Группа</th><th>Партий</th><th>В / Н / П</th><th>Очки</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}>
      <td>{row.label}</td><td>{row.games.length}</td><td>{row.win} / {row.draw} / {row.loss}</td><td>{percent(row.score * 100)}</td>
    </tr>)}</tbody></table>{!rows.length && <p className="muted">Недостаточно данных.</p>}</section>

  return <>
    <div className="filters"><label>Источник <select value={source} onChange={event => setSource(event.target.value)}>
      <option value="">Все источники</option><option value="chesscom">Chess.com</option><option value="lichess">Lichess</option><option value="pgn">PGN</option>
    </select></label>{profiles.size > 0 && <label>Профиль анализа <select value={current} onChange={event => setProfile(event.target.value)}>
      {[...profiles].map(([key, game]) => <option key={key} value={key}>{(game.methodology ?? 1) + '.0 · ' + budgets[game.mode ?? 'standard'].label + ' · ' + key.split(':').slice(2).join(' / ')}</option>)}
    </select></label>}</div>
    {!own.length ? <div className="panel"><Empty title="Недостаточно партий" message="Импортируйте историю своего аккаунта или укажите никнейм для партий PGN в настройках." /></div> : <>
      <div className="kpis"><div className="panel"><span>Партий игрока</span><strong>{own.length}</strong></div>
        <div className="panel"><span>Проанализировано</span><strong>{complete.length}</strong></div>
        <div className="panel"><span>В / Н / П</span><strong>{Math.round(wins / own.length * 100)}% / {Math.round(draws / own.length * 100)}% / {Math.round(losses / own.length * 100)}%</strong></div></div>
      <p className="muted">Качество ходов рассчитано по выбранному профилю, {complete.length} партий из {own.length}. Результаты партий учитывают весь выбранный источник.</p>
      {actualEngines.size > 1 && <p className="notice">В профиле есть анализы разных сборок или числа потоков Stockfish · {[...actualEngines].join(', ')}.</p>}
      <div className="stats-grid">
        <section className="panel"><h3>Динамика рейтинга</h3>
          {!source && new Set(rates.map(item => item.game.source)).size > 1 ? <p className="muted">Выберите источник, чтобы сравнивать рейтинги одной платформы.</p> :
            <Chart values={rates.map(item => item.value)} labels={rates.map(item => displayDate(item.game.date) + ' · ' + item.value)} onSelect={index => open(rates[index].game)} caption={rates.length + ' партий с рейтингом'} />}</section>
        <section className="panel"><h3>Динамика точности</h3><Chart values={accuracy.map(item => item.value)} labels={accuracy.map(item => displayDate(item.game.date) + ' · ' + percent(item.value))} onSelect={index => open(accuracy[index].game)} caption={accuracy.length + ' проанализированных партий'} /></section>
        <section className="panel"><div className="list-heading"><h3>Скользящая точность</h3><select aria-label="Окно точности" value={rolling} onChange={event => setRolling(Number(event.target.value))}>
          {[10, 20, 50].map(item => <option key={item}>{item}</option>)}</select></div>
          <Chart values={rollingAccuracy.map(item => item.value)} labels={rollingAccuracy.map(item => displayDate(item.game.date) + ' · ' + percent(item.value))} onSelect={index => open(rollingAccuracy[index].game)} caption={'Среднее за ' + rolling + ' партий'} /></section>
        <section className="panel"><h3>Динамика ACPL</h3><Chart values={acpl.map(item => item.value)} labels={acpl.map(item => displayDate(item.game.date) + ' · ' + number(item.value))} onSelect={index => open(acpl[index].game)} caption={acpl.length + ' партий с числовыми оценками'} /></section>
        <section className="panel"><h3>Ошибки по номеру хода</h3><div className="heatmap">
          {heatmap.map(row => <div key={row.label} style={{ background: row.trials ? 'color-mix(in srgb, #c87850 ' + (10 + 85 * row.errors / row.trials) + '%, var(--surface))' : undefined }}>
            <strong>{row.label}</strong><small>{row.errors}/{row.trials}</small></div>)}
        </div><p className="muted">Ошибки / решения. Номер отсчитывается от начала импортированной записи.</p></section>
        <section className="panel"><h3>Реализация и защита</h3><p>Выигрыш из позиций с ожидаемым результатом ≥85% · {converted}/{ahead.length}.</p>
          <p>Ничья или выигрыш из позиций с ожидаемым результатом ≤15% · {saved}/{behind.length}.</p><p className="muted">В каждой группе партия учитывается один раз. Минимальная глубина позиции 12.</p></section>
        <section className="panel"><h3>Время и качество решений</h3>{timed.length ? <table><thead><tr><th>Время</th><th>Ходов</th><th>Средняя потеря</th></tr></thead>
          <tbody>{[5, 15, 30, Infinity].map((upper, index) => {
            const lower = [0, 5, 15, 30][index]
            const entries = timed.filter(item => item.spent >= lower && item.spent < upper)
            return <tr key={lower}><td>{Number.isFinite(upper) ? lower + '–' + upper + ' с' : '≥30 с'}</td><td>{entries.length}</td><td>{number(average(entries.map(item => item.loss)))}</td></tr>
          })}</tbody></table> : <p className="muted">Время на ход отсутствует в импортированных партиях.</p>}</section>
        <section className="panel"><h3>Распределение категорий</h3><table><tbody>{Object.entries(categories).map(([key, [label]]) =>
          <tr key={key}><td>{label}</td><td>{report.counts[key as keyof typeof categories]}</td></tr>)}</tbody></table></section>
        <section className="panel"><h3>Персональный тренер</h3>
          <table><thead><tr><th>Фаза</th><th>Ошибки</th><th>Потеря раньше / недавно</th></tr></thead><tbody>{skills.map(item =>
            <tr key={item.label}><td>{item.label}</td><td>{item.errors}/{item.trials}</td><td>{number(item.previous)} / {number(item.recent)}</td></tr>)}</tbody></table>
          {complete.length >= 5 && strengths && <p>Меньше ошибок в фазе «{strengths.label}» · {strengths.errors} из {strengths.trials} решений.</p>}
          {complete.length >= 5 && plan.length ? <><h4>План на неделю</h4><ol>
            <li>Пн и Вт · повторите трудные позиции, фаза «{plan[0].label}». Ошибок {plan[0].errors} из {plan[0].trials} решений.</li>
            <li>Ср и Чт · {motifs[0] && motifs[0][1] >= 3 ? 'отработайте мотив «' + motifs[0][0] + '» (' + motifs[0][1] + ' случаев)' : 'решите новые позиции из той же фазы'}.</li>
            <li>Пт и выходные · завершите дневную подборку и пересмотрите главные ошибки в свежей партии.</li>
          </ol><a href="#training">В центр тренировок</a></> : <p className="muted">Для плана нужно минимум пять партий и повторяющиеся ошибки в одной фазе.</p>}
        </section>
        <section className="panel"><h3>Качество по времени и цвету</h3><table><thead><tr><th>Группа</th><th>Партий</th><th>Точность</th><th>ACPL</th></tr></thead>
          <tbody>{[...qualityGroups((_, color) => color === 'w' ? 'Белые' : 'Чёрные'), ...qualityGroups(game => timeLabel(game.time))]
            .map(([key, group]) => {
              const summary = summarize(group.lines)
              return <tr key={key}><td>{key}</td><td>{group.games}</td><td>{percent(summary.accuracy)}</td><td>{number(summary.acpl)}</td></tr>
            })}</tbody></table></section>
        {groupsTable('Результаты по цвету', groups(own, nickname, game => playerColor(game, nickname) === 'w' ? 'Белые' : 'Чёрные'))}
        {source && source !== 'pgn' && groupsTable('Рейтинг соперника', groups(own.filter(game =>
          (playerColor(game, nickname) === 'w' ? game.blackElo : game.whiteElo) !== undefined), nickname, game => {
            const rating = (playerColor(game, nickname) === 'w' ? game.blackElo : game.whiteElo)!
            const base = Math.floor(rating / 200) * 200
            return base + '–' + (base + 199)
          }))}
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
    <OpeningTree games={games} />
    <h2>Дебюты в библиотеке</h2>
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
      const profile = own.find(isComplete)
      const openingMoves = profile ? own.filter(game => isComplete(game) && analysisKey(game) === analysisKey(profile))
        .flatMap(game => game.reviews!.filter(move => move.color === playerColor(game, nickname) && move.phase === 'opening')) : []
      return <details key={label} className="panel"><summary><b>{label}</b><span>{items.length} партий</span></summary>
        <p>{items[0].opening![2]}</p><p className="muted">Личный результат (В / Н / П): {own.length ? win + ' / ' + draw + ' / ' + loss : '—'}</p>
        {own.length > 0 && <p>Победы {percent(win * 100 / own.length)} · точность дебюта {percent(summarize(openingMoves).accuracy)} ({openingMoves.length} ходов).</p>}
        {early.length > 0 && <h4>Ранние ошибки · {early.length} партий</h4>}
        <div className="action-row">{early.slice(0, 8).map(({ game, move }) => <button key={game.id} onClick={() => open(game, move.index + 1)}>
          {gameMoves(game)[move.index].san} · {game.white} – {game.black}</button>)}</div>
      </details>
    })}</div>
  </>
}
