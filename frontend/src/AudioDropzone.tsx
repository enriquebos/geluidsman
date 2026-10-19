import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'

export function AudioDropzone({ file, disabled, accept, label, hint, limits, onChoose }: { file: File | null; disabled: boolean; accept: string; label: string; hint: string; limits: string; onChoose: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return <>
    <input ref={input} className="upload-file-input" type="file" tabIndex={-1} accept={accept} aria-label={label} disabled={disabled} onChange={event => { onChoose(Array.from(event.target.files || [])); event.target.value = '' }} />
    <button type="button" className={`audio-dropzone ${dragging && !disabled ? 'dragging' : ''}`} disabled={disabled} onClick={() => input.current?.click()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); input.current?.click() } }} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); if (!disabled) onChoose(Array.from(event.dataTransfer.files)) }}><Upload size={28} aria-hidden="true" /><strong>{file ? file.name : 'Drop your audio here'}</strong><span>{file ? 'Click or drop to choose another file' : hint}</span><small>{limits}</small></button>
  </>
}
