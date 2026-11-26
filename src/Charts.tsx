import { memo, useId, useMemo, useState, type PointerEvent } from 'react'

const width = 600, height = 122, margin = 11

export const Chart = memo(function Chart({ values, labels, selected, onSelect, center, caption }: {
  values: number[]; labels: string[]; selected?: number; onSelect?: (index: number) => void; center?: number; caption: string
}) {
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const [hover, setHover] = useState<number>()
  const { min, spread, x, y, path } = useMemo(() => {
    let min = 0, max = 100
    if (center === undefined && values.length) {
      min = max = values[0]
      for (const value of values) {
        min = Math.min(min, value)
        max = Math.max(max, value)
      }
    }
    const spread = max - min || 1
    const x = (i: number) => margin + (width - margin * 2) * (values.length === 1 ? .5 : i / (values.length - 1))
    const y = (value: number) => max === min ? height / 2 : height - margin - (height - margin * 2) * (value - min) / spread
    const path = values.map((value, i) => (i ? 'L' : 'M') + x(i) + ',' + y(value)).join('')
    return { min, spread, x, y, path }
  }, [values, center])
  if (!values.length) return <p className="muted">Недостаточно данных.</p>
  const mid = center ?? min
  const indexFor = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(values.length - 1, Math.max(0, Math.round(((event.clientX - rect.left) / rect.width * width - margin) / (width - margin * 2) * (values.length - 1))))
  }
  const active = hover ?? selected
  return <figure className="chart">
    <svg viewBox={'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img" aria-label={caption}
      onPointerMove={event => { if (event.pointerType === 'mouse') setHover(indexFor(event)) }} onPointerLeave={() => setHover(undefined)}
      onPointerUp={event => onSelect?.(indexFor(event))}>
      <defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="#77936B" stopOpacity=".5" /><stop offset="1" stopColor="#77936B" stopOpacity=".04" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(tick => <line key={tick} x1="0" x2={width} y1={y(min + spread * tick / 4)} y2={y(min + spread * tick / 4)} className="gridline" />)}
      <path d={path + 'L' + x(values.length - 1) + ',' + y(mid) + 'L' + x(0) + ',' + y(mid) + 'Z'} fill={'url(#' + id + ')'} />
      <path d={path} fill="none" stroke="#77936B" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      {active !== undefined && values[active] !== undefined && <>
        <line x1={x(active)} x2={x(active)} y1="0" y2={height} stroke="#BC965C" strokeDasharray="4 3" />
        <circle cx={x(active)} cy={y(values[active])} r="4.3" fill="#BC965C" />
      </>}
    </svg>
    <figcaption><span>{labels[0]}</span><span>{active === undefined ? caption : labels[active]}</span><span>{labels.at(-1)}</span></figcaption>
    {onSelect && <input className="chart-range" type="range" min="0" max={values.length - 1} value={selected ?? 0} aria-label="Позиция на графике" onChange={event => onSelect(Number(event.target.value))} />}
  </figure>
})
