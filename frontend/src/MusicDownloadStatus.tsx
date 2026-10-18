import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, Clock3, Download, LoaderCircle } from 'lucide-react'
import type { MusicCacheStatus } from './Music'

export function MusicDownloadStatus({ cache, title }: { cache: MusicCacheStatus; title: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const id = useId()
  const label = cache.state === 'cached' ? 'Downloaded' : cache.state === 'downloading' ? 'Downloading' : cache.state === 'failed' ? 'Download failed' : 'Waiting to download'
  const message = cache.state === 'failed' ? cache.error || 'Download failed. Try downloading this recording again.' : cache.state === 'downloading' ? 'Downloading this recording in the background.' : cache.state === 'cached' ? 'Downloaded and ready to play.' : 'Waiting to download this recording.'
  const Icon = cache.state === 'failed' ? CircleAlert : cache.state === 'downloading' ? LoaderCircle : cache.state === 'queued' ? Clock3 : Download
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const bounds = tooltip.current?.getBoundingClientRect()
      if (!anchor || !bounds) return
      const left = Math.max(8, Math.min(anchor.x + anchor.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8))
      const top = Math.max(8, anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6)
      setPosition(previous => previous.top === top && previous.left === left ? previous : { top, left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, message])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <><button ref={trigger} type="button" className={`icon-button music-download-status ${cache.state}`} aria-label={`${label}: ${title}`} aria-describedby={open ? id : undefined} onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true) }} onPointerLeave={() => { if (document.activeElement !== trigger.current) setOpen(false) }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) } }}><Icon size={14} className={cache.state === 'downloading' ? 'spin' : undefined} /></button>{open && createPortal(<div ref={tooltip} id={id} role="tooltip" className="music-download-tooltip" style={position}>{message}</div>, document.body)}</>
}
