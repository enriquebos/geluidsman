import { mediaURL, Source } from './types'
import { resources } from './confirmedResources'

type Peaks = { peaks: number[] }
const values = new Map<string, { owner: object; result: Promise<Peaks> }>()
window.addEventListener('resource-account-cleared', () => values.clear())
export function waveform(source: Source) {
  const owner = resources()
  const key = JSON.stringify([source.id, source.media_id])
  for (const [id, value] of values) if (value.owner !== owner) values.delete(id)
  const existing = source.media_id && values.get(key)
  if (existing && existing.owner === owner) { values.delete(key); values.set(key, existing); return existing.result }
  const result = fetch(mediaURL(source.id, 'peaks.json', source.media_id), { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('Waveform could not be loaded. Reopen this video to validate its media version.')
    const data = await response.json() as Peaks
    if (!Array.isArray(data.peaks) || data.peaks.length > 200_000) throw new Error('Waveform is too large or invalid.')
    return data
  }).catch(error => { if (values.get(key)?.result === result) values.delete(key); throw error })
  if (source.media_id && owner) { values.set(key, { owner, result }); while (values.size > 8) values.delete(values.keys().next().value!) }
  return result
}
