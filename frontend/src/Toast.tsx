import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'

export function Toast({ text, error, onClose }: { text: string; error: boolean; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), 6000)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(onClose, 220)
    return () => clearTimeout(timer)
  }, [leaving, onClose])
  return <div role="status" className={`toast ${error ? 'error' : ''} ${leaving ? 'leaving' : ''}`}>{error ? <X size={17} /> : <Check size={17} />}<span>{text}</span><button aria-label="Dismiss notification" onClick={() => setLeaving(true)}><X size={15} /></button></div>
}
