import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { User, Meeting, MeetingListItem, TranscriptEntry, ActionDetectionResult } from '../types'

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
interface MeetingRoomState {
    currentMeeting: Meeting | null
    livekitToken: string | null
    livekitUrl: string | null
    roomRole: string | null
    transcript: TranscriptEntry[]
    pendingActions: ActionDetectionResult[]
    isConnected: boolean
    isRecording: boolean
    isMicMuted: boolean
    isCameraOff: boolean

    setMeeting: (meeting: Meeting, token: string, url: string, role: string) => void
    addTranscriptEntry: (entry: TranscriptEntry) => void
    addPendingAction: (action: ActionDetectionResult) => void
    dismissAction: (index: number) => void
    setConnected: (v: boolean) => void
    setRecording: (v: boolean) => void
    toggleMic: () => void
    toggleCamera: () => void
    clearRoom: () => void
}

export const useMeetingRoomStore = create<MeetingRoomState>((set) => ({
    currentMeeting: null,
    livekitToken: null,
    livekitUrl: null,
    roomRole: null,
    transcript: [],
    pendingActions: [],
    isConnected: false,
    isRecording: false,
    isMicMuted: false,
    isCameraOff: false,

    setMeeting: (meeting, token, url, role) =>
        set({ currentMeeting: meeting, livekitToken: token, livekitUrl: url, roomRole: role }),

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
    toggleCamera: () => set((s) => ({ isCameraOff: !s.isCameraOff })),

    clearRoom: () =>
        set({
            currentMeeting: null,
            livekitToken: null,
            livekitUrl: null,
            roomRole: null,
            transcript: [],
            pendingActions: [],
            isConnected: false,
            isRecording: false,
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
