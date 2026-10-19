import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleDot, Info, LoaderCircle } from 'lucide-react'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function SettingRow({ label, description, htmlFor, children, className = '' }: { label: string; description?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  const Copy = htmlFor ? 'label' : 'div'
  return <div className={`setting-row ${className}`}><Copy className="setting-copy" htmlFor={htmlFor}><strong>{label}</strong>{description && <small>{description}</small>}</Copy><div className="setting-control">{children}</div></div>
}

export function SettingsFeedback({ label, state = 'idle', dirty = false, automatic = false, error, idleText, pendingText = 'Saving…', savedText = 'Saved', children }: { label: string; state?: SaveState; dirty?: boolean; automatic?: boolean; error?: string; idleText?: string; pendingText?: string; savedText?: string; children?: ReactNode }) {
  const kind = state === 'saving' || state === 'error' ? state : dirty ? 'dirty' : state
  const Icon = kind === 'saving' ? LoaderCircle : kind === 'error' ? CircleAlert : kind === 'dirty' ? CircleDot : kind === 'saved' ? CircleCheck : Info
  const message = kind === 'saving' ? pendingText : kind === 'error' ? error || 'Could not save changes. Try again.' : kind === 'dirty' ? 'Unsaved changes' : kind === 'saved' ? savedText : idleText || (automatic ? 'Changes apply automatically.' : 'No unsaved changes.')
  return <div className={`settings-feedback ${kind}`}><p role="status" aria-label={label}><Icon size={17} className={kind === 'saving' ? 'spin' : undefined} /><span>{message}{kind === 'error' && dirty ? ' Unsaved changes remain.' : ''}{automatic && kind === 'saved' ? ' · Changes apply automatically.' : ''}</span></p>{children && <div className="settings-feedback-actions">{children}</div>}</div>
}
