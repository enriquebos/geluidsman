import { useEffect, useState } from 'react'
import './loading.css'

export function Loading({ label = 'Loading current data', rows = 4, shape = 'rows' }: { label?: string; rows?: number; shape?: 'rows' | 'settings' | 'editor' | 'chart' | 'downloads' | 'storage' }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 180); return () => clearTimeout(timer) }, [])
  return <div className={`loading-layout loading-${shape}`} aria-busy="true"><span className="sr-only" role="status">{label}…</span><div aria-hidden="true" className={visible ? 'loading-decoration visible' : 'loading-decoration'}>{Array.from({ length: rows }, (_, index) => <div className="loading-row" key={index}>{shape === 'downloads' ? <><div className="loading-download-title"><i /><div><span /><span /></div></div><span className="loading-download-origin" /><span className="loading-download-status" /><span className="loading-download-size" /><span className="loading-download-actions" /></> : <><i /><span /><b /></>}</div>)}</div></div>
}
export function LoadError({ error, retry }: { error: string; retry: () => unknown }) { return <div className="notice error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void retry()}>Retry</button></div> }
