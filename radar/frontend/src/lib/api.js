/**
 * RADAR API Client
 * All REST API calls go through here — never scattered across components.
 * Base URL is relative so Vite proxy handles routing to backend.
 */

const BASE = import.meta.env.VITE_API_URL || '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

// ─── Status ────────────────────────────────────────────────────────────────────
export const api = {
  status: () => request('/status'),

  // ─── Alerts ──────────────────────────────────────────────────────────────────
  alerts: {
    latest: (limit = 20) => request(`/alerts/latest?limit=${limit}`),
    stats: () => request('/alerts/stats'),
    triage: (alertId, status, notes) =>
      request(`/alerts/${alertId}/triage`, {
        method: 'PATCH',
        body: JSON.stringify({ status, notes }),
      }),
  },

  // ─── Logs ────────────────────────────────────────────────────────────────────
  logs: {
    list: (params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') q.set(k, v) })
      return request(`/logs?${q}`)
    },
    upload: async (file) => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${BASE}/logs/upload`, { method: 'POST', body: form })
      if (!res.ok) {
        // Try to extract a human-readable detail from the backend response body
        let detail = ''
        try {
          const body = await res.json()
          // FastAPI wraps validation errors in { detail: "..." }
          detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
        } catch {
          try { detail = await res.text() } catch { /* ignore */ }
        }
        throw new Error(`Upload failed: ${res.status}${detail ? ': ' + detail : ''}`)
      }
      return res.json()
    },
    clear: () => request('/logs', { method: 'DELETE' }),
  },

  // ─── Playbooks ───────────────────────────────────────────────────────────────
  playbook: {
    generate: (alertId, provider) =>
      request('/playbook/generate', {
        method: 'POST',
        body: JSON.stringify({ alert_id: alertId, provider }),
      }),
    get: (alertId) => request(`/playbook/${alertId}`),
    generateReport: (alertId, provider) =>
      request('/playbook/report', {
        method: 'POST',
        body: JSON.stringify({ alert_id: alertId, provider }),
      }),
  },

  // ─── Settings ────────────────────────────────────────────────────────────────
  settings: {
    get: () => request('/settings'),
    update: (data) => request('/settings', { method: 'POST', body: JSON.stringify(data) }),
    shield: (active) =>
      request('/settings/shield', {
        method: 'POST',
        body: JSON.stringify({ monitoring_active: active }),
      }),
  },

  // ─── Replay ──────────────────────────────────────────────────────────────────
  replay: {
    start: (speed) =>
      request('/replay/start', {
        method: 'POST',
        body: JSON.stringify({ speed_multiplier: speed }),
      }),
    stop: () => request('/replay/stop', { method: 'POST', body: '{}' }),
    status: () => request('/replay/status'),
  },

  // ─── Live Capture ────────────────────────────────────────────────────────────
  live: {
    start: () => request('/live/start', { method: 'POST' }),
    stop: () => request('/live/stop', { method: 'POST' }),
    status: () => request('/live/status'),
  },

  // ─── MITRE ───────────────────────────────────────────────────────────────────
  mitre: () => request('/mitre'),
}
