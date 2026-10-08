import { useEffect, useRef, useState } from 'react'
import { api } from './types'

type Activity = { leaderboard: { user_id: string; name: string; avatar: string | null; created: number; played: number }[]; series: { timestamp: number; played: number }[]; total_played: number }

export function ActivityStats({ onError }: { onError: (message: string) => void }) {
  const [period, setPeriod] = useState('1')
  const [sort, setSort] = useState<'played' | 'created'>('played')
  const [data, setData] = useState<Activity | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const cache = useRef(new Map<string, Activity>())
  const displayedPeriod = useRef(period)
  useEffect(() => {
    let alive = true
    const end = new Date()
    end.setHours(24, 0, 0, 0)
    const start = new Date(end)
    start.setDate(start.getDate() - Number(period))
    const params = new URLSearchParams({ after: String(start.getTime() / 1000), until: String(end.getTime() / 1000), bucket_seconds: period === '1' ? '3600' : '86400', sort })
    const key = params.toString()
    const cached = cache.current.get(key)
    if (cached) {
      setData(cached)
      setLoading(false)
      displayedPeriod.current = period
      return
    }
    setLoading(true)
    if (displayedPeriod.current !== period) setData(null)
    displayedPeriod.current = period
    api<Activity>(`/audit/activity?${params}`).then(result => { if (alive) { cache.current.set(key, result); setData(result) } }).catch(error => { if (alive) onError(error.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [period, sort, revision, onError])
  const rows = [...(data?.leaderboard ?? [])].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name))
  const max = Math.max(1, ...(data?.series.map(point => point.played) ?? []))
  const label = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(undefined, period === '1' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })
  return <section className="settings-panel activity-stats" aria-busy={loading}>
    <div className="audit-heading"><h2>Sound leaderboard</h2><div className="activity-period"><label>Activity period<select aria-label="Activity period" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label><button className="secondary-button" disabled={loading} onClick={() => { cache.current.clear(); setRevision(value => value + 1) }}>Refresh statistics</button></div></div>
    <p>Successful sound creations and Discord plays in this period. Counts depend on retained audit history.</p>
    <div className="activity-sort"><button type="button" className="secondary-button" aria-pressed={sort === 'played'} onClick={() => setSort('played')}>Most played</button><button type="button" className="secondary-button" aria-pressed={sort === 'created'} onClick={() => setSort('created')}>Most created</button></div>
    <div className="leaderboard-table"><table aria-label="Sound leaderboard"><thead><tr><th scope="col">Rank</th><th scope="col">User</th><th scope="col">Sounds created</th><th scope="col">Sounds played</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.user_id}><td>{index + 1}</td><th scope="row"><span className="leaderboard-user">{row.avatar ? <img src={row.avatar} alt="" /> : <span className="audit-avatar audit-initial">{row.name.slice(0, 1)}</span>}{row.name}</span></th><td>{row.created.toLocaleString()}</td><td>{row.played.toLocaleString()}</td></tr>)}</tbody></table></div>
    {!rows.length && <p role="status">{loading ? 'Loading statistics…' : 'No sounds created or played in this period.'}</p>}
    <div className="activity-chart-heading"><h3>Sounds played</h3><span>{data?.total_played.toLocaleString() ?? 0} plays</span></div>
    <div className="play-count-chart" aria-label="Playback count graph"><div className="chart-scale"><span>{max}</span><span>0</span></div><div className="chart-plot">{data?.series.map(point => <div className="chart-column" key={point.timestamp}><button type="button" className="chart-bar" style={{ height: `${Math.max(2, point.played / max * 100)}%` }} aria-label={`${label(point.timestamp)}: ${point.played} plays`} title={`${label(point.timestamp)}: ${point.played} plays`}><span className="chart-tooltip">{label(point.timestamp)} · {point.played} plays</span></button></div>)}</div></div>
    {data?.series.length ? <div className="chart-time-labels"><span>{label(data.series[0].timestamp)}</span><span>{label(data.series[Math.floor(data.series.length / 2)].timestamp)}</span><span>{label(data.series[data.series.length - 1].timestamp)}</span></div> : null}
  </section>
}
