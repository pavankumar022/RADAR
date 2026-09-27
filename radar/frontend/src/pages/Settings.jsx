/**
 * Settings Page
 * Live config: detection thresholds, IP whitelist, input mode, AI provider.
 * Offline fallback: if API fails, shows defaults instead of hanging.
 */
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import LiveAnalysisTerminal from '../components/dashboard/LiveAnalysisTerminal'

const DEFAULT_SETTINGS = {
  detection_thresholds: { general_sensitivity: 74, anomaly_detection: 88, lateral_movement: 42 },
  ip_whitelist: [],
  monitored_ips: [],
  synthetic_delay: 3.0,
  ai_provider: 'gemini',
  monitoring_active: true,
}

function ThresholdSlider({ label, value, onChange }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="mono-label text-on-surface-variant">{label}</p>
        <span className="mono-data text-on-surface font-bold text-sm">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        className="w-full h-1.5 bg-surface-high rounded-full appearance-none cursor-pointer"
        style={{ accentColor: '#3b9eff' }}
      />
    </div>
  )
}

const INPUT_MODES = [
  { id: 'synthetic', label: 'Synthetic', icon: '⚙', desc: 'AI-generated events' },
  { id: 'upload', label: 'File Upload', icon: '📁', desc: 'JSON/NDJSON/Log files' },
  { id: 'target_ip', label: 'Add IP', icon: '🎯', desc: 'Target IP Monitor' },
]

