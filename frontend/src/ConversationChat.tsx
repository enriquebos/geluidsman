import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { can, User } from './types'
import { useConversationMessages } from './conversationMessages'

export type LiveStatus = { enabled: boolean; recording: boolean; can_read_transcript?: boolean; session: { id: string; channel_name: string; started_at: number; ended_at: number | null } | null; participants: { id: string; name: string; avatar: string | null }[] }

export function canReadConversation(user: User, status: LiveStatus | null) {
  return can(user, 'view_conversations') && (status?.can_read_transcript ?? (can(user, 'always_live_conversation') || Boolean(status?.participants.some(person => person.id === user.id))))
}
export function ConversationChat({ user, status, onError }: { user: User; status: LiveStatus; onError: (message: string) => void }) {
  const [newMessages, setNewMessages] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const previous = useRef({ first: '', last: '', height: 0, top: 0 })
  const activeSession = status.enabled ? status.session?.id || '' : ''
  const eligible = canReadConversation(user, status)
  const { messages, older, loadingOlder, denied, error, loadOlder } = useConversationMessages(user.id, activeSession, eligible)
  useEffect(() => { if (error) onError(error) }, [error, onError])
  useEffect(() => { follow.current = true; setNewMessages(false); previous.current = { first: '', last: '', height: 0, top: 0 } }, [activeSession, eligible])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const first = messages[0]?.id || ''
    const last = messages.at(-1)?.id || ''
    const before = previous.current
    if (follow.current) element.scrollTop = element.scrollHeight
    else if (before.first && first !== before.first) element.scrollTop = before.top + element.scrollHeight - before.height
    if (!follow.current && before.last && last !== before.last) setNewMessages(true)
    previous.current = { first, last, height: element.scrollHeight, top: element.scrollTop }
  }, [messages, older, loadingOlder])
  async function showOlder() {
    if (!loadOlder || loadingOlder) return
    follow.current = false
    if (viewport.current) previous.current = { ...previous.current, height: viewport.current.scrollHeight, top: viewport.current.scrollTop }
    await loadOlder()
  }
  if (!eligible) return <p className="notice">Join the bot’s voice channel to read live speech.</p>
  return <section className="settings-panel conversation-chat"><div className="audit-heading"><h2>Live conversation</h2></div>{denied && <p className="notice">Join the bot’s voice channel to read live speech.</p>}<div className="conversation-messages" ref={viewport} role="log" tabIndex={0} aria-label="Conversation transcript" aria-live="polite" onScroll={() => { const element = viewport.current; if (element) { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; previous.current.top = element.scrollTop; if (follow.current) setNewMessages(false) } }}>{older && <button className="secondary-button" disabled={loadingOlder} onClick={() => void showOlder()}>{loadingOlder ? 'Loading older messages…' : 'Older messages'}</button>}{messages.map(message => <article key={message.id} className={`conversation-message ${message.speaker_id === user.id ? 'own-message' : ''}`}>{message.avatar && <img src={message.avatar} alt="" />}<div><div className="conversation-message-heading"><strong>{message.speaker_id === user.id ? 'You' : message.speaker_name}</strong><time dateTime={new Date(message.started_at * 1000).toISOString()}>{new Date(message.started_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><small>{message.language.toUpperCase()}</small></div><p>{message.text.trim() === '***' ? <em>*Raren geluiden*</em> : message.text}</p></div></article>)}{!messages.length && <div className="empty-state"><MessageCircle size={30} /><p>{activeSession ? 'Waiting for speech…' : 'Connect the bot above to start a conversation.'}</p></div>}</div>{newMessages && <button className="secondary-button" onClick={() => { follow.current = true; setNewMessages(false); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }}>New messages</button>}</section>
}
