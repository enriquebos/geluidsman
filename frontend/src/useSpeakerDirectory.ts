import { useMemo } from 'react'
import { useResource } from './confirmedResources'
import { directoryPath } from './navigationLoading'

export type Speaker = { id: string; name: string; avatar?: string | null }
export function useSpeakerDirectory(_endpoint: string, participants: Speaker[]) {
  const result = useResource<{ items: Speaker[] }>(directoryPath())
  return useMemo(() => new Map([...(result.data?.items || []), ...participants].map(person => [person.id, person])), [result.data, participants])
}
