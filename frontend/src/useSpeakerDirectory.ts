import { useEffect, useMemo, useState } from 'react'
import { api } from './types'

export type Speaker = { id: string; name: string; avatar?: string | null }
export function useSpeakerDirectory(endpoint: string, participants: Speaker[]) {
  const [users, setUsers] = useState<Speaker[]>([])
  useEffect(() => {
    let alive = true
    void api<{ items: Speaker[] }>(endpoint).then(data => { if (alive) setUsers(data.items) }).catch(() => {})
    return () => { alive = false }
  }, [endpoint])
  return useMemo(() => new Map([...users, ...participants].map(person => [person.id, person])), [users, participants])
}
