import api from '../../lib/api'
import type {
    AskResponse,
    BriefingDoc,
    BriefingDocsResponse,
    BriefingSettings,
} from './types'

/** Extraction of a large deck can take a while on the free-tier server. */
const UPLOAD_TIMEOUT = 120_000
/** /ask may go through the LLM. */
const ASK_TIMEOUT = 60_000

export const ACCEPTED_EXTENSIONS = ['.pdf', '.pptx', '.docx', '.txt', '.md'] as const
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',')
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const base = (meetingId: string) => `/briefing/${encodeURIComponent(meetingId)}`

export const briefingApi = {
    list: (meetingId: string) =>
        api.get<BriefingDocsResponse>(`${base(meetingId)}/docs`).then((r) => r.data),

    upload: (meetingId: string, file: File, onProgress?: (fraction: number) => void) => {
        const body = new FormData()
        body.append('file', file, file.name)
        return api
            .post<BriefingDoc>(`${base(meetingId)}/docs`, body, {
                timeout: UPLOAD_TIMEOUT,
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => {
                    if (onProgress && e.total) onProgress(Math.min(1, e.loaded / e.total))
                },
            })
            .then((r) => r.data)
    },

    remove: (meetingId: string, docId: string) =>
        api.delete(`${base(meetingId)}/docs/${encodeURIComponent(docId)}`),

    updateSettings: (meetingId: string, settings: BriefingSettings) =>
        api.put<BriefingSettings>(`${base(meetingId)}/settings`, settings).then((r) => r.data),

    ask: (meetingId: string, question: string) =>
        api
            .post<AskResponse>(`${base(meetingId)}/ask`, { question }, { timeout: ASK_TIMEOUT })
            .then((r) => r.data),
}

/** Client-side pre-check so an obviously wrong file never leaves the browser. */
export function validateFile(file: File): string | null {
    const dot = file.name.lastIndexOf('.')
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
        return 'Unsupported file type. Use PDF, PPTX, DOCX, TXT or MD.'
    }
    if (file.size > MAX_UPLOAD_BYTES) return 'File is larger than 10 MB.'
    if (file.size === 0) return 'File is empty.'
    return null
}

/** Map the backend's status codes to something a person can act on. */
export function uploadErrorMessage(err: any, fallback: (e: any) => string): string {
    const status = err?.response?.status
    if (status === 413) return 'File is larger than 10 MB.'
    if (status === 415) return 'Unsupported file type. Use PDF, PPTX, DOCX, TXT or MD.'
    if (status === 422) {
        const detail = err?.response?.data?.detail
        return typeof detail === 'string' && detail.trim()
            ? detail
            : 'No readable text found (scanned PDFs are not supported).'
    }
    return fallback(err)
}
