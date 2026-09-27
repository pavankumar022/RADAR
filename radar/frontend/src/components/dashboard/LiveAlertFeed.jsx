import React from 'react'
import { useStore } from '../../lib/store'
import { SeverityChip, TechniqueBadge, StatusChip } from '../ui'
import { useNavigate } from 'react-router-dom'

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
  } catch {
    return '??:??:??'
  }
}

const AlertRow = React.memo(({ event }) => {
  const navigate = useNavigate()
  const rowClass = {
    critical: 'alert-row-critical',
    warning: 'alert-row-warning',
    info: 'alert-row-info',
  }[event.severity] ?? 'alert-row-info'

  return (
    <div
      className={`${rowClass} py-2.5 pr-3 hover:bg-surface-high cursor-pointer transition-colors fade-in`}
      onClick={() => navigate(`/incidents/${event.id}`)}
      id={`alert-${event.id?.slice(0, 8)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <SeverityChip severity={event.severity} />
            <span className="font-mono font-bold text-xs text-on-surface tracking-wide">
              {event.event_type}
            </span>
            {(event.source === 'live_capture' || event.raw_payload?.sniffer) && (
              <span className="mono-data text-[9px] px-1.5 py-0.5 bg-critical/20 text-critical border border-critical/40 rounded font-bold animate-pulse">
                ⚡ LIVE CAPTURE
              </span>
            )}
          </div>
          <p className="mono-data text-primary truncate">
            Src: {event.source_ip}
          </p>
          <p className="text-xs text-on-surface-variant truncate mt-0.5">
            {event.destination_ip || event.description?.slice(0, 50)}
          </p>
        </div>
        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <p className="mono-data text-on-surface-variant text-xs">{formatTime(event.timestamp)}</p>
          <TechniqueBadge id={event.technique_id} />
          {event.status && event.status !== 'new' && <StatusChip status={event.status} />}
        </div>
      </div>
    </div>
  )
})

AlertRow.displayName = 'AlertRow'

export default function LiveAlertFeed() {
  const { state } = useStore()
  const { alerts, stats } = state

  // Slice to top 30 most recent items to avoid DOM rendering lags at high EPS
  const visibleAlerts = React.useMemo(() => alerts.slice(0, 30), [alerts])

  return (
    <div className="card flex flex-col h-full">
      <div className="card-header shrink-0">
        <h3 className="font-semibold text-sm text-on-surface">Live Alert Feed</h3>
        <span className="mono-data text-xs px-2 py-0.5 bg-primary/10 border border-primary/20 rounded text-primary font-bold">
          {stats.events_per_sec} EPS
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-1 divide-y divide-surface-high">
        {visibleAlerts.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-outline mono-label">
            AWAITING FEED...
          </div>
        ) : (
          visibleAlerts.map((ev) => <AlertRow key={ev.id} event={ev} />)
        )}
      </div>
    </div>
  )
}
