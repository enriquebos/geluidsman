import type { CSSProperties } from 'react'

export function ClipVolume({ value, boosted, onChange, label = 'Volume' }: { value: number; boosted: boolean; onChange: (value: number) => void; label?: string }) {
  const limit = boosted ? 10 : 3
  return <label className="clip-volume">{label} · {Math.round(Math.min(value, limit) * 100)}%<span className="clip-volume-track" style={{ '--volume-fill': `${Math.min(value, limit) * 10}%`, '--volume-limit': `${limit * 10}%` } as CSSProperties}><input aria-label={label} type="range" min="0" max="10" step=".05" value={Math.min(value, limit)} onChange={event => onChange(Math.min(limit, Number(event.target.value)))} /></span><span className="clip-volume-scale"><span>0%</span><span>1000%</span></span>{!boosted && <span className="clip-volume-limit">300% limit without boost permission</span>}</label>
}
