// Shared TypeScript types mirroring backend Pydantic models

export type Role = 'host' | 'participant' | 'admin'
export type MeetingStatus = 'scheduled' | 'active' | 'ended' | 'processed'
export type ActionStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled'
export type SentimentLabel = 'positive' | 'neutral' | 'negative'

export interface TranscriptEntry {
    id: string
    speaker: string
    text: string
    time: string
    confidence: number
    timestamp_ms?: number
}

export interface NextAction {
    id: string
    task: string
    description?: string
    assignee?: string
    date?: string
    deadline?: string
    status: ActionStatus
    confidence: number
    calendar_event_id?: string
    created_at: string
    confirmed_at?: string
}

export interface SentimentResult {
    overall: SentimentLabel
    confidence: number
    key_shifts: string[]
    emotional_tone?: string
}

export interface AIAnalysis {
    summary?: string
    mom?: string
    sentiment?: SentimentResult
    next_actions: NextAction[]
    keywords: string[]
    topics: string[]
    generated_at?: string
}

export interface Participant {
    username: string
    display_name?: string
    role: Role
    joined_at?: string
    left_at?: string
}

export interface Meeting {
    meeting_id: string
    title: string
    description?: string
    room_name: string
    created_by: string
    participants: Participant[]
    status: MeetingStatus
    timestamp: string
    started_at?: string
    ended_at?: string
    transcript: TranscriptEntry[]
    ai_analysis: AIAnalysis
    recording_url?: string
    duration_seconds?: number
}

export interface MeetingListItem {
    meeting_id: string
    title: string
    created_by: string
    participants: string[]
    status: MeetingStatus
    timestamp: string
    started_at?: string
    ended_at?: string
    duration_seconds?: number
    has_report: boolean
}

export interface JoinMeetingResponse {
    livekit_token: string
    livekit_url: string
    meeting_id: string
    room_name: string
    role: string
}

export interface ActionDetectionResult {
    trigger: boolean
    type?: string
    confidence: number
    suggested_action?: string
    raw_text?: string
    next_action?: NextAction
}

export interface User {
    username: string
    email: string
    display_name?: string
    role: Role
    created_at: string
}

export interface AuthTokens {
    access_token: string
    refresh_token: string
    token_type: string
    expires_in: number
}

// WebSocket message types
export type WSMessage =
    | { type: 'connected'; username: string }
    | { type: 'transcript'; entry: TranscriptEntry }
    | { type: 'action_detected'; result: ActionDetectionResult }
    | { type: 'error'; message: string }
