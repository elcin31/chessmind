import { useState } from 'react'
import { ArrowDownToLine, ArrowRight, ClipboardPaste, FileUp, Globe2, RefreshCw } from 'lucide-react'
import { db, importAccount, importPgn, type Game, type Source } from './library'

export function ImportForm({ nickname, onNickname, onSaved }: { nickname: string; onNickname: (name: string) => void; onSaved: (games: Game[]) => void }) {
  const [source, setSource] = useState<Source>('chesscom')
  const [name, setName] = useState(nickname)
  const [pgn, setPgn] = useState('')
  const [active, setActive] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  async function run(older = false, file?: File) {
    if (active) return
    setActive(true)
    setFailed(false)
    setMessage('Обрабатываем партии…')
    try {
      const account = name.trim()
      const result = source === 'pgn' || file ? await importPgn(file ? await file.text() : pgn) :
        await importAccount(source, account, setMessage, older)
      if (!file && source !== 'pgn') onNickname(account)
      setMessage('Добавлено: ' + result.added + ' · Уже сохранено: ' + result.skipped + (result.invalid ? ' · Пропущено: ' + result.invalid : '') + ('warning' in result && result.warning ? ' · ' + result.warning : ''))
      if (result.added) setPgn('')
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'Не удалось импортировать партии.')
    } finally {
      try { onSaved(await (await db).getAll('games')) } catch { setFailed(true); setMessage('Локальная база недоступна.') }
      setActive(false)
    }
  }
  return <div className="panel import-panel" id="import">
    <div className="card-head"><div className="section-icon"><ArrowDownToLine size={21} /></div><div>
      <h2>Импорт партий</h2><p>Добавьте завершённую партию или историю аккаунта</p>
    </div></div>
    <div className="tabs" aria-label="Источник партии">
      {([['chesscom','Chess.com'],['lichess','Lichess'],['pgn','PGN']] as const).map(([id, label]) => <button key={id} aria-pressed={source === id} disabled={active} onClick={() => { setSource(id); setMessage('') }}>
        {id === 'pgn' && <ClipboardPaste size={15} />}{label}</button>)}
    </div>
    <form onSubmit={event => { event.preventDefault(); void run() }}>
      {source === 'pgn' ? <>
        <label className="field">Текст PGN<textarea value={pgn} onChange={event => setPgn(event.target.value)} placeholder={'[Event "…"]\n1. e4 e5 …'} rows={5} /></label>
        <div className="action-row"><button className="primary" disabled={active || !pgn.trim()}>Импортировать PGN</button>
          <label className="upload"><FileUp size={16} /> Загрузить файл<input aria-label="Загрузить файл PGN" disabled={active} type="file" accept=".pgn,.txt,application/x-chess-pgn" onChange={event => {
            const file = event.target.files?.[0]
            if (file) void run(false, file)
            event.target.value = ''
          }} /></label></div>
      </> : <>
        <label className="field">Никнейм на {source === 'chesscom' ? 'Chess.com' : 'Lichess'}
          <input value={name} onChange={event => setName(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Введите никнейм" maxLength={40} required /></label>
        <button className="primary import-submit" disabled={active || !name.trim()}><ArrowDownToLine size={16} /> {nickname ? 'Обновить историю' : 'Импортировать историю'} <ArrowRight size={16} className="end-icon" /></button>
        {nickname && <button className="quiet" type="button" onClick={() => void run(true)} disabled={active || !name.trim()}><RefreshCw size={15} /> Загрузить более ранние партии</button>}
      </>}
    </form>
    {message && <p role="status" className={'notice ' + (failed ? 'bad' : '')}>{message}</p>}
    {source !== 'pgn' && !message && <div className="import-note"><Globe2 size={15} /> Общедоступные архивы · Регистрация не нужна</div>}
  </div>
}
