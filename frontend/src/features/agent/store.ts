import { create } from 'zustand'
import { agentApi } from './api'
import type { AgentAction, ApprovePayload } from './types'

/**
 * Delegate-agent actions for the meetings this tab has been in, keyed by
 * meeting id. Newest first. The feed is fed by GET /actions on mount and by
 * `agent_action` socket messages (upserted by id), so the panel and the
 * floating confirm cards always agree on an action's state.
 */
interface AgentState {
    byMeeting: Record<string, AgentAction[]>
    loaded: Record<string, boolean>
    /** Action ids with a request in flight (approve / reject). */
    busy: Record<string, boolean>
    /** Actions whose floating confirm card the owner has dismissed or handled. */
    dismissed: Record<string, true>

    load: (meetingId: string) => Promise<void>
    /** Insert or replace by id; returns the previous copy, if any. */
    upsert: (action: AgentAction) => AgentAction | undefined
    command: (meetingId: string, text: string) => Promise<AgentAction>
    approve: (meetingId: string, actionId: string, payload?: ApprovePayload) => Promise<AgentAction>
    reject: (meetingId: string, actionId: string) => Promise<AgentAction>
    dismiss: (actionId: string) => void
    clear: (meetingId: string) => void
}

const byNewest = (a: AgentAction, b: AgentAction) =>
    (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)

/** Keep whichever copy is newer, so a slow HTTP reply can't undo a socket update. */
function newer(prev: AgentAction | undefined, next: AgentAction): AgentAction {
    if (!prev) return next
    const p = Date.parse(prev.updated_at) || 0
    const n = Date.parse(next.updated_at) || 0
    return n >= p ? next : prev
}

export const useAgentStore = create<AgentState>((set, get) => ({
    byMeeting: {},
    loaded: {},
    busy: {},
    dismissed: {},

    load: async (meetingId) => {
        const actions = await agentApi.listActions(meetingId)
        set((s) => {
            const current = new Map((s.byMeeting[meetingId] ?? []).map((a) => [a.id, a]))
            for (const a of actions) current.set(a.id, newer(current.get(a.id), a))
            return {
                byMeeting: { ...s.byMeeting, [meetingId]: [...current.values()].sort(byNewest) },
                loaded: { ...s.loaded, [meetingId]: true },
            }
        })
    },

    upsert: (action) => {
        const list = get().byMeeting[action.meeting_id] ?? []
        const prev = list.find((a) => a.id === action.id)
        const kept = newer(prev, action)
        if (prev && kept === prev && prev !== action) return prev
        const next = prev ? list.map((a) => (a.id === action.id ? kept : a)) : [kept, ...list].sort(byNewest)
        set((s) => ({ byMeeting: { ...s.byMeeting, [action.meeting_id]: next } }))
        return prev
    },

    command: async (meetingId, text) => {
        const action = await agentApi.command(meetingId, text)
        get().upsert(action)
        return action
    },

    approve: async (meetingId, actionId, payload) => {
        set((s) => ({ busy: { ...s.busy, [actionId]: true } }))
        try {
            const action = await agentApi.approve(meetingId, actionId, payload)
            get().upsert(action)
            return action
        } finally {
            set((s) => {
                const { [actionId]: _, ...rest } = s.busy
                return { busy: rest }
            })
        }
    },

    reject: async (meetingId, actionId) => {
        set((s) => ({ busy: { ...s.busy, [actionId]: true } }))
        try {
            const action = await agentApi.reject(meetingId, actionId)
            get().upsert(action)
            return action
        } finally {
            set((s) => {
                const { [actionId]: _, ...rest } = s.busy
                return { busy: rest }
            })
        }
    },

    dismiss: (actionId) => set((s) => ({ dismissed: { ...s.dismissed, [actionId]: true } })),

    clear: (meetingId) =>
        set((s) => {
            const { [meetingId]: _a, ...byMeeting } = s.byMeeting
            const { [meetingId]: _b, ...loaded } = s.loaded
            return { byMeeting, loaded }
        }),
}))

const EMPTY: AgentAction[] = []

/** Stable selector for one meeting's feed. */
export const useMeetingActions = (meetingId: string) =>
    useAgentStore((s) => s.byMeeting[meetingId] ?? EMPTY)
