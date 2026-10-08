import { useEffect } from 'react'
import { useDialogEscape } from './useDialogEscape'
import { X } from 'lucide-react'

export type ActivityDetail = { title: string; status: string; details: Record<string, unknown>; timestamp?: number; actor?: string }

export function ActivityDetails({ value, onClose }: { value: ActivityDetail; onClose: () => void }) {
  const dialog = useDialogEscape(onClose)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button, a[href]') || [])
        const index = controls.indexOf(document.activeElement as HTMLElement)
        event.preventDefault()
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [onClose])
  const url = typeof value.details.url === 'string' && /^https?:\/\//i.test(value.details.url) ? value.details.url : null
  const changes = Array.isArray(value.details.permission_changes) ? value.details.permission_changes as { label: string; before: boolean; after: boolean }[] : null
  const labels: Record<string, string> = { error: 'What went wrong', suggestion: 'What you can do', reason: 'What happened', trigger_id: 'Trigger ID', speaker_id: 'Speaker ID', enabled: 'Recording enabled', days: 'Retention (days)', stage: 'Failed during', job_id: 'Import ID' }
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}><section ref={dialog} className="modal activity-details" role="dialog" aria-modal="true" aria-labelledby="activity-details-title"><div className="modal-heading"><h2 id="activity-details-title">Activity details</h2><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={20} /></button></div><h3>{value.title}</h3><dl><dt>Result</dt><dd>{value.status}</dd>{value.actor && <><dt>User</dt><dd>{value.actor}</dd></>}{value.timestamp && <><dt>When</dt><dd>{new Date(value.timestamp * 1000).toLocaleString()}</dd></>}{url && <><dt>Source</dt><dd><a href={url} target="_blank" rel="noreferrer">{url}</a></dd></>}{Object.entries(labels).map(([key, label]) => value.details[key] !== undefined ? <div key={key}><dt>{label}</dt><dd>{String(value.details[key])}</dd></div> : null)}</dl>{changes && <div className="permission-audit"><h3>Permission changes</h3>{changes.length ? <ul>{changes.map(change => <li key={change.label}><strong>{change.label}</strong><span>{change.before ? 'Allowed' : 'Denied'} → {change.after ? 'Allowed' : 'Denied'}</span></li>)}</ul> : <p>No effective permissions changed.</p>}</div>}<button className="secondary-button" onClick={onClose}>Close</button></section></div>
}
