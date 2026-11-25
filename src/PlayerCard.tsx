import { memo, useEffect, useRef, useState } from 'react'
import type { Color } from 'chess.js'
import { ArrowRight, UserRound } from 'lucide-react'
import { displayDate, isComplete, playerColor, timeLabel, type Game } from './library'
import { profileRetryAt, profileSource, requestProfile, type ProfileSource } from './playerProfiles'
import { hasPreview } from './progressive'
import { summarize } from './review'

const percent = (value?: number) => value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%'

function useAvatar(source: ProfileSource | undefined, name: string) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [data, setData] = useState<{ url?: string; title?: string }>()
  useEffect(() => {
    if (!source || !anchor.current) return
    let live = true
    let objectUrl: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      void requestProfile(source, name).then(profile => {
        if (!live) return
        if (!profile) {
          const wait = profileRetryAt(source) - Date.now()
          if (wait > 0) timer = setTimeout(load, Math.min(wait + 100, 2_147_000_000))
          return
        }
        if (profile.image) objectUrl = URL.createObjectURL(profile.image)
        setData({ url: objectUrl ?? profile.avatar, title: profile.title })
      }).catch(() => {})
    }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer?.disconnect()
        // Give an in-flight archive import time to finish before profile requests.
        timer = setTimeout(load, 120)
      }
    }, { rootMargin: '48px' }) : undefined
    if (observer) observer.observe(anchor.current)
    else load()
    return () => {
      live = false
      observer?.disconnect()
      clearTimeout(timer)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source, name])
  return { anchor, data }
}

export const PlayerBadge = memo(function PlayerBadge({ source, name, rating, color, owner, accuracy }: {
  source?: ProfileSource; name: string; rating?: number; color: Color; owner?: boolean; accuracy?: string
}) {
  const { anchor, data } = useAvatar(source, name)
  const [broken, setBroken] = useState('')
  const label = color === 'w' ? 'Белые' : 'Чёрные'
  return <span className={'player-badge' + (owner ? ' is-owner' : '')} data-color={color} data-owner={owner || undefined}>
    <span className="avatar-frame" ref={anchor}>
      {data?.url && broken !== data.url ? <img src={data.url} alt="" width="30" height="30" loading="lazy" decoding="async"
        referrerPolicy="no-referrer" onError={() => setBroken(data.url!)} /> : <UserRound size={17} aria-hidden="true" />}
      <span className={'player-stone ' + (color === 'w' ? 'white' : 'black')} role="img" aria-label={label} />
    </span>
    <span className="player-detail"><span className="player-name">{data?.title && <small className="player-title">{data.title}</small>}{name}</span>
      <span className="player-numbers"><span aria-label={'Elo в партии ' + (rating ?? 'нет данных')}>{rating ?? '—'}</span>
        {owner && <small>Ваш профиль</small>}
        {accuracy !== undefined && <span className="player-accuracy" aria-label={'Точность ' + accuracy}>{accuracy}</span>}
      </span>
    </span>
  </span>
})

export const GameCard = memo(function GameCard({ game, nickname, open, recent = false }: {
  game: Game; nickname: string; open: (game: Game) => void; recent?: boolean
}) {
  const complete = isComplete(game)
  const owner = playerColor(game, nickname)
  const source = profileSource(game)
  const status = game.queued ? 'В очереди' : complete ? 'Разобрана' : game.reviews?.length || (game.compute === 'cloud' ? game.cloudDraft?.work : game.draft?.work) ? 'Приостановлена' : hasPreview(game) ? 'Предварительный разбор' : 'Без анализа'
  return <button className={'game-row compact-game' + (recent ? ' compact-game-recent' : '')} onClick={() => open(game)}
    aria-label={game.white + ' – ' + game.black + ' · ' + game.result + ' · ' + status}>
    <span className="game-match">
      <PlayerBadge key={'w:' + game.white} source={source} name={game.white} color="w" rating={game.whiteElo} owner={owner === 'w'}
        accuracy={complete ? percent(summarize(game.reviews!, 'w').accuracy) : undefined} />
      <PlayerBadge key={'b:' + game.black} source={source} name={game.black} color="b" rating={game.blackElo} owner={owner === 'b'}
        accuracy={complete ? percent(summarize(game.reviews!, 'b').accuracy) : undefined} />
    </span>
    <span className="game-facts"><span><b>{game.result}</b><small>{status}</small></span>
      <span><small>{displayDate(game.date)}</small><small>{timeLabel(game.time)}</small></span></span>
    {!recent && <span className="game-opening"><b>{game.opening?.slice(0, 2).join(' ') || 'Дебют неизвестен'}</b><small>{game.moves} полуходов</small></span>}
    <ArrowRight size={16} aria-hidden="true" />
  </button>
})
