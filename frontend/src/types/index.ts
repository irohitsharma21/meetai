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

/** Host-controlled room settings. Every field defaults on the server. */
export interface MeetingSettings {
    waiting_room: boolean
    locked: boolean
    allow_chat: boolean
    allow_screen_share: boolean
    allow_reactions: boolean
}

export type LobbyStatus = 'waiting' | 'admitted' | 'denied'

export interface LobbyEntry {
    username: string
    display_name?: string
    requested_at: string
    status: LobbyStatus
}

export interface Meeting {
    meeting_id: string
    join_code?: string
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
    settings?: MeetingSettings
    lobby?: LobbyEntry[]
    banned?: string[]
}

export interface MeetingListItem {
    meeting_id: string
    join_code?: string
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
    join_code?: string
}

/** 202 body from POST /meetings/{id}/join while the host has not admitted us. */
export interface JoinWaitingResponse {
    status: 'waiting'
    meeting_id: string
    title: string
    host: string
    join_code?: string
}

export interface LobbyPerson {
    username: string
    display_name?: string
    requested_at: string
}

export interface LobbyResponse {
    waiting: LobbyPerson[]
    admitted: LobbyPerson[]
    settings: MeetingSettings
}

export interface LobbyMeResponse {
    status: LobbyStatus | 'none'
    title: string
    host: string
    locked: boolean
    meeting_status: MeetingStatus
}

export interface LiveTrack {
    sid: string
    kind: 'audio' | 'video' | 'screen'
    muted: boolean
}

export interface LiveParticipant {
    identity: string
    name: string
    is_host: boolean
    joined_at?: string
    tracks: LiveTrack[]
}

export interface JoinByCodeResponse {
    meeting_id: string
    title: string
    join_code: string
    status: MeetingStatus
    created_by: string
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
export interface TranscriptionStatus {
    available: boolean
    reason: string | null
    model?: string
    provider?: string
}

export type WSMessage =
    | { type: 'connected'; username: string }
    | { type: 'transcription_status'; available: boolean; reason: string | null; model?: string; provider?: string }
    | { type: 'transcript'; entry: TranscriptEntry }
    | { type: 'action_detected'; result: ActionDetectionResult }
    | { type: 'error'; message: string }
    | { type: 'lobby_update'; waiting_count: number }
    | { type: 'settings_update'; settings: MeetingSettings }
    | { type: 'participant_removed'; username: string }
    | { type: 'meeting_ended' }
