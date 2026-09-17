import { create } from 'zustand'
import type { ReceivedChatMessage } from '@livekit/components-react'

/*
 * Shared state for the in-call panels.
 *
 * Why a store rather than component state: `useChat()` accumulates messages
 * per subscriber (components-core builds the history with a per-subscription
 * `scan`), so a ChatPanel that mounts after the first message would start with
 * an empty list. The always-mounted `useChatUnread` hook feeds this store from
 * the moment the room connects, and ChatPanel renders from it. The same store
 * carries the local reaction queue (LiveKit never loops our own data messages
 * back) and the host spotlight so every `useRoomSignals` instance agrees.
 */

export interface ChatEntry {
    id: string
    identity: string
    name: string
    text: string
    timestamp: number
    editTimestamp?: number
    isLocal: boolean
}

export interface FloatingReaction {
    id: string
    emoji: string
    name: string
    /** horizontal start position, percentage of the stage width */
    x: number
    /** small per-reaction drift so identical emoji don't stack */
    drift: number
    ts: number
}

const MAX_CONCURRENT_REACTIONS = 30

interface PanelsState {
    chat: ChatEntry[]
    chatOpen: boolean
    unread: number
    ingestChat: (messages: ReceivedChatMessage[], localIdentity: string) => void
    setChatOpen: (open: boolean) => void

    reactions: FloatingReaction[]
    pushReaction: (r: Omit<FloatingReaction, 'id' | 'x' | 'drift' | 'ts'> & Partial<Pick<FloatingReaction, 'ts'>>) => void
    removeReaction: (id: string) => void

    spotlight: string | null
    setSpotlightState: (identity: string | null) => void
}

function toEntry(m: ReceivedChatMessage, localIdentity: string): ChatEntry {
    const identity = m.from?.identity ?? ''
    return {
        id: m.id,
        identity,
        name: m.from?.name?.trim() || identity || 'Someone',
        text: m.message,
        timestamp: m.timestamp,
        editTimestamp: m.editTimestamp,
        isLocal: m.from?.isLocal === true || (identity !== '' && identity === localIdentity),
    }
}

let reactionSeq = 0

export const usePanelsStore = create<PanelsState>((set, get) => ({
    chat: [],
    chatOpen: false,
    unread: 0,

    ingestChat: (messages, localIdentity) => {
        const { chat, chatOpen } = get()
        if (messages.length === 0) return

        const byId = new Map(chat.map((e) => [e.id, e]))
        let next: ChatEntry[] | null = null
        let newFromOthers = 0

        for (const m of messages) {
            const existing = byId.get(m.id)
            if (!existing) {
                const entry = toEntry(m, localIdentity)
                if (!next) next = [...chat]
                next.push(entry)
                byId.set(entry.id, entry)
                if (!entry.isLocal) newFromOthers++
            } else if (m.editTimestamp && m.editTimestamp !== existing.editTimestamp) {
                if (!next) next = [...chat]
                const idx = next.findIndex((e) => e.id === m.id)
                if (idx > -1) next[idx] = { ...existing, text: m.message, editTimestamp: m.editTimestamp }
            }
        }

        if (!next) return
        next.sort((a, b) => a.timestamp - b.timestamp)
        set({
            chat: next,
            unread: chatOpen ? 0 : get().unread + newFromOthers,
        })
    },

    setChatOpen: (open) => set(open ? { chatOpen: true, unread: 0 } : { chatOpen: false }),

    reactions: [],
    pushReaction: (r) => {
        const item: FloatingReaction = {
            id: `rx-${Date.now()}-${reactionSeq++}`,
            emoji: r.emoji,
            name: r.name,
            x: 6 + Math.random() * 34,
            drift: (Math.random() - 0.5) * 60,
            ts: r.ts ?? Date.now(),
        }
        set((s) => {
            const list = [...s.reactions, item]
            return { reactions: list.length > MAX_CONCURRENT_REACTIONS ? list.slice(list.length - MAX_CONCURRENT_REACTIONS) : list }
        })
    },
    removeReaction: (id) => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),

    spotlight: null,
    setSpotlightState: (identity) => set({ spotlight: identity }),
}))
