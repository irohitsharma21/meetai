import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
    User, Meeting, MeetingListItem, TranscriptEntry, ActionDetectionResult, TranscriptionStatus,
    MeetingSettings,
} from '../types'

// ── Auth Store ────────────────────────────────────────────────────────
interface AuthState {
    user: User | null
    accessToken: string | null
    refreshToken: string | null
    isAuthenticated: boolean
    setAuth: (user: User, access: string, refresh: string) => void
    clearAuth: () => void
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            user: null,
            accessToken: null,
            refreshToken: null,
            isAuthenticated: false,

            setAuth: (user, access, refresh) => {
                localStorage.setItem('access_token', access)
                localStorage.setItem('refresh_token', refresh)
                set({ user, accessToken: access, refreshToken: refresh, isAuthenticated: true })
            },

            clearAuth: () => {
                localStorage.removeItem('access_token')
                localStorage.removeItem('refresh_token')
                set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
            },
        }),
        {
            name: 'auth-storage',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
        }
    )
)

// ── Meeting Room Store ────────────────────────────────────────────────
/** Which panel the right-hand slot shows. Exactly one at a time, or none. */
export type SidePanelKind = 'chat' | 'participants' | 'transcript' | 'assistant'

/**
 * Why the room is being left without the user pressing anything. Set by the
 * meeting socket; the page watches it and navigates away with a toast.
 */
export type RoomExitReason = 'removed' | 'ended'

interface MeetingRoomState {
    currentMeeting: Meeting | null
    livekitToken: string | null
    livekitUrl: string | null
    roomRole: string | null
    joinCode: string | null
    transcript: TranscriptEntry[]
    pendingActions: ActionDetectionResult[]
    isConnected: boolean
    isRecording: boolean
    isMicMuted: boolean
    isCameraOff: boolean
    // null until the server reports; drives the header badge and the empty
    // state, so "no transcript" is never ambiguous.
    transcriptionStatus: TranscriptionStatus | null

    // Room UI + host-control state (all reset by clearRoom)
    meetingSettings: MeetingSettings | null
    lobbyWaitingCount: number
    sidePanel: SidePanelKind | null
    /** Tile key pinned locally: `<identity>` for a camera, `<identity>:screen` for a share. */
    pinned: string | null
    captionsOn: boolean
    exitReason: RoomExitReason | null

    setTranscriptionStatus: (s: TranscriptionStatus) => void
    setMeeting: (meeting: Meeting, token: string, url: string, role: string, joinCode?: string | null) => void
    /** The meeting document before (or without) a LiveKit token - pre-join and waiting room. */
    setMeetingDoc: (meeting: Meeting) => void
    setMeetingSettings: (settings: MeetingSettings) => void
    setLobbyWaitingCount: (n: number) => void
    setSidePanel: (panel: SidePanelKind | null) => void
    togglePanel: (panel: SidePanelKind) => void
    setPinned: (key: string | null) => void
    setCaptionsOn: (v: boolean) => void
    setExitReason: (reason: RoomExitReason | null) => void
    addTranscriptEntry: (entry: TranscriptEntry) => void
    addPendingAction: (action: ActionDetectionResult) => void
    dismissAction: (index: number) => void
    setConnected: (v: boolean) => void
    setRecording: (v: boolean) => void
    toggleMic: () => void
    setMicMuted: (v: boolean) => void
    toggleCamera: () => void
    clearRoom: () => void
}

export const useMeetingRoomStore = create<MeetingRoomState>((set) => ({
    currentMeeting: null,
    livekitToken: null,
    livekitUrl: null,
    roomRole: null,
    joinCode: null,
    transcript: [],
    pendingActions: [],
    isConnected: false,
    isRecording: false,
    isMicMuted: false,
    isCameraOff: false,
    transcriptionStatus: null,
    meetingSettings: null,
    lobbyWaitingCount: 0,
    sidePanel: null,
    pinned: null,
    captionsOn: false,
    exitReason: null,

    setTranscriptionStatus: (status) => set({ transcriptionStatus: status }),
    setMeeting: (meeting, token, url, role, joinCode) =>
        set({
            currentMeeting: meeting, livekitToken: token, livekitUrl: url, roomRole: role,
            joinCode: joinCode ?? meeting.join_code ?? null,
            meetingSettings: meeting.settings ?? null,
        }),
    setMeetingDoc: (meeting) =>
        set({
            currentMeeting: meeting,
            joinCode: meeting.join_code ?? null,
            meetingSettings: meeting.settings ?? null,
        }),
    setMeetingSettings: (settings) =>
        set((s) => ({
            meetingSettings: settings,
            currentMeeting: s.currentMeeting ? { ...s.currentMeeting, settings } : s.currentMeeting,
        })),
    setLobbyWaitingCount: (n) => set({ lobbyWaitingCount: n }),
    setSidePanel: (panel) => set({ sidePanel: panel }),
    togglePanel: (panel) => set((s) => ({ sidePanel: s.sidePanel === panel ? null : panel })),
    setPinned: (key) => set({ pinned: key }),
    setCaptionsOn: (v) => set({ captionsOn: v }),
    setExitReason: (reason) => set({ exitReason: reason }),

    addTranscriptEntry: (entry) =>
        set((s) => ({ transcript: [...s.transcript, entry] })),

    addPendingAction: (action) =>
        set((s) => ({ pendingActions: [...s.pendingActions, action] })),

    dismissAction: (index) =>
        set((s) => ({
            pendingActions: s.pendingActions.filter((_, i) => i !== index),
        })),

    setConnected: (v) => set({ isConnected: v }),
    setRecording: (v) => set({ isRecording: v }),
    toggleMic: () => set((s) => ({ isMicMuted: !s.isMicMuted })),
    // Mirrors LiveKit's actual microphone state. A blind toggle drifts out of
    // step the moment the mic is changed by anything other than our own button.
    setMicMuted: (v) => set({ isMicMuted: v }),
    toggleCamera: () => set((s) => ({ isCameraOff: !s.isCameraOff })),

    clearRoom: () =>
        set({
            currentMeeting: null,
            livekitToken: null,
            livekitUrl: null,
            roomRole: null,
            joinCode: null,
            transcript: [],
            pendingActions: [],
            isConnected: false,
            isRecording: false,
            transcriptionStatus: null,
            meetingSettings: null,
            lobbyWaitingCount: 0,
            sidePanel: null,
            pinned: null,
            captionsOn: false,
            exitReason: null,
        }),
}))

// ── Dashboard Store ───────────────────────────────────────────────────
interface DashboardState {
    meetings: MeetingListItem[]
    isLoading: boolean
    searchQuery: string
    setMeetings: (meetings: MeetingListItem[]) => void
    setLoading: (v: boolean) => void
    setSearchQuery: (q: string) => void
}

export const useDashboardStore = create<DashboardState>((set) => ({
    meetings: [],
    isLoading: false,
    searchQuery: '',
    setMeetings: (meetings) => set({ meetings }),
    setLoading: (v) => set({ isLoading: v }),
    setSearchQuery: (q) => set({ searchQuery: q }),
}))

// ── Toast/Notification Store ──────────────────────────────────────────
export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
    id: string
    type: ToastType
    title: string
    message?: string
}

interface ToastState {
    toasts: Toast[]
    addToast: (toast: Omit<Toast, 'id'>) => void
    removeToast: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
    toasts: [],
    addToast: (toast) => {
        const id = Math.random().toString(36).slice(2)
        set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
        setTimeout(() => {
            set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
        }, 5000)
    },
    removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
