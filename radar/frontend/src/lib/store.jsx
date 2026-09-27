/**
 * RADAR Global Store (React Context)
 * Manages live WebSocket state, alerts, stats, system status.
 * All state is driven from real backend messages — nothing hardcoded.
 */
import { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/api'

const MAX_ALERTS = 200   // Keep last 200 alerts in memory

// ─── State ────────────────────────────────────────────────────────────────────

// Seed inputMode from sessionStorage — survives intra-session navigation,
// resets when the tab/session is closed (sessionStorage is per-tab).
const _sessionMode = sessionStorage.getItem('radar_input_mode') || 'synthetic'
const _sessionFile = (() => {
  try { return JSON.parse(sessionStorage.getItem('radar_upload_file') || 'null') } catch { return null }
})()

const initialState = {
  // Connection
  wsConnected: false,

  // System status (driven by backend)
  feedState: 'LOADING_SYNTHETIC',
  monitoringActive: true,
  inputMode: _sessionMode,
  uptimeSeconds: 0,
  wsClients: 0,

  // File upload info — persists for the session
  uploadFile: _sessionFile,  // { name: string, count: number } | null

  // Alerts
  alerts: [],

  // Stats
  stats: {
    total_alerts: 0,
    critical_count: 0,
    false_positive_count: 0,
    true_positive_count: 0,
    new_count: 0,
    investigating_count: 0,
    avg_resolution_seconds: null,
    correlated_incidents: 0,
    events_per_sec: 0,
  },

  // MITRE coverage (tactic → tiles)
  mitreTactics: {},

  // Autonomous loop stage
  loopStage: 'IDLE',
  loopDetail: null,
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    case 'WS_CONNECTED':
      return { ...state, wsConnected: true }
    case 'WS_DISCONNECTED':
      return { ...state, wsConnected: false, feedState: 'LOADING_SYNTHETIC' }

    case 'STATUS_UPDATE': {
      // Backend status messages may include input_mode — only apply it if the
      // user hasn't already made a session-local selection (sessionStorage wins).
      const sessionMode = sessionStorage.getItem('radar_input_mode')
      const backendMode = action.payload.input_mode
      const nextMode = sessionMode || backendMode || state.inputMode
      return {
        ...state,
        feedState: action.payload.feed_state ?? state.feedState,
        monitoringActive: action.payload.monitoring_active ?? state.monitoringActive,
        inputMode: nextMode,
        uptimeSeconds: action.payload.uptime_seconds ?? state.uptimeSeconds,
        wsClients: action.payload.ws_clients ?? state.wsClients,
      }
    }

    case 'SET_INPUT_MODE': {
      // Explicit user selection — write to sessionStorage so it survives navigation
      sessionStorage.setItem('radar_input_mode', action.payload)
      // Clear upload file info when switching away from upload mode
      if (action.payload !== 'upload') {
        sessionStorage.removeItem('radar_upload_file')
        return { ...state, inputMode: action.payload, uploadFile: null }
      }
      return { ...state, inputMode: action.payload }
    }

    case 'SET_UPLOAD_FILE': {
      // Store uploaded file info for display across navigation
      sessionStorage.setItem('radar_upload_file', JSON.stringify(action.payload))
      return { ...state, uploadFile: action.payload }
    }

    case 'NEW_ALERT': {
      const newAlert = action.payload.event
      if (state.alerts.some(a => a.id === newAlert.id)) {
        return state
      }
      // Prepend new alert (newest first), cap at MAX_ALERTS
      const alerts = [newAlert, ...state.alerts].slice(0, MAX_ALERTS)
      return { ...state, alerts }
    }

    case 'ALERT_UPDATE': {
      // In-place update (triage disposition changed) — never reorders the feed.
      const updated = action.payload.event
      const alerts = state.alerts.map(a => (a.id === updated.id ? { ...a, ...updated } : a))
      return { ...state, alerts }
    }

    case 'STATS_UPDATE':
      return { ...state, stats: { ...state.stats, ...action.payload } }

    case 'MITRE_UPDATE': {
      const { tactic, technique_id, state: tileState, name } = action.payload
      const tactics = { ...state.mitreTactics }
      if (!tactics[tactic]) tactics[tactic] = []
      const existing = tactics[tactic].findIndex(t => t.technique_id === technique_id)
      if (existing >= 0) {
        tactics[tactic] = [...tactics[tactic]]
        tactics[tactic][existing] = { ...tactics[tactic][existing], state: tileState }
      } else {
        tactics[tactic] = [...tactics[tactic], { technique_id, name, tactic, state: tileState }]
      }
      return { ...state, mitreTactics: tactics }
    }

    case 'SET_MITRE':
      return { ...state, mitreTactics: action.payload }

    case 'LOOP_STAGE':
      return {
        ...state,
        loopStage: action.payload.stage,
        loopDetail: action.payload.detail ?? null,
      }

    case 'CLEAR_ALL':
      return {
        ...state,
        alerts: [],
        stats: {
          total_alerts: 0,
          critical_count: 0,
          false_positive_count: 0,
          true_positive_count: 0,
          new_count: 0,
          investigating_count: 0,
          avg_resolution_seconds: null,
          correlated_incidents: 0,
          events_per_sec: 0,
        },
        mitreTactics: {}
      }

    default:
      return state
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

const StoreContext = createContext(null)

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const epsCountRef = useRef(0)
  const epsTimerRef = useRef(null)

  const handleWsMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'alert':
        epsCountRef.current++
        dispatch({ type: 'NEW_ALERT', payload: msg.payload })
        break
      case 'alert_update':
        dispatch({ type: 'ALERT_UPDATE', payload: msg.payload })
        break
      case 'status':
        dispatch({ type: 'STATUS_UPDATE', payload: msg.payload })
        break
      case 'stats':
        dispatch({ type: 'STATS_UPDATE', payload: msg.payload })
        break
      case 'mitre_update':
        dispatch({ type: 'MITRE_UPDATE', payload: msg.payload })
        break
      case 'loop_stage':
        dispatch({ type: 'LOOP_STAGE', payload: msg.payload })
        break
      case 'clear_all':
        dispatch({ type: 'CLEAR_ALL' })
        break
    }
  }, [])

  const { connected } = useWebSocket(handleWsMessage)

  // Sync WebSocket connection state
  useEffect(() => {
    dispatch({ type: connected ? 'WS_CONNECTED' : 'WS_DISCONNECTED' })
  }, [connected])

  // EPS counter (events per second)
  useEffect(() => {
    epsTimerRef.current = setInterval(() => {
      const eps = epsCountRef.current
      epsCountRef.current = 0
      dispatch({ type: 'STATS_UPDATE', payload: { events_per_sec: eps } })
    }, 1000)
    return () => clearInterval(epsTimerRef.current)
  }, [])

  // Load MITRE coverage on mount
  useEffect(() => {
    api.mitre()
      .then(data => dispatch({ type: 'SET_MITRE', payload: data.tactics || {} }))
      .catch(() => {})
  }, [])

  // Load initial stats & alerts
  useEffect(() => {
    api.alerts.stats()
      .then(data => dispatch({ type: 'STATS_UPDATE', payload: data }))
      .catch(() => {})

    api.alerts.latest(50)
      .then(data => {
        if (data?.events && Array.isArray(data.events)) {
          // Dispatch events in chronological order (oldest first) so state.alerts has newest first
          [...data.events].reverse().forEach(ev => {
            dispatch({ type: 'NEW_ALERT', payload: { event: ev } })
          })
        }
      })
      .catch(() => {})
  }, [])

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
