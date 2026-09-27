/**
 * Dashboard Page — Main SOC Overview
 * Layout matches the provided design screenshot exactly.
 */
import { useStore } from '../lib/store'
import Globe from '../components/dashboard/Globe'
import LiveAlertFeed from '../components/dashboard/LiveAlertFeed'
import MitreMatrix from '../components/dashboard/MitreMatrix'
import AutonomousLoop from '../components/dashboard/AutonomousLoop'
import { StatCard } from '../components/ui'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'
import { useEffect, useRef, useState } from 'react'

// System uptime sparkline data (rolling 60 points)
function useUptimeHistory(uptimeSeconds) {
  const [history, setHistory] = useState(() =>
    Array.from({ length: 30 }, (_, i) => ({ t: i, v: 85 + Math.random() * 15 }))
  )
  const frameRef = useRef(0)

  useEffect(() => {
    frameRef.current++
    if (frameRef.current % 5 !== 0) return  // update every 5 seconds
    const v = 90 + Math.random() * 9.5
    setHistory(h => [...h.slice(-59), { t: Date.now(), v }])
  }, [uptimeSeconds])

  return history
}

export default function Dashboard() {
  const { state } = useStore()
  const { stats, uptimeSeconds } = state
  const uptimeHistory = useUptimeHistory(uptimeSeconds)

  const uptimePercent = 98.4  // TODO: compute from actual uptime when backend exposes it

  return (
    <div className="h-full flex flex-col gap-3 p-3 md:p-4 overflow-y-auto lg:overflow-hidden dot-grid">
      {/* Top row: Globe (left, 2/3) + Alert Feed (right, 1/3) */}
      <div className="flex flex-col lg:flex-row gap-3 lg:flex-[2] min-h-0">
        <div className="flex-1 lg:flex-[2] min-h-[300px] lg:min-h-0">
          <Globe />
        </div>
        <div className="w-full lg:w-80 shrink-0 h-[300px] lg:h-auto">
          <LiveAlertFeed />
        </div>
      </div>

      {/* Middle row: Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
        <StatCard
          label="TOTAL ALERTS"
          value={stats.total_alerts}
          delta="12%"
          deltaDir="up"
          color="primary"
          barFill={0.6}
        />
        <StatCard
          label="CRITICAL"
          value={stats.critical_count}
          delta="4%"
          deltaDir="up"
          color="critical"
          barFill={stats.total_alerts > 0 ? stats.critical_count / stats.total_alerts : 0}
        />
        <StatCard
          label="FALSE POSITIVES (TRIAGED)"
          value={stats.false_positive_count}
          color="warning"
          barFill={stats.total_alerts > 0 ? stats.false_positive_count / stats.total_alerts : 0}
        />
        <StatCard
          label="TRUE POSITIVES (TRIAGED)"
          value={stats.true_positive_count}
          color="critical"
          barFill={stats.total_alerts > 0 ? stats.true_positive_count / stats.total_alerts : 0}
        />
        <StatCard
          label="AVG RESOLUTION (SEC)"
          value={stats.avg_resolution_seconds != null ? Math.round(stats.avg_resolution_seconds) : null}
          color="success"
          barFill={0.15}
        />
      </div>

      {/* Bottom row: MITRE + Loop + Uptime */}
      <div className="flex flex-col lg:flex-row gap-3 lg:flex-1 min-h-0">
        <div className="flex-1 min-h-[250px] lg:min-h-0">
          <MitreMatrix />
        </div>
        <div className="w-full lg:w-72 shrink-0 flex flex-col gap-3 pb-4 lg:pb-0">
          <AutonomousLoop />
          {/* System Uptime Chart */}
          <div className="card h-40 lg:flex-1 p-4 flex flex-col gap-2">
            <div className="flex items-end justify-between">
              <p className="mono-label">System Uptime</p>
              <span className="text-2xl font-bold font-mono text-secondary">
                {uptimePercent}%
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={uptimeHistory}>
                  <Line
                    type="monotone"
                    dataKey="v"
                    stroke="#7dffa2"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Tooltip
                    contentStyle={{ background: '#161c23', border: '1px solid #404752', borderRadius: 8 }}
                    labelStyle={{ color: '#8a919e' }}
                    itemStyle={{ color: '#7dffa2' }}
                    formatter={(v) => [`${v.toFixed(1)}%`, 'Uptime']}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