export default function Settings() {
  const { state, dispatch } = useStore()
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [offline, setOffline] = useState(false)
  const [newIp, setNewIp] = useState('')
  const [newMonitoredIp, setNewMonitoredIp] = useState('')
  const [uploading, setUploading] = useState(false)

  // Per-mode isolated error state — errors from one mode never bleed into another
  const [modeErrors, setModeErrors] = useState({ synthetic: null, upload: null, target_ip: null })

  const setModeError = (modeId, msg) =>
    setModeErrors(prev => ({ ...prev, [modeId]: msg }))

  const clearModeError = (modeId) =>
    setModeErrors(prev => ({ ...prev, [modeId]: null }))

  // Hidden file input ref — clicking the File Upload card triggers this
  const fileInputRef = useRef(null)

  useEffect(() => {
    api.settings.get()
      .then(data => {
        setSettings(prev => ({ ...prev, ...data }))
        setOffline(false)
      })
      .catch(() => { setOffline(true) })
  }, [])

  const set = (path, value) => {
    setSettings(prev => {
      const next = { ...prev }
      const keys = path.split('.')
      let obj = next
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...obj[keys[i]] }
        obj = obj[keys[i]]
      }
      obj[keys[keys.length - 1]] = value
      return next
    })
  }

  // ─── Input Mode Logic ──────────────────────────────────────────────────────

  /**
   * Handle mode card click.
   * Immediately updates global state so card selection is reflected instantly.
   * For 'upload', also opens the OS file picker.
   */
  const handleModeClick = (modeId) => {
    clearModeError(modeId)
    dispatch({ type: 'SET_INPUT_MODE', payload: modeId })
    api.settings.update({ ...settings, input_mode: modeId }).catch(() => {})
    if (modeId === 'upload') {
      fileInputRef.current?.click()
    }
  }

  /**
   * Called when the user picks a file (or cancels).
   */
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''

    if (!file) {
      return
    }

    const fname = file.name.toLowerCase()
    const validExts = ['.json', '.ndjson', '.jsonl', '.txt', '.log', '.csv']
    if (!validExts.some(ext => fname.endsWith(ext))) {
      setModeError('upload', `Unsupported format. Please select a ${validExts.join(', ')} file.`)
      return
    }

    setUploading(true)
    clearModeError('upload')

    try {
      const result = await api.logs.upload(file)
      const count = result.events_queued ?? 0
      // Alert Storm Guard stats (upload path only) — safe to omit, defaults to null
      const stormStats = result.alert_storm_guard ?? null
      dispatch({ type: 'SET_INPUT_MODE', payload: 'upload' })
      dispatch({ type: 'SET_UPLOAD_FILE', payload: { name: file.name, count, stormStats } })
    } catch (err) {
      const raw = err.message || ''
      let friendly = 'Upload failed — check file format and try again.'
      if (raw.includes('400')) {
        const match = raw.match(/400[: ]+(.+)/)
        const detail = match?.[1]?.trim()
        if (detail && detail.length < 120) {
          friendly = detail
        } else {
          friendly = 'Invalid file — ensure it is a valid JSON array or NDJSON (one object per line).'
        }
      } else if (raw.includes('404')) {
        friendly = 'Upload endpoint not found (404) — check backend server.'
      }
      setModeError('upload', friendly)
    } finally {
      setUploading(false)
    }
  }

  // ─── Save (non-mode settings) ──────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.settings.update({ ...settings, input_mode: state.inputMode })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Settings save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const addIp = () => {
    const ip = newIp.trim()
    if (!ip || settings.ip_whitelist.includes(ip)) return
    set('ip_whitelist', [...settings.ip_whitelist, ip])
    setNewIp('')
  }

  const removeIp = (ip) => {
    set('ip_whitelist', settings.ip_whitelist.filter(x => x !== ip))
  }

  const addMonitoredIp = () => {
    const ip = newMonitoredIp.trim()
    if (!ip || (settings.monitored_ips || []).includes(ip)) return
    const updated = [...(settings.monitored_ips || []), ip]
    set('monitored_ips', updated)
    setNewMonitoredIp('')
    api.settings.update({ ...settings, monitored_ips: updated, input_mode: state.inputMode }).catch(() => {})
  }

  const removeMonitoredIp = (ip) => {
    const updated = (settings.monitored_ips || []).filter(x => x !== ip)
    set('monitored_ips', updated)
    api.settings.update({ ...settings, monitored_ips: updated, input_mode: state.inputMode }).catch(() => {})
  }

  const activeMode = state.inputMode

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-headline-md text-primary font-semibold">System Settings</h1>
          <p className="text-on-surface-variant text-sm mt-1">Configure core detection parameters and platform integration.</p>
          {offline && (
            <div className="mt-2 px-3 py-2 rounded border border-warning/30 bg-warning/10 text-warning text-xs mono-data fade-in">
              ⚠ Backend offline — showing local defaults. Changes will save when backend reconnects.
            </div>
          )}
        </div>

        {/* Input Mode */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-on-surface">Input Mode</h2>
            <p className="text-on-surface-variant text-sm">Select the primary telemetry source.</p>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.ndjson,.jsonl,.txt,.log,.csv"
            className="hidden"
            aria-hidden="true"
            id="file-upload-input"
            onChange={handleFileChange}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {INPUT_MODES.map(mode => (
              <button
                key={mode.id}
                onClick={() => handleModeClick(mode.id)}
                disabled={mode.id === 'upload' && uploading}
                className={`p-4 rounded-lg border flex flex-col items-center gap-2 transition-all ${
                  activeMode === mode.id
                    ? 'bg-primary/15 border-primary/40 text-primary shadow-glow-sm'
                    : 'bg-surface-low border-outline/20 text-on-surface-variant hover:border-outline/40'
                } disabled:opacity-50 disabled:cursor-wait`}
                id={`mode-${mode.id}`}
              >
                {activeMode === mode.id && (
                  <span className="self-end text-xs">✓</span>
                )}
                <span className="text-2xl">
                  {mode.id === 'upload' && uploading ? '⏳' : mode.icon}
                </span>
                <span className="font-semibold text-sm">{mode.label}</span>
                <span className="text-xs opacity-70">
                  {mode.id === 'upload' && uploading ? 'Uploading…' : mode.desc}
                </span>
              </button>
            ))}
          </div>

          {/* Upload error */}
          {modeErrors.upload && (
            <div className="px-3 py-2 rounded border border-critical/30 bg-critical/10 text-critical text-xs mono-data fade-in">
              ✗ {modeErrors.upload}
            </div>
          )}

          {/* File Upload — success badge */}
          {activeMode === 'upload' && state.uploadFile && !uploading && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded border border-secondary/30 bg-secondary/10 fade-in">
              <span className="text-secondary text-sm">📄</span>
              <div className="flex-1 min-w-0">
                <p className="mono-data text-secondary text-xs font-bold truncate">
                  {state.uploadFile.name}
                </p>
                <p className="mono-label text-on-surface-variant text-[10px]">
                  {state.uploadFile.count.toLocaleString()} events loaded
                </p>
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-2 py-1 rounded border border-outline/20 bg-surface-low text-on-surface-variant hover:border-outline/40 text-[10px] font-mono transition-all whitespace-nowrap"
              >
                CHANGE FILE
              </button>
            </div>
          )}

          {/* Alert Storm Guard — only shown when it actually grouped/suppressed something */}
          {activeMode === 'upload' && !uploading && state.uploadFile?.stormStats && (
            (state.uploadFile.stormStats.duplicate_grouped > 0 ||
              state.uploadFile.stormStats.whitelisted_dropped > 0) && (
              <div className="px-3 py-2 rounded border border-outline/15 bg-surface-low/50 fade-in">
                <p className="mono-label text-on-surface-variant text-[10px] leading-relaxed">
                  🛡️ Alert Storm Guard —{' '}
                  {state.uploadFile.stormStats.actionable_incidents.toLocaleString()} incident
                  {state.uploadFile.stormStats.actionable_incidents === 1 ? '' : 's'} surfaced live
                  {state.uploadFile.stormStats.duplicate_grouped > 0 && (
                    <>, {state.uploadFile.stormStats.duplicate_grouped.toLocaleString()} duplicate alerts grouped</>
                  )}
                  {state.uploadFile.stormStats.whitelisted_dropped > 0 && (
                    <>, {state.uploadFile.stormStats.whitelisted_dropped.toLocaleString()} whitelisted-IP alerts suppressed</>
                  )}
                  .
                </p>
              </div>
            )
          )}

          {/* Synthetic — pacing delay slider */}
          {activeMode === 'synthetic' && (
            <div className="space-y-2 pt-4 border-t border-primary/10 fade-in">
              <div className="flex items-center justify-between">
                <p className="mono-label text-on-surface-variant">Synthetic Pacing Delay</p>
                <span className="mono-data text-on-surface font-bold text-sm">{settings.synthetic_delay}s</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={10.0}
                step={0.5}
                value={settings.synthetic_delay ?? 3.0}
                onChange={e => set('synthetic_delay', parseFloat(e.target.value))}
                className="w-full h-1.5 bg-surface-high rounded-full appearance-none cursor-pointer"
                style={{ accentColor: '#3b9eff' }}
              />
              <p className="text-[11px] text-on-surface-variant">
                Controls the time gap between simulated threat events. A larger delay (e.g. 3.0s) allows stable reading and analysis of incoming alerts.
              </p>
            </div>
          )}

          {/* IP Target Monitor Mode — target IP input and live surveillance list */}
          {activeMode === 'target_ip' && (
            <div className="space-y-4 pt-4 border-t border-primary/10 fade-in">
              <div>
                <h3 className="font-semibold text-sm text-on-surface">Target IP Surveillance</h3>
                <p className="text-on-surface-variant text-xs mt-0.5">
                  Enter target machine IP addresses (e.g. Windows workstation/server IP) to monitor real-time attack vectors (Brute Force, Nmap scans, Exploits).
                </p>
              </div>

              <div className="space-y-2">
                {(settings.monitored_ips || []).map(ip => (
                  <div
                    key={ip}
                    className="flex items-center justify-between px-3 py-2.5 rounded border border-outline/20 bg-surface-low text-xs text-on-surface animate-fade-in"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-secondary pulse-dot" />
                      <span className="mono-data font-bold">{ip}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="mono-label text-secondary text-[10px]">LIVE SURVEILLANCE ACTIVE</span>
                      <button
                        onClick={() => removeMonitoredIp(ip)}
                        className="px-2 py-1 rounded bg-critical/15 text-critical border border-critical/30 hover:bg-critical/25 text-[10px] font-mono transition-all"
                      >
                        DISCONNECT
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter Target IP (e.g. Windows IP: 192.168.1.100)"
                  value={newMonitoredIp}
                  onChange={e => setNewMonitoredIp(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addMonitoredIp()}
                  className="flex-1 bg-surface-lowest border border-outline/30 rounded px-3 py-2 mono-data text-sm text-on-surface placeholder-outline focus:outline-none focus:border-primary/50"
                  id="ip-monitored-input"
                />
                <button onClick={addMonitoredIp} className="btn-primary text-xs" id="connect-ip-btn">+ MONITOR TARGET IP</button>
              </div>
            </div>
          )}
        </div>

        {/* Live Network Capture Terminal */}
        <LiveAnalysisTerminal />

        {/* IP Whitelist */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-on-surface">IP Whitelist</h2>
            <p className="text-on-surface-variant text-sm">Requests from these addresses will not trigger alerts.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(settings.ip_whitelist || []).map(ip => (
              <span
                key={ip}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-outline/30 bg-surface-high mono-data text-xs text-on-surface"
              >
                {ip}
                <button
                  onClick={() => removeIp(ip)}
                  className="text-outline hover:text-critical transition-colors ml-0.5"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Enter IP address (e.g. 192.168.1.1)"
              value={newIp}
              onChange={e => setNewIp(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addIp()}
              className="flex-1 bg-surface-lowest border border-outline/30 rounded px-3 py-2 mono-data text-sm text-on-surface placeholder-outline focus:outline-none focus:border-primary/50"
              id="ip-whitelist-input"
            />
            <button onClick={addIp} className="btn-primary text-xs" id="add-ip-btn">+ ADD IP</button>
          </div>
        </div>

        {/* Detection Thresholds */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-on-surface">Detection Thresholds</h2>
            <p className="text-on-surface-variant text-sm">Adjust sensitivity for automated threat detection.</p>
          </div>
          <ThresholdSlider
            label="GENERAL SENSITIVITY"
            value={settings.detection_thresholds.general_sensitivity}
            onChange={v => set('detection_thresholds.general_sensitivity', v)}
          />
          <ThresholdSlider
            label="ANOMALY DETECTION"
            value={settings.detection_thresholds.anomaly_detection}
            onChange={v => set('detection_thresholds.anomaly_detection', v)}
          />
          <ThresholdSlider
            label="LATERAL MOVEMENT"
            value={settings.detection_thresholds.lateral_movement}
            onChange={v => set('detection_thresholds.lateral_movement', v)}
          />
        </div>

        {/* AI Provider */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-on-surface">AI Provider</h2>
            <p className="text-on-surface-variant text-sm">Select the LLM for incident playbook generation.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {['gemini', 'claude'].map(provider => (
              <button
                key={provider}
                onClick={() => set('ai_provider', provider)}
                className={`py-2.5 px-4 rounded border font-semibold text-sm transition-all ${
                  settings.ai_provider === provider
                    ? 'bg-primary/20 border-primary/40 text-primary'
                    : 'bg-surface-low border-outline/20 text-on-surface-variant hover:border-outline/40'
                }`}
                id={`provider-${provider}`}
              >
                {provider === 'gemini' ? 'Gemini 2.0 Flash' : 'Claude'}
              </button>
            ))}
          </div>
        </div>

        {/* Connection Status */}
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-on-surface">Connection Status</h2>
              <div className="flex items-center gap-2 mt-1">
                <span className={`w-2 h-2 rounded-full pulse-dot ${state.wsConnected ? 'bg-secondary text-secondary' : 'bg-critical text-critical'}`} />
                <span className={`mono-label ${state.wsConnected ? 'text-secondary' : 'text-critical'}`}>
                  {state.wsConnected ? 'SYSTEM CONNECTED' : 'DISCONNECTED'}
                </span>
              </div>
              <p className="mono-data text-xs text-on-surface-variant mt-0.5">
                PRIMARY US-EAST-1 NODE ACTIVE · {state.wsClients} WS CLIENTS
              </p>
            </div>
            <svg className="w-10 h-10 text-on-surface-variant" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/>
              <rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/>
              <line x1="10" y1="6" x2="14" y2="6"/><line x1="10" y1="18" x2="14" y2="18"/>
              <line x1="6" y1="10" x2="6" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/>
            </svg>
          </div>
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className={`w-full py-4 rounded border font-bold text-sm tracking-widest transition-all ${
            saved
              ? 'bg-secondary/20 border-secondary/40 text-secondary'
              : 'bg-primary/10 border-primary/30 text-on-surface hover:bg-primary/20 hover:border-primary/50'
          } disabled:opacity-50`}
          id="settings-save-btn"
        >
          {saving ? 'SAVING...' : saved ? '✓ SAVED' : 'SAVE CHANGES'}
        </button>
      </div>
    </div>
  )
}
