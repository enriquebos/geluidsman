import { memo, useEffect, useRef } from 'react'
import { Volume2, VolumeX } from 'lucide-react'

export const MasterVolume = memo(function MasterVolume({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const previous = useRef(value > 0 ? value : 0.8)
  useEffect(() => { if (value > 0) previous.current = value }, [value])
  const muted = value === 0
  return <div className="master-volume"><button className="icon-button master-volume-toggle" aria-label={muted ? 'Restore master volume' : 'Mute master volume'} title={muted ? 'Restore master volume' : 'Mute master volume'} aria-pressed={muted} onClick={() => { if (value > 0) previous.current = value; onChange(muted ? previous.current : 0) }}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><input aria-label="Bot volume" type="range" min="0" max="1" step="0.01" value={value} onChange={event => onChange(Number(event.target.value))} /><span>{Math.round(value * 100)}%</span></div>
})
