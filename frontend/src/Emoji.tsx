import { useState } from 'react'

export function Emoji({ value }: { value: string }) {
  const [failed, setFailed] = useState('')
  const match = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$/.exec(value)
  if (!match) return <>{value}</>
  if (failed === value) return <span title={match[2]}>:{match[2]}:</span>
  return <img className="custom-emoji" src={`https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? 'gif' : 'png'}?size=64`} alt={`:${match[2]}:`} title={match[2]} loading="lazy" onError={() => setFailed(value)} />
}
