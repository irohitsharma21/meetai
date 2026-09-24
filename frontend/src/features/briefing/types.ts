/*
 * Briefing: a participant's own documents, turned into private "cues" when
 * someone in the meeting asks something those documents can answer.
 * Mirrors the backend contract in routes /briefing/{meetingId}/...
 */

export type BriefingDocKind = 'pdf' | 'pptx' | 'docx' | 'txt' | 'md'

export interface BriefingDoc {
    id: string
    name: string
    kind: BriefingDocKind
    size: number
    pages: number
    chunks: number
    created_at: string
    status: 'ready'
}

export type BriefingSensitivity = 'low' | 'medium' | 'high'

export interface BriefingSettings {
    enabled: boolean
    sensitivity: BriefingSensitivity
}

export interface BriefingAvailability {
    semantic: boolean
    llm: boolean
}

export interface BriefingDocsResponse {
    docs: BriefingDoc[]
    settings: BriefingSettings
    available: BriefingAvailability
}

export interface CueTrigger {
    speaker: string
    text: string
}

export interface CueSource {
    doc_id: string
    doc_name: string
    /** Human-readable position in the document, e.g. "Slide 4" or "Page 2". */
    locator: string
}

export interface Cue {
    id: string
    meeting_id: string
    trigger: CueTrigger | null
    headline: string
    detail: string
    quote: string
    source: CueSource
    score: number
    created_at: string
}

export interface AskResponse {
    cue: Cue | null
    reason: string | null
}

/** A file on its way up, or one that failed; kept so the panel can show it. */
export interface UploadItem {
    key: string
    name: string
    size: number
    /** 0..1 */
    progress: number
    status: 'queued' | 'uploading' | 'error'
    error?: string
}
