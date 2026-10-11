import { useState } from 'react'
import { api } from './types'
import { GooseSketchEditor } from './GooseSketchEditor'
import { useGooseLibrary } from './GooseDrawings'
import { SearchSelect } from './SearchSelect'

const sketches = [{ id: 'smiley', name: 'Smiley' }, { id: 'goose', name: 'Goose portrait' }, { id: 'shrek', name: 'Shrek' }, { id: 'random', name: 'Random scribble' }, { id: 'word', name: 'WAS' }]

export function GoosePage({ onError, onNotify }: { onError: (message: string) => void; onNotify: (message: string) => void }) {
  const { library, saveDrawing, removeDrawing } = useGooseLibrary()
  const [text, setText] = useState('')
  const [sketch, setSketch] = useState('smiley')
  const [busy, setBusy] = useState(false)
  async function send(action: 'message' | 'raid' | 'draw' | 'deliver') {
    if (busy || (['message', 'deliver'].includes(action) && !text.trim())) return
    setBusy(true)
    try {
      await api(`/admin/goose/${action === 'message' ? 'message' : 'action'}`, 'POST', action === 'message' ? { text: text.trim() } : { action, text: text.trim(), sketch: sketches.some(item => item.id === sketch) ? sketch : 'smiley', sketch_id: library.some(item => item.id === sketch) ? sketch : null })
      onNotify(action === 'message' ? 'Goose message sent to connected clients.' : 'Goose action sent to connected clients.')
      if (action === 'message' || action === 'deliver') setText('')
    } catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="settings-panel goose-panel"><header><h2>Goose</h2><p>Silent mischief for everyone with the app open.</p></header><div className="goose-control-row"><div className="goose-control-copy"><h3>Send a message</h3><p>A speech bubble, visible for five seconds.</p></div><form className="goose-message-form" onSubmit={event => { event.preventDefault(); void send('message') }}><input aria-label="Message" placeholder="What should Goose say?" maxLength={30} value={text} disabled={busy} onChange={event => setText(event.target.value)} aria-describedby="goose-message-length" /><div className="goose-message-actions"><span id="goose-message-length">{text.length}/30</span><button type="submit" className="primary-button" disabled={busy || !text.trim()}>Send to all clients</button></div></form></div><div className="goose-control-row"><div className="goose-control-copy"><h3>Goose raid</h3><p>A small flock marches across the screen.</p></div><button className="secondary-button" disabled={busy} onClick={() => void send('raid')}>Start raid</button></div><div className="goose-control-row"><div className="goose-control-copy"><h3>Draw something</h3><p>Goose finishes its activity, then walks over to draw.</p></div><div className="goose-draw-controls"><SearchSelect label="Sketch" hideLabel allowEmpty={false} value={sketch} options={[...sketches, ...library]} onChange={setSketch} /><button className="secondary-button" disabled={busy} onClick={() => void send('draw')}>Draw sketch</button></div></div><GooseSketchEditor selected={library.find(item => item.id === sketch)} onSave={saveDrawing} onDelete={removeDrawing} onError={onError} onNotify={onNotify} /><div className="goose-control-row"><div className="goose-control-copy"><h3>Deliver a message</h3><p>A goose carries your message on a sign, then leaves. Uses the text above.</p></div><button className="secondary-button" disabled={busy || !text.trim()} onClick={() => void send('deliver')}>Deliver message</button></div></section>
}
