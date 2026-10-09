import { ThemedSelect } from './ThemedSelect'
import { ReactNode, useEffect, useState } from 'react'
import { api, Clip } from './types'
import { SearchSelect } from './SearchSelect'

export type TriggerSettings = { action?: 'play' | 'stop_all'; clip_id: string; target: 'everyone' | 'self' | 'selected'; speakers: string[]; delay?: number; cooldown: number; mode?: 'word' | 'contains' }

type Props = { value: TriggerSettings; clips: Clip[]; participants: { id: string; name: string }[]; onChange: (change: Partial<TriggerSettings>) => void; matching?: boolean; grouped?: boolean; eventField?: ReactNode; usersEndpoint?: string }

export function TriggerOptions({ value, clips, participants, onChange, matching = false, grouped = false, eventField, usersEndpoint = '/conversation/users' }: Props) {
  const [users, setUsers] = useState<{ id: string; name: string; avatar?: string | null }[]>([])
  const [userError, setUserError] = useState('')
  useEffect(() => {
    if (value.target !== 'selected') return
    let alive = true
    void api<{ items: typeof users }>(usersEndpoint).then(data => { if (alive) { setUsers(data.items); setUserError('') } }).catch(error => { if (alive) setUserError((error as Error).message) })
    return () => { alive = false }
  }, [value.target, usersEndpoint])
  const peopleById = new Map([...users, ...participants].map(person => [person.id, person]))
  const matchMode = matching && <label>Match mode<ThemedSelect aria-label="Match mode" value={value.mode} onChange={selected => onChange({ mode: selected as TriggerSettings['mode'] })}><option value="word">Whole word / phrase</option><option value="contains">Contains text</option></ThemedSelect></label>
  const action = <><label>Action<ThemedSelect aria-label="Trigger action" value={value.action || 'play'} onChange={selected => onChange({ action: selected as TriggerSettings['action'] })}><option value="play">Play sound</option><option value="stop_all">Stop all sounds</option></ThemedSelect></label>{value.action !== 'stop_all' && <SearchSelect label="Trigger sound" value={value.clip_id} options={clips.map(clip => ({ id: clip.id, name: clip.name, emoji: clip.emoji }))} onChange={clip_id => onChange({ clip_id })} placeholder="Choose a sound" />}</>
  const people = <><label>Speakers<ThemedSelect aria-label="Speakers" value={value.target} onChange={selected => onChange({ target: selected as TriggerSettings['target'] })}><option value="everyone">Everyone</option><option value="self">Creator only</option><option value="selected">Selected speakers</option></ThemedSelect></label>{value.target === 'selected' && <div className="speaker-selection"><SearchSelect label="Select speakers" value="" values={value.speakers} allowEmpty={false} options={[...peopleById.values(), ...value.speakers.filter(id => !peopleById.has(id)).map(id => ({ id, name: id }))]} placeholder="Choose speakers" onChange={() => {}} onToggle={id => onChange({ speakers: value.speakers.includes(id) ? value.speakers.filter(value => value !== id) : value.speakers.length < 64 ? [...value.speakers, id] : value.speakers })} />{userError && <p role="alert">{userError}</p>}</div>}</>
  const timing = <><label>Delay (seconds)<input type="number" min="0" max="60" step="0.1" value={value.delay || 0} onChange={event => onChange({ delay: Number(event.target.value) })} /></label><label>Cooldown (seconds)<input type="number" min="0" max="3600" step="0.5" value={value.cooldown} onChange={event => onChange({ cooldown: Number(event.target.value) })} /></label></>
  if (grouped) return <div className="action-form-sections"><section className="action-form-section"><h3>When</h3>{eventField}{matchMode}</section><section className="action-form-section"><h3>Who</h3>{people}</section><section className="action-form-section"><h3>Then</h3>{action}</section><section className="action-form-section"><h3>Timing</h3><p>Delay waits before running. Cooldown limits how often this rule can run across all participants.</p><div className="action-timing-fields">{timing}</div></section></div>
  return <div className="trigger-options">{action}{matchMode}{people}{timing}</div>
}
