import { useUnsavedWork } from './useUnsavedWork'
import { useSettingsDraft } from './useSettingsDraft'
import { Loading, LoadError } from './Loading'
import { SettingsFeedback, SaveState } from './SettingsControls'
import { useRef, useState } from 'react'
import { api, FunSettings } from './types'

const items: { key: 'flashbang' | 'vine_boom' | 'sus' | 'patapim' | 'tung_sahur' | 'skibidi' | 'spion' | 'dvd' | 'goose' | 'kirby'; name: string; description: string }[] = [
  { key: 'flashbang', name: 'Flashbang', description: 'The protected Flashbang sound whites out the page 600 ms after playback starts, then fades.' },
  { key: 'vine_boom', name: 'Vine boom', description: 'The protected Vine boom sound briefly zooms and shakes the page with The Rock.' },
  { key: 'sus', name: 'SUS', description: 'The protected SUS sound sends a red crewmate floating from left to right.' },
  { key: 'patapim', name: 'Brr Brr Patapim', description: 'The protected BRR OPSTAAN sound sends a leafy, big-footed Patapim walking across the screen.' },
  { key: 'tung_sahur', name: 'Tung sahur', description: 'The protected Tung sahur sound brings in the wooden character, who swings his bat and cracks the screen before leaving.' },
  { key: 'skibidi', name: 'Skibidi Toilet', description: 'The protected Skibidi sound brings up a toilet with a bobbing, twisting meme head.' },
  { key: 'spion', name: 'Spion', description: 'The protected Spion sound plays the supplied animation once in the center, disappearing after five seconds independently of the sound.' },
  { key: 'goose', name: 'Goose', description: 'A silent goose wanders, doodles and gets up to mischief, occasionally investigating or chasing your cursor.' },
  { key: 'kirby', name: 'Kirby anti-spam', description: 'Kirby inhales a spammer’s soundboard across their devices and pauses manual playback for five seconds. Existing sounds continue.' },
  { key: 'dvd', name: 'DVD screensaver', description: 'A silent bouncing DVD logo celebrates corner hits with confetti.' },
]

export function FunPage({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const result = useSettingsDraft<FunSettings>('/admin/fun')
  const settings = result.data
  const setSettings = result.setData
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const saving = useRef(false)
  useUnsavedWork(result.dirty || busy)
  async function save(changes: Partial<FunSettings>) {
    if (!settings || !result.current || saving.current) return
    saving.current = true
    setSaveState('saving'); setSaveError('')
    const next = { ...settings, ...changes }
    setSettings(next); setBusy(true)
    try { result.accept(await api<FunSettings>('/admin/fun', 'PUT', next)); setSaveState('saved'); onNotify('Fun settings updated.') }
    catch (error) { setSettings(null); setSaveState('error'); setSaveError((error as Error).message); onError((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }
  if (!settings) return <section className="settings-panel"><h2>Screen effects</h2>{result.error ? <LoadError error={result.error} retry={result.refresh} /> : <Loading label="Loading Fun settings" shape="settings" />}</section>
  return <section className="settings-panel"><h2>Screen effects</h2><p>Sound effects affect app viewers in the bot's voice channel. DVD and Goose are shared, silent screen effects. Kirby only affects the account spamming manual playback. Browser previews do not trigger effects.</p>{result.error ? <LoadError error={result.error} retry={result.refresh} /> : !result.current ? <Loading label="Validating Fun settings" shape="settings" /> : null}<div hidden={!result.current}>{items.map(item => <div className="permission-row fun-option" key={item.key}><span className="permission-copy"><strong>{item.name}</strong><span>{item.description}</span></span><div className="fun-option-controls">{item.key === 'kirby' && <div className="kirby-settings">{([{ key: 'kirby_threshold', label: 'Play attempts', max: 100, fallback: 20 }, { key: 'kirby_window', label: 'Within seconds', max: 60, fallback: 5 }] as const).map(field => <label key={field.key}>{field.label}<input type="number" aria-label={field.label} min={1} max={field.max} step={1} value={Number.isFinite(settings[field.key]) ? settings[field.key] : ''} onChange={event => setSettings({ ...settings, [field.key]: event.target.value ? Number(event.target.value) : NaN })} disabled={!settings || busy} onBlur={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= field.max) { if (value !== result.current?.[field.key]) void save({ [field.key]: value }) } else setSettings(null) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>)}</div>}{item.key === 'dvd' && <label className="dvd-speed">Speed<input type="number" aria-label="DVD speed" min={0.25} max={5} step={0.25} value={Number.isFinite(settings.dvd_speed) ? settings.dvd_speed : ''} onChange={event => setSettings({ ...settings, dvd_speed: event.target.value ? Number(event.target.value) : NaN })} disabled={!settings || busy} onBlur={event => { const value = Number(event.target.value); if (value >= 0.25 && value <= 5) void save({ dvd_speed: value }); else setSettings(null) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /><span>&times;</span></label>}<input className="permission-switch" type="checkbox" role="switch" aria-label={item.name} checked={Boolean(settings?.[item.key])} disabled={!settings || busy} onChange={() => void save({ [item.key]: !settings?.[item.key] })} /></div></div>)}</div><SettingsFeedback label="Fun settings save status" state={saveState} error={saveError} automatic /></section>
}
