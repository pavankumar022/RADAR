/**
 * Incidents / Playbooks Page
 * Shows incident list + AI playbook detail view.
 * Matches the provided design screenshot.
 */
import { useState, useEffect, useRef } from 'react'
import { jsPDF } from 'jspdf'
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { SeverityChip, TechniqueBadge, StatusChip, TRIAGE_STATUSES, Skeleton, EmptyState } from '../components/ui'

function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString('en-US', { hour12: false }) } catch { return '??' }
}

function formatDuration(seconds) {
  if (seconds == null) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

// ─── Triage panel — SOC analyst disposition workflow ──────────────────────────
function TriagePanel({ alert, onTriaged }) {
  const [notes, setNotes] = useState(alert.analyst_notes || '')
  const [saving, setSaving] = useState(null) // status currently being submitted

  useEffect(() => {
    setNotes(alert.analyst_notes || '')
  }, [alert.id])

  const handleSetStatus = async (status) => {
    setSaving(status)
    try {
      const updated = await api.alerts.triage(alert.id, status, notes)
      onTriaged?.(updated)
    } catch (e) {
      console.error('Triage failed:', e)
    } finally {
      setSaving(null)
    }
  }

  const isTerminal = ['true_positive', 'false_positive', 'benign', 'resolved'].includes(alert.status)

  return (
    <div className="card p-4 md:p-5 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="mono-label text-primary">Triage</h3>
        <div className="flex items-center gap-2">
          <StatusChip status={alert.status || 'new'} />
          {alert.resolution_seconds != null && (
            <span className="mono-data text-[10px] text-on-surface-variant">
              resolved in {formatDuration(alert.resolution_seconds)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {TRIAGE_STATUSES.filter(s => s.value !== 'new').map(s => (
          <button
            key={s.value}
            onClick={() => handleSetStatus(s.value)}
            disabled={saving !== null}
            className={`px-2.5 py-1 rounded border text-[11px] font-mono font-bold tracking-wide transition-all disabled:opacity-50 ${
              alert.status === s.value
                ? 'bg-primary/20 border-primary/50 text-primary'
                : 'bg-surface-high border-outline/20 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            {saving === s.value ? '...' : s.label}
          </button>
        ))}
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Analyst notes — why this is a true/false positive, root cause, remediation taken..."
        rows={2}
        className="w-full text-xs mono-data bg-surface-lowest border border-outline/20 rounded p-2 text-on-surface placeholder:text-outline focus:outline-none focus:border-primary/40 resize-none"
      />
      {isTerminal && (
        <p className="text-[10px] text-on-surface-variant mt-1">
          Disposition set. Notes can still be edited — click a status again to save.
        </p>
      )}
    </div>
  )
}

// ─── Incident List (sidebar) ──────────────────────────────────────────────────
function IncidentList({ onSelect, selectedId, active, onClearAll }) {
  const { state } = useStore()
  const incidents = state.alerts.filter(a => a.severity === 'critical' || a.severity === 'warning')
  const displayedAlerts = incidents.length > 0 ? incidents.slice(0, 50) : state.alerts.slice(0, 50)

  return (
    <div className={`w-full md:w-72 shrink-0 flex flex-col h-full border-r border-primary/10 ${active ? 'hidden md:flex' : 'flex'}`}>
      <div className="card-header shrink-0 flex justify-between items-center w-full">
        <div>
          <h2 className="font-semibold text-sm text-on-surface">Incidents</h2>
          <span className="mono-label text-critical">{displayedAlerts.length} ACTIVE</span>
        </div>
        <button
          onClick={onClearAll}
          className="px-2 py-1 bg-critical/15 text-critical border border-critical/30 rounded hover:bg-critical/25 transition-all text-[10px] font-mono tracking-wider font-bold"
          id="clear-all-incidents-btn"
        >
          CLEAR ALL
        </button>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-surface-high">
        {displayedAlerts.length === 0 ? (
          <EmptyState icon="🔒" message="NO INCIDENTS" />
        ) : (
          displayedAlerts.map(ev => (
            <div
              key={ev.id}
              onClick={() => onSelect(ev)}
              className={`p-3 cursor-pointer transition-colors hover:bg-surface-high ${
                selectedId === ev.id ? 'bg-surface-high border-l-2 border-l-primary' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <SeverityChip severity={ev.severity} />
                <span className="mono-data text-xs text-on-surface-variant">{formatTime(ev.timestamp)}</span>
              </div>
              <p className="font-mono text-xs font-bold text-on-surface">{ev.event_type}</p>
              <p className="mono-data text-xs text-primary truncate">Src: {ev.source_ip}</p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {ev.technique_id && <TechniqueBadge id={ev.technique_id} />}
                {ev.status && ev.status !== 'new' && <StatusChip status={ev.status} />}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function PlaybookDetail({
  alert,
  playbook,
  loading,
  onGenerate,
  onBack,
  active,
  report,
  loadingReport,
  onGenerateReport,
  onTriaged,
}) {
  const [steps, setSteps] = useState([])

  useEffect(() => {
    if (playbook?.containment_steps) {
      setSteps(playbook.containment_steps.map((s, i) => ({ id: i, text: s, done: false })))
    }
  }, [playbook])

  const handleDownloadPDF = () => {
    if (!report) return;
    const doc = new jsPDF();

    doc.setFont("courier", "bold");
    doc.setFontSize(16);
    doc.text("RADAR SOC - INCIDENT REPORT", 20, 20);
    doc.setFontSize(10);
    doc.text(`Incident ID: RAD-${alert.id?.slice(0, 8).toUpperCase()}`, 20, 26);
    doc.line(20, 29, 190, 29);

    let y = 38;
    const writeField = (label, value) => {
      doc.setFont("courier", "bold");
      doc.text(`${label}:`, 20, y);
      doc.setFont("courier", "normal");
      
      const lines = doc.splitTextToSize(value || "N/A", 160);
      doc.text(lines, 20, y + 5);
      y += 12 + (lines.length * 5);
    };

    writeField("Time of activity", report.time_of_activity);
    writeField("List of Affected Entities", report.affected_entities?.join(", ") || "None");
    writeField("severity", report.severity);
    writeField("Reason for Classifying as (true/false)positive", report.classification_reason);
    writeField("(if true positive)Reason for Escalating the Alert", report.escalation_reason);
    writeField("Recommended Remediation Actions", report.remediation_actions?.join("\n") || "None");
    writeField("List of Attack Indicators", report.attack_indicators?.join("\n") || "None");

    doc.save(`${alert.id}.pdf`);
  };

  if (!alert) {
    return (
      <div className={`flex-1 md:flex items-center justify-center ${active ? 'flex' : 'hidden'}`}>
        <EmptyState icon="👈" message="SELECT AN INCIDENT" />
      </div>
    )
  }

  return (
    <div className={`flex-1 flex flex-col h-full min-w-0 ${active ? 'flex' : 'hidden md:flex'}`}>
      {/* Mobile Back Button */}
      <div className="md:hidden px-4 py-2 border-b border-primary/10 bg-surface-lowest flex items-center shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-semibold text-primary py-1 px-2.5 rounded bg-primary/10 border border-primary/20 hover:bg-primary/20"
        >
          ← Back to Incidents
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {/* Alert header */}
        <div className="card p-4 md:p-5 mb-4">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-4">
            <div className="flex items-center gap-3">
              <SeverityChip severity={alert.severity} />
              <h2 className="text-base md:text-lg font-semibold text-on-surface truncate">
                {alert.event_type?.replace('_', ' ')} Detected
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <TechniqueBadge id={alert.technique_id} />
              <span className="mono-data text-on-surface-variant text-xs">{formatTime(alert.timestamp)}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="mono-label mb-1">SOURCE IP</p>
              <p className="mono-data text-primary text-xs md:text-sm">{alert.source_ip}</p>
            </div>
            <div>
              <p className="mono-label mb-1">INCIDENT ID</p>
              <p className="mono-data text-on-surface text-xs md:text-sm">RAD-{alert.id?.slice(0, 6).toUpperCase()}</p>
            </div>
          </div>

          {/* Generate / Generated indicator */}
          <div className="mt-4 flex justify-between items-center flex-wrap gap-2">
            <div>
              {playbook ? (
                <span className="chip-success">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  Generated by {playbook.provider === 'gemini' ? 'Gemini 2.0 Flash' : playbook.provider}
                </span>
              ) : (
                <button
                  onClick={onGenerate}
                  disabled={loading}
                  className="btn-primary flex items-center gap-2"
                  id="generate-playbook-btn"
                >
                  {loading ? (
                    <><span className="animate-spin">⚡</span> Generating...</>
                  ) : (
                    <><span>⚡</span> Generate AI Playbook</>
                  )}
                </button>
              )}
            </div>

            <div>
              {report ? (
                <div className="flex items-center gap-2">
                  <span className="chip-success">
                    📋 Report Generated
                  </span>
                  <button
                    onClick={handleDownloadPDF}
                    className="p-1.5 bg-primary/10 text-primary border border-primary/20 rounded hover:bg-primary/20 transition-all text-xs font-mono font-bold flex items-center gap-1"
                    title="Download Report PDF"
                    id="download-report-pdf-btn"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    PDF
                  </button>
                </div>
              ) : (
                <button
                  onClick={onGenerateReport}
                  disabled={loadingReport}
                  className="btn-primary flex items-center gap-2 text-xs"
                  id="generate-report-btn"
                >
                  {loadingReport ? (
                    <><span className="animate-spin">📋</span> Generating...</>
                  ) : (
                    <><span>📋</span> Generate Incident Report</>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        <TriagePanel alert={alert} onTriaged={onTriaged} />

        {/* Playbook content */}
        {playbook && (
          <div className="space-y-4">
            {/* 1. Situation Summary */}
            <div className="card p-4 md:p-5">
              <h3 className="mono-label text-primary mb-3">1. Situation Summary</h3>
              <p className="text-on-surface text-sm leading-relaxed">{playbook.situation_summary}</p>
            </div>

            {/* 2. Likely Technique */}
            <div className="card p-4 md:p-5">
              <h3 className="mono-label text-primary mb-3">2. Likely Technique</h3>
              <p className="font-semibold text-on-surface mb-1">{playbook.likely_technique}</p>
              <p className="text-sm text-on-surface-variant">{alert.description}</p>
            </div>

            {/* 3. Containment Steps */}
            {steps.length > 0 && (
              <div className="card p-4 md:p-5">
                <h3 className="mono-label text-primary mb-3">3. Immediate Containment Steps</h3>
                <div className="space-y-3">
                  {steps.map((step, i) => (
                    <div key={step.id} className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={step.done}
                        onChange={() => setSteps(s => s.map((x, j) => j === i ? { ...x, done: !x.done } : x))}
                        className="mt-0.5 w-4 h-4 rounded border-outline/30 bg-surface-high accent-secondary cursor-pointer"
                        id={`step-${i}`}
                      />
                      <label htmlFor={`step-${i}`} className={`mono-data text-sm cursor-pointer flex-1 ${step.done ? 'line-through text-outline' : 'text-on-surface'}`}>
                        {step.text}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 4. Remediation Commands */}
            {playbook.remediation_commands && (
              <div className="card p-4 md:p-5">
                <h3 className="mono-label text-primary mb-3">4. Recommended Remediation</h3>
                <div className="bg-surface-lowest rounded border border-outline/20 p-3 overflow-x-auto">
                  <pre className="mono-data text-xs text-secondary whitespace-pre-wrap">
                    {playbook.remediation_commands}
                  </pre>
                </div>
              </div>
            )}

          </div>
        )}

        {/* Incident Report Content */}
        {report && (
          <div className="card p-4 md:p-5 mt-4 space-y-4 bg-surface-lowest">
            <div className="flex justify-between items-center border-b border-primary/10 pb-3">
              <h3 className="mono-label text-primary font-bold text-sm">Incident Report (Gemini AI)</h3>
              <button
                onClick={handleDownloadPDF}
                className="px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded hover:bg-primary/20 transition-all text-xs font-mono font-bold flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download PDF
              </button>
            </div>

            <div className="space-y-3.5 text-sm">
              <div>
                <span className="font-mono font-bold text-on-surface">Time of activity:</span>
                <p className="mono-data text-xs text-on-surface-variant mt-1">{report.time_of_activity}</p>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">List of Affected Entities:</span>
                <ul className="list-disc pl-5 mt-1 text-on-surface-variant text-xs space-y-1">
                  {report.affected_entities?.map((e, idx) => <li key={idx} className="mono-data">{e}</li>)}
                </ul>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">severity:</span>
                <p className="mono-data text-xs text-on-surface-variant mt-1">{report.severity}</p>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">Reason for Classifying as (true/false)positive:</span>
                <p className="text-on-surface-variant text-xs mt-1 leading-relaxed">{report.classification_reason}</p>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">(if true positive)Reason for Escalating the Alert:</span>
                <p className="text-on-surface-variant text-xs mt-1 leading-relaxed">{report.escalation_reason}</p>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">Recommended Remediation Actions:</span>
                <ul className="list-disc pl-5 mt-1 text-on-surface-variant text-xs space-y-1">
                  {report.remediation_actions?.map((e, idx) => <li key={idx} className="mono-data">{e}</li>)}
                </ul>
              </div>

              <div>
                <span className="font-mono font-bold text-on-surface">List of Attack Indicators:</span>
                <ul className="list-disc pl-5 mt-1 text-on-surface-variant text-xs space-y-1">
                  {report.attack_indicators?.map((e, idx) => <li key={idx} className="mono-data">{e}</li>)}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function Incidents() {
  const { alertId } = useParams()
  const navigate = useNavigate()
  const { state, dispatch } = useStore()

  const [selectedAlert, setSelectedAlert] = useState(null)
  const [playbook, setPlaybook] = useState(null)
  const [loadingPlaybook, setLoadingPlaybook] = useState(false)
  const [report, setReport] = useState(null)
  const [loadingReport, setLoadingReport] = useState(false)

  // Track which alertId we've already initialised — prevents re-running on every new WS event
  const initialisedAlertId = useRef(null)

  // If alertId in URL changes, auto-select that alert (run ONLY when alertId changes)
  useEffect(() => {
    if (alertId && alertId !== initialisedAlertId.current) {
      const found = state.alerts.find(a => a.id === alertId)
      if (found) {
        initialisedAlertId.current = alertId
        setSelectedAlert(found)
        setReport(null)
        setPlaybook(null)
        // Try to load existing playbook
        api.playbook.get(alertId).then(setPlaybook).catch(() => {})
      }
    }
    if (!alertId) {
      initialisedAlertId.current = null
    }
  }, [alertId]) // ← intentionally omit state.alerts to avoid resetting report on new events

  // Keep selectedAlert data fresh as store updates, WITHOUT touching report/playbook
  useEffect(() => {
    if (selectedAlert) {
      const fresh = state.alerts.find(a => a.id === selectedAlert.id)
      if (fresh && fresh !== selectedAlert) {
        setSelectedAlert(fresh)
      }
    }
  }, [state.alerts])

  const handleSelect = (ev) => {
    initialisedAlertId.current = ev.id   // prevent URL effect from re-triggering
    setSelectedAlert(ev)
    setPlaybook(null)
    setReport(null)
    navigate(`/incidents/${ev.id}`)
    api.playbook.get(ev.id).then(setPlaybook).catch(() => {})
  }

  const handleBack = () => {
    setSelectedAlert(null)
    setPlaybook(null)
    setReport(null)
    navigate('/incidents')
  }

  const handleGenerateReport = async () => {
    if (!selectedAlert) return
    setLoadingReport(true)
    try {
      const r = await api.playbook.generateReport(selectedAlert.id)
      setReport(r)
    } catch (e) {
      console.error('Report gen failed:', e)
    } finally {
      setLoadingReport(false)
    }
  }

  const handleGenerate = async () => {
    if (!selectedAlert) return
    setLoadingPlaybook(true)
    try {
      const pb = await api.playbook.generate(selectedAlert.id)
      setPlaybook(pb)
    } catch (e) {
      console.error('Playbook gen failed:', e)
    } finally {
      setLoadingPlaybook(false)
    }
  }

  const handleTriaged = (updated) => {
    // Optimistic local update + push into the shared store so the incident
    // list, live alert feed, and stats cards all reflect it immediately —
    // don't wait on the websocket round-trip for the analyst's own action.
    setSelectedAlert(prev => (prev ? { ...prev, ...updated } : prev))
    dispatch({ type: 'ALERT_UPDATE', payload: { event: updated } })
  }

  const handleClearAll = async () => {
    if (!window.confirm("Are you sure you want to clear all incidents and alerts? This will also stop replay and clear the log archive.")) return
    try {
      await api.logs.clear()
      dispatch({ type: 'CLEAR_ALL' })
      setSelectedAlert(null)
      setPlaybook(null)
      navigate('/incidents')
    } catch (e) {
      console.error('Failed to clear incidents:', e)
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <IncidentList onSelect={handleSelect} selectedId={selectedAlert?.id} active={!!selectedAlert} onClearAll={handleClearAll} />
      <PlaybookDetail
        alert={selectedAlert}
        playbook={playbook}
        loading={loadingPlaybook}
        onGenerate={handleGenerate}
        onBack={handleBack}
        report={report}
        loadingReport={loadingReport}
        onGenerateReport={handleGenerateReport}
        active={!!selectedAlert}
        onTriaged={handleTriaged}
      />
    </div>
  )
}
