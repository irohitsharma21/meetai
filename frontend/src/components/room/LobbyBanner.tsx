import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { UserPlus, Check, X, Users } from 'lucide-react'
import { meetingApi, errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import type { LobbyPerson, LobbyResponse } from '../../types'

/**
 * Host-only: "N people waiting" with Admit / Deny per person and Admit all.
 *
 * The socket's `lobby_update` is the nudge to refetch; the list itself
 * always comes from GET /lobby so it cannot drift from the server.
 */
export function LobbyBanner({ meetingId, waitingCount }: { meetingId: string; waitingCount: number }) {
    const addToast = useToastStore((s) => s.addToast)
    const [waiting, setWaiting] = useState<LobbyPerson[]>([])
    const [busy, setBusy] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        try {
            const res = await meetingApi.lobby(meetingId)
            const data: LobbyResponse = res.data
            setWaiting(data.waiting ?? [])
        } catch {
            // A failed refresh keeps the last list; the next signal retries.
        }
    }, [meetingId])

    useEffect(() => {
        void refresh()
    }, [refresh, waitingCount])

    // Belt and braces: the socket can drop, so also poll slowly.
    useEffect(() => {
        const id = setInterval(() => void refresh(), 15000)
        return () => clearInterval(id)
    }, [refresh])

    const act = async (label: string, fn: () => Promise<unknown>, key: string) => {
        setBusy(key)
        try {
            await fn()
            await refresh()
        } catch (err) {
            addToast({ type: 'error', title: label, message: errorMessage(err) })
        } finally {
            setBusy(null)
        }
    }

    const admit = (u: string) => act('Could not admit', () => meetingApi.admit(meetingId, u), `admit:${u}`)
    const deny = (u: string) => act('Could not deny', () => meetingApi.deny(meetingId, u), `deny:${u}`)
    const admitAll = () => act('Could not admit everyone', () => meetingApi.admitAll(meetingId), 'all')

    return (
        <AnimatePresence>
            {waiting.length > 0 && (
                <motion.div
                    className="room-lobby"
                    role="region"
                    aria-label="Waiting room"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                    <div className="room-lobby-head">
                        <UserPlus size={14} />
                        <span>
                            {waiting.length === 1 ? '1 person wants to join' : `${waiting.length} people want to join`}
                        </span>
                        {waiting.length > 1 && (
                            <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                onClick={admitAll}
                                disabled={busy !== null}
                            >
                                <Users size={12} /> Admit all
                            </button>
                        )}
                    </div>
                    <ul className="room-lobby-list">
                        {waiting.map((p) => (
                            <li key={p.username} className="room-lobby-row">
                                <span className="room-lobby-name">
                                    {p.display_name || p.username}
                                    {p.display_name && p.display_name !== p.username && (
                                        <span className="room-lobby-user">@{p.username}</span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-primary"
                                    onClick={() => admit(p.username)}
                                    disabled={busy !== null}
                                    aria-label={`Admit ${p.display_name || p.username}`}
                                >
                                    <Check size={12} /> Admit
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-secondary"
                                    onClick={() => deny(p.username)}
                                    disabled={busy !== null}
                                    aria-label={`Deny ${p.display_name || p.username}`}
                                >
                                    <X size={12} /> Deny
                                </button>
                            </li>
                        ))}
                    </ul>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
