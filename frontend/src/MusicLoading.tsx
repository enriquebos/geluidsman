import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

function Placeholder({ children, label }: { children: ReactNode; label: string }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 180); return () => clearTimeout(timer) }, [])
  return <div className="music-validation-placeholder"><span className="sr-only" role="status">{label}</span><div aria-hidden="true" className={`music-placeholder-decoration${visible ? ' visible' : ''}`}>{children}</div></div>
}
export function MusicValidated({ ready, error = '', label, skeleton, children }: { ready: boolean; error?: string; label: string; skeleton: ReactNode; children?: ReactNode }) {
  return <div className={`music-validation-frame${children ? ' has-content' : ''}`} aria-busy={!ready && !error} data-retained-layout={children && !ready ? true : undefined}><div className="music-confirmed-body" aria-hidden={!ready || undefined} inert={!ready} style={!ready ? { visibility: 'hidden' } : undefined}>{children}</div>{!ready && !error && <Placeholder label={label}>{skeleton}</Placeholder>}</div>
}
export function PlaylistHeroSkeleton() {
  return <header className="music-playlist-hero music-hero-skeleton"><span className="music-playlist-artwork music-skeleton-block" /><div><span className="music-kicker music-skeleton-block">&nbsp;</span><h1><span className="music-skeleton-block">&nbsp;</span></h1><p><strong className="music-skeleton-block">&nbsp;</strong><span className="music-skeleton-block">&nbsp;</span></p><small className="music-skeleton-block">&nbsp;</small></div></header>
}
export function PlaylistLibrarySkeleton({ count = 4 }: { count?: number }) {
  return <div className="music-library-skeleton">{Array.from({ length: Math.max(1, Math.min(12, count)) }, (_, index) => <div className="music-library-item" key={index}><span className="music-playlist-artwork music-skeleton-block" /><span><strong className="music-skeleton-block">&nbsp;</strong><small className="music-skeleton-block">&nbsp;</small><small className="music-skeleton-block">&nbsp;</small></span></div>)}</div>
}
export function PlaylistSkeleton({ count = 6 }: { count?: number }) {
  if (!count) return <div className="music-empty music-empty-skeleton"><span className="music-skeleton-block" /><h2 className="music-skeleton-block">&nbsp;</h2><p className="music-skeleton-block">&nbsp;</p></div>
  return <><div className="music-playlist-columns"><span>#</span><span>Title</span></div><div className="music-tracks music-playlist-skeleton" aria-hidden="true">{Array.from({ length: Math.min(8, Math.max(1, count)) }, (_, index) => <div className="music-track music-playlist-track music-skeleton-row" key={index}><span className="music-playlist-play"><span className="music-skeleton-block music-skeleton-number" /></span><span className="music-artwork music-skeleton-block" /><span className="music-track-text"><span className="music-skeleton-title music-skeleton-block" /><span className="music-skeleton-artist music-skeleton-block" /></span><span className="music-playlist-save" /><span className="music-skeleton-duration music-skeleton-block" /><span className="music-skeleton-action" /></div>)}</div></>
}
