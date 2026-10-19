import { Heart, ListMusic } from 'lucide-react'

export function PlaylistArtwork({ playlist }: { playlist: { liked?: boolean; tracks?: { thumbnail?: string | null }[]; artwork?: string[] } }) {
  if (playlist.liked) return <span className="music-playlist-artwork music-liked-artwork"><Heart size={34} fill="currentColor" /></span>
  const covers = [...new Set([...(playlist.tracks || []).map(track => track.thumbnail).filter((thumbnail): thumbnail is string => Boolean(thumbnail)), ...(playlist.artwork || [])])].slice(0, 4)
  return <span className={`music-playlist-artwork ${covers.length > 1 ? 'mosaic' : ''}`}>{covers.length ? covers.map(source => <img key={source} loading="lazy" decoding="async" src={source} alt="" referrerPolicy="no-referrer" />) : <ListMusic size={34} />}</span>
}
