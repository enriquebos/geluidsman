import { useEffect, useRef, useState } from 'react'
import { api, FunSettings } from './types'
import { liveEvents } from './liveEvents'

const items: { key: 'flashbang' | 'vine_boom' | 'sus' | 'dvd' | 'goose' | 'kirby'; name: string; description: string }[] = [
  { key: 'flashbang', name: 'Flashbang', description: 'The protected Flashbang sound whites out the page 600 ms after playback starts, then fades.' },
  { key: 'vine_boom', name: 'Vine boom', description: 'The protected Vine boom sound briefly zooms and shakes the page with The Rock.' },
  { key: 'sus', name: 'SUS', description: 'The protected SUS sound sends a red crewmate floating from left to right.' },
  { key: 'goose', name: 'Goose', description: 'A silent goose wanders, doodles and gets up to mischief, occasionally investigating or chasing your cursor.' },
  { key: 'kirby', name: 'Kirby anti-spam', description: 'Kirby inhales a spammer’s soundboard across their devices and pauses manual playback for five seconds. Existing sounds continue.' },
  { key: 'dvd', name: 'DVD screensaver', description: 'A silent bouncing DVD logo celebrates corner hits with confetti.' },
]

export function FunPage({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const [settings, setSettings] = useState<FunSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  useEffect(() => {
    let active = true
    void api<FunSettings>('/admin/fun').then(data => { if (active) setSettings(data) }).catch(error => { if (active) onError(error.message) })
    const events = liveEvents()
    events.addEventListener('fun.settings', event => setSettings(JSON.parse((event as MessageEvent).data)))
    return () => { active = false; events.close() }
  }, [onError])
  async function save(changes: Partial<FunSettings>) {
    if (!settings || saving.current) return
    saving.current = true
    const previous = settings
    const next = { ...settings, ...changes }
    setSettings(next); setBusy(true)
    try { setSettings(await api<FunSettings>('/admin/fun', 'PUT', next)); onNotify('Fun settings updated.') }
    catch (error) { setSettings(previous); onError((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }
  return <section className="settings-panel"><h2>Fun</h2><p>Sound effects affect app viewers in the bot's voice channel. DVD and Goose are shared, silent screen effects. Kirby only affects the account spamming manual playback. Browser previews do not trigger effects.</p>{items.map(item => <div className="permission-row fun-option" key={item.key}><span className="permission-copy"><strong>{item.name}</strong><span>{item.description}</span></span><div className="fun-option-controls">{item.key === 'kirby' && <div className="kirby-settings">{([{ key: 'kirby_threshold', label: 'Play attempts', max: 100, fallback: 20 }, { key: 'kirby_window', label: 'Within seconds', max: 60, fallback: 5 }] as const).map(field => <label key={field.key}>{field.label}<input type="number" aria-label={field.label} min={1} max={field.max} step={1} key={settings?.[field.key]} defaultValue={settings?.[field.key] ?? field.fallback} disabled={!settings || busy} onBlur={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= field.max) { if (value !== settings?.[field.key]) void save({ [field.key]: value }) } else event.target.value = String(settings?.[field.key] ?? field.fallback) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>)}</div>}{item.key === 'dvd' && <label className="dvd-speed">Speed<input type="number" aria-label="DVD speed" min={0.25} max={5} step={0.25} defaultValue={settings?.dvd_speed ?? 1} key={settings?.dvd_speed ?? 1} disabled={!settings || busy} onBlur={event => { const value = Number(event.target.value); if (value >= 0.25 && value <= 5) void save({ dvd_speed: value }); else event.target.value = String(settings?.dvd_speed ?? 1) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /><span>&times;</span></label>}<input className="permission-switch" type="checkbox" role="switch" aria-label={item.name} checked={Boolean(settings?.[item.key])} disabled={!settings || busy} onChange={() => void save({ [item.key]: !settings?.[item.key] })} /></div></div>)}</section>
}
