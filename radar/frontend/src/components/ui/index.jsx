/**
 * Shared UI components
 */

// Severity chip
export function SeverityChip({ severity }) {
  const classes = {
    critical: 'chip-critical',
    warning: 'chip-warning',
    info: 'chip-info',
  }
  return (
    <span className={classes[severity] ?? 'chip-info'}>
      <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" />
      {severity?.toUpperCase()}
    </span>
  )
}

// Triage status chip
export const TRIAGE_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'true_positive', label: 'True Positive' },
  { value: 'false_positive', label: 'False Positive' },
  { value: 'benign', label: 'Benign' },
  { value: 'resolved', label: 'Resolved' },
]

export function StatusChip({ status }) {
  const styles = {
    new: 'bg-outline/10 text-on-surface-variant border-outline/30',
    investigating: 'bg-warning/15 text-warning border-warning/40',
    true_positive: 'bg-critical/15 text-critical border-critical/40',
    false_positive: 'bg-secondary/15 text-secondary border-secondary/40',
    benign: 'bg-secondary/15 text-secondary border-secondary/40',
    resolved: 'bg-primary/15 text-primary border-primary/40',
  }
  const labels = {
    new: 'NEW',
    investigating: 'INVESTIGATING',
    true_positive: 'TRUE POSITIVE',
    false_positive: 'FALSE POSITIVE',
    benign: 'BENIGN',
    resolved: 'RESOLVED',
  }
  const cls = styles[status] ?? styles.new
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border mono-data text-[10px] font-bold tracking-wide ${cls}`}>
      {labels[status] ?? 'NEW'}
    </span>
  )
}

// Technique badge
export function TechniqueBadge({ id }) {
  if (!id) return <span className="text-outline mono-data">—</span>
  return (
    <span className="inline-flex px-2 py-0.5 rounded bg-surface-high border border-outline/20 mono-data text-on-surface-variant text-xs">
      {id}
    </span>
  )
}

// Skeleton loader
export function Skeleton({ className = '' }) {
  return (
    <div className={`animate-pulse bg-surface-high rounded ${className}`} />
  )
}

// Empty state
export function EmptyState({ icon = '📭', message = 'No data yet' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-outline">
      <span className="text-4xl">{icon}</span>
      <p className="mono-label">{message}</p>
    </div>
  )
}

// Card wrapper
export function Card({ title, badge, children, className = '', action }) {
  return (
    <div className={`card flex flex-col ${className}`}>
      {title && (
        <div className="card-header">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-on-surface text-sm">{title}</h3>
            {badge && <span className="mono-data text-xs px-2 py-0.5 bg-surface-high rounded border border-outline/20 text-on-surface-variant">{badge}</span>}
          </div>
          {action}
        </div>
      )}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

// Stat card
export function StatCard({ label, value, delta, deltaDir, color = 'primary', barFill = 0.5 }) {
  const colors = {
    primary: { text: 'text-primary', bar: 'bg-primary' },
    critical: { text: 'text-critical', bar: 'bg-critical' },
    warning: { text: 'text-warning', bar: 'bg-warning' },
    success: { text: 'text-secondary', bar: 'bg-secondary' },
  }
  const c = colors[color] ?? colors.primary
  return (
    <div className="card p-4 flex flex-col gap-2">
      <p className="mono-label">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold font-mono ${c.text}`}>{value?.toLocaleString() ?? '—'}</span>
        {delta && (
          <span className={`text-xs font-mono ${deltaDir === 'up' ? 'text-secondary' : 'text-critical'}`}>
            {deltaDir === 'up' ? '↑' : '↓'}{delta}
          </span>
        )}
      </div>
      <div className="h-0.5 bg-surface-high rounded overflow-hidden">
        <div
          className={`h-full rounded transition-all duration-500 ${c.bar}`}
          style={{ width: `${Math.min(100, barFill * 100)}%` }}
        />
      </div>
    </div>
  )
}
