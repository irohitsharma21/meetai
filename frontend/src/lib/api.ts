import axios from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
})

// ── Request interceptor: attach JWT ───────────────────────────────────
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('access_token')
    if (token) {
        config.headers.Authorization = `Bearer ${token}`
    }
    return config
})

// ── Response interceptor: auto-refresh on 401 ─────────────────────────
api.interceptors.response.use(
    (res) => res,
    async (err) => {
        const original = err.config
        if (err.response?.status === 401 && !original._retry) {
            original._retry = true
            try {
                const refresh = localStorage.getItem('refresh_token')
                if (refresh) {
                    const { data } = await axios.post(`${BASE_URL}/auth/refresh`, null, {
                        params: { refresh_token: refresh },
                    })
                    localStorage.setItem('access_token', data.access_token)
                    localStorage.setItem('refresh_token', data.refresh_token)
                    original.headers.Authorization = `Bearer ${data.access_token}`
                    return api(original)
                }
            } catch {
                localStorage.clear()
                window.location.href = '/login'
            }
        }
        return Promise.reject(err)
    }
)

export default api

/**
 * Turn any API failure into a string safe to render.
 *
 * FastAPI returns 422 `detail` as an array of objects; passing that straight
 * into a toast renders an object as a React child, which throws and unmounts
 * the whole tree. So every error path funnels through here.
 */
export function errorMessage(err: any, fallback = 'Something went wrong. Please try again.'): string {
    const detail = err?.response?.data?.detail

    if (typeof detail === 'string' && detail.trim()) return detail

    if (Array.isArray(detail)) {
        const parts = detail
            .map((d: any) => {
                if (typeof d === 'string') return d
                // loc is like ["body", "title"] - the last element names the field.
                const field = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : undefined
                const msg = d?.msg ?? d?.message
                if (!msg) return null
                return field && field !== 'body' ? `${field}: ${msg}` : String(msg)
            })
            .filter(Boolean)
        if (parts.length) return parts.join(' | ')
    }

    if (detail && typeof detail === 'object') {
        const msg = (detail as any).msg ?? (detail as any).message
        if (msg) return String(msg)
    }

    if (typeof err?.response?.data === 'string' && err.response.data.trim()) {
        return err.response.data
    }
    if (err?.code === 'ECONNABORTED') return 'The server took too long to respond.'
    if (err?.message === 'Network Error') return 'Cannot reach the server. Is the backend running?'

    return err?.message || fallback
}

// ── Auth endpoints ────────────────────────────────────────────────────
export const authApi = {
    login: (username: string, password: string) => {
        const form = new URLSearchParams({ username, password })
        return api.post('/auth/login', form, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
    },
    register: (data: { username: string; email: string; password: string; display_name?: string; role?: string }) =>
        api.post('/auth/register', data),
    me: () => api.get('/auth/me'),
    refresh: (token: string) => api.post('/auth/refresh', null, { params: { refresh_token: token } }),
}

// ── Meeting endpoints ─────────────────────────────────────────────────
export const meetingApi = {
    create: (data: { title: string; description?: string; participants?: string[] }) =>
        api.post('/meetings/', data),
    list: (params?: Record<string, unknown>) => api.get('/meetings/', { params }),
    get: (id: string) => api.get(`/meetings/${id}`),
    join: (id: string) => api.post(`/meetings/${id}/join`),
    joinByCode: (code: string) => api.post('/meetings/join-by-code', { code }),
    start: (id: string) => api.post(`/meetings/${id}/start`),
    end: (id: string) => api.post(`/meetings/${id}/end`),
    generateReport: (id: string, report_types: string[]) =>
        api.post(`/meetings/${id}/generate-report`, { report_types }),
    confirmAction: (meetingId: string, actionId: string) =>
        api.post(`/meetings/${meetingId}/actions/${actionId}/confirm`),
    rejectAction: (meetingId: string, actionId: string) =>
        api.post(`/meetings/${meetingId}/actions/${actionId}/reject`),
    delete: (id: string) => api.delete(`/meetings/${id}`),
}

// ── Transcript endpoints ──────────────────────────────────────────────
export const transcriptApi = {
    get: (id: string) => api.get(`/transcripts/${id}`),
    export: (id: string, fmt: 'txt' | 'json') =>
        api.get(`/transcripts/${id}/export`, { params: { fmt }, responseType: fmt === 'txt' ? 'text' : 'json' }),
}

// ── Calendar endpoints ────────────────────────────────────────────────
export const calendarApi = {
    connect: () => api.get('/calendar/connect'),
    status: () => api.get('/calendar/status'),
    createEvent: (data: {
        title: string
        description?: string
        start_datetime: string
        end_datetime?: string
        attendees?: string[]
        timezone?: string
    }) => api.post('/calendar/events', data),
    confirmAction: (data: {
        meeting_id: string
        action_id: string
        start_datetime: string
        end_datetime?: string
        attendees?: string[]
        timezone?: string
    }) => api.post('/calendar/confirm-action', data),
}

// ── Insights: analytics, semantic search, assistant, digests ──────────
export const insightApi = {
    analytics: (meetingId: string) => api.get(`/insights/${meetingId}/analytics`),

    search: (query: string, limit = 6) =>
        api.post('/insights/search', { query, limit }),
    ask: (query: string, limit = 6) =>
        api.post('/insights/ask', { query, limit }),
    index: (meetingId: string) => api.post(`/insights/${meetingId}/index`),
    reindexAll: () => api.post('/insights/reindex-all'),
    searchStatus: () => api.get('/insights/search/status'),

    assistantStatus: () => api.get('/insights/assistant/status'),
    assistantAsk: (meetingId: string, question: string, speak = true) =>
        api.post(`/insights/${meetingId}/assistant/ask`, { question, speak }),
    assistantListen: (meetingId: string, audio: Blob, speak = true) => {
        const body = new FormData()
        // The filename matters: Groq's Whisper endpoint infers the container
        // from the extension, and rejects the upload without one.
        body.append('audio', audio, 'question.webm')
        body.append('speak', String(speak))
        return api.post(`/insights/${meetingId}/assistant/listen`, body)
    },

    emailStatus: () => api.get('/insights/email/status'),
    sendDigest: (meetingId: string, includeAnalytics = true) =>
        api.post(`/insights/${meetingId}/digest`, { include_analytics: includeAnalytics }),
}
