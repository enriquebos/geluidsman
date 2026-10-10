import { Emoji } from './Emoji'

type Props = { sound: string; emoji: string; target: string; delay: number; cooldown: number; owner?: string; mode?: string }
export function TriggerSummary({ sound, emoji, target, delay, cooldown, owner, mode }: Props) {
  return <div className="trigger-summary"><p><Emoji value={emoji} /> {sound} · {target}{mode ? ` · ${mode}` : ''}</p><div className="trigger-timing">{delay}s delay · {cooldown}s cooldown</div><small>By {owner || 'Unknown user'}</small></div>
}
