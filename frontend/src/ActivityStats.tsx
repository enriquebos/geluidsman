import { ThemedSelect } from './ThemedSelect'
import { useResource } from './confirmedResources'
import { activityPath, useNavigationState } from './navigationLoading'
import { Loading, LoadError } from './Loading'

type Activity = { leaderboard: { user_id: string; name: string; avatar: string | null; created: number; played: number }[]; series: { timestamp: number; played: number }[]; total_played: number }

export function ActivityStats({ onError: _onError }: { onError: (message: string) => void }) {
  const [period, setPeriod] = useNavigationState('hall-period', '1')
  const [sort, setSort] = useNavigationState<'played' | 'created'>('hall-sort', 'played')
  const activity = useResource<Activity>(activityPath(period))
  const ranking = useResource<{ leaderboard: Activity['leaderboard'] }>(`/audit/leaderboard?sort=${sort}`)
  const data = activity.data
  const leaders = ranking.data?.leaderboard || []
  const loading = !data && !activity.error
  const rankingLoading = !ranking.data && !ranking.error
  const rows = [...leaders].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name))
  const max = Math.max(1, ...(data?.series.map(point => point.played) ?? []))
  const label = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(undefined, period === '1' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })
  return <div className="audit-page hall-of-shame"><section className="settings-panel activity-stats" aria-busy={rankingLoading}>
    <div className="audit-heading"><h2>All-time sound leaderboard</h2><button className="secondary-button" disabled={loading || rankingLoading} onClick={() => { void activity.refresh(); void ranking.refresh() }}>Refresh statistics</button></div>
    <p>Most sounds created and played across all recorded activity.</p>
    <div className="activity-sort"><button type="button" className="secondary-button" aria-pressed={sort === 'played'} onClick={() => setSort('played')}>Most played</button><button type="button" className="secondary-button" aria-pressed={sort === 'created'} onClick={() => setSort('created')}>Most created</button></div>
    {ranking.error ? <LoadError error={ranking.error} retry={ranking.refresh} /> : rankingLoading ? <Loading label="Loading leaderboard" /> : null}<div className="leaderboard-table"><table aria-label="Sound leaderboard"><thead><tr><th scope="col">Rank</th><th scope="col">User</th><th scope="col">Sounds created</th><th scope="col">Sounds played</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.user_id}><td>{index + 1}</td><th scope="row"><span className="leaderboard-user">{row.avatar ? <img src={row.avatar} alt="" /> : <span className="audit-avatar audit-initial">{row.name.slice(0, 1)}</span>}{row.name}</span></th><td>{row.created.toLocaleString()}</td><td>{row.played.toLocaleString()}</td></tr>)}</tbody></table></div>
    {ranking.data && !rows.length && <p role="status">{rankingLoading ? 'Loading statistics…' : 'No sounds created or played yet.'}</p>}
  </section><section className="settings-panel activity-chart" aria-busy={loading}>
    <div className="audit-heading"><h2>Playback activity</h2><div className="activity-period"><label>Activity period<ThemedSelect aria-label="Activity period" value={period} onChange={selected => setPeriod(selected)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></ThemedSelect></label></div></div>
    {activity.error ? <LoadError error={activity.error} retry={activity.refresh} /> : !data ? <Loading label="Loading playback figures" shape="chart" /> : <><div className="activity-chart-heading"><h3>Sounds played</h3><span>{data?.total_played.toLocaleString() ?? 0} plays</span></div>
    <div className="play-count-chart" aria-label="Playback count graph"><div className="chart-scale"><span>{max}</span><span>0</span></div><div className="chart-plot">{data?.series.map(point => <div className="chart-column" key={point.timestamp}><button type="button" className="chart-bar" style={{ height: `${Math.max(2, point.played / max * 100)}%` }} aria-label={`${label(point.timestamp)}: ${point.played} plays`} title={`${label(point.timestamp)}: ${point.played} plays`}><span className="chart-tooltip">{label(point.timestamp)} · {point.played} plays</span></button></div>)}</div></div>
    {data?.series.length ? <div className="chart-time-labels"><span>{label(data.series[0].timestamp)}</span><span>{label(data.series[Math.floor(data.series.length / 2)].timestamp)}</span><span>{label(data.series[data.series.length - 1].timestamp)}</span></div> : null}
  </>}</section></div>
}
