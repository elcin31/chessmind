import type { ComputeSource } from './cloudProtocol'

export const computeLabels = { local: 'На устройстве', cloud: 'В облаке', auto: 'Автоматически' } as const

export function ComputeSelect({ value, onChange, disabled }: {
  value: ComputeSource; onChange: (value: ComputeSource) => void; disabled?: boolean
}) {
  return <select aria-label="Источник вычислений" value={value} disabled={disabled}
    onChange={event => onChange(event.target.value as ComputeSource)}>
    {Object.entries(computeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
  </select>
}
