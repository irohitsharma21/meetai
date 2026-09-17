import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, Lock, ShieldOff, DoorClosed, XCircle, Crown, Loader2 } from 'lucide-react'
import { meetingApi } from '../../lib/api'
import type { LobbyMeResponse } from '../../types'

export type WaitingState = 'waiting' | 'denied' | 'locked' | 'banned' | 'ended' | 'error'

export interface WaitingRoomProps {
    meetingId: string
    title: string
    hostName: string
    state: WaitingState
    /** Server-supplied detail for the terminal states, when there is one. */
    message?: string | null
    /** The host let us in: the caller re-calls join and connects. */
    onAdmitted: () => void
    onCancel: () => void
}

const POLL_MS = 2000

const TERMINAL: Record<Exclude<WaitingState, 'waiting'>, { icon: typeof Lock; title: string; body: string }> = {
    denied: {
        icon: XCircle,
        title: 'The host declined your request',
        body: 'You were not admitted to this meeting. You can ask the host for a new invite.',
    },
    locked: {
        icon: Lock,
        title: 'This meeting is locked',
        body: 'The host has locked the meeting and nobody new can join right now.',
    },
    banned: {
        icon: ShieldOff,
        title: 'You were removed from this meeting',
        body: 'The host removed you, and this meeting cannot be rejoined.',
    },
    ended: {
        icon: DoorClosed,
        title: 'This meeting has ended',
        body: 'The host has ended the meeting. A report will appear on your dashboard once it is ready.',
    },
    error: {
        icon: XCircle,
        title: 'Could not join the meeting',
        body: 'Something went wrong on the way in. Please try again from the dashboard.',
    },
}

/**
 * "Asking to join…" - shown to participants while the host decides.
 *
 * Polls `/lobby/me` every two seconds; the socket-side lobby broadcast is a
 * hint for the host's badge, but this poll is the only thing a waiting
 * client can rely on since it has no room token yet.
 */
export function WaitingRoom({ meetingId, title, hostName, state, message, onAdmitted, onCancel }: WaitingRoomProps) {
    const [local, setLocal] = useState<WaitingState>(state)
    const [lockedNote, setLockedNote] = useState(false)
    const admittedRef = useRef(false)

    useEffect(() => setLocal(state), [state])

    useEffect(() => {
        if (local !== 'waiting') return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const tick = async () => {
            if (cancelled) return
            try {
                const res = await meetingApi.lobbyMe(meetingId)
                if (cancelled) return
                const me: LobbyMeResponse = res.data
                if (me.meeting_status === 'ended' || me.meeting_status === 'processed') {
                    setLocal('ended')
                    return
                }
                if (me.status === 'denied') {
                    setLocal('denied')
                    return
                }
                if (me.status === 'admitted') {
                    if (!admittedRef.current) {
                        admittedRef.current = true
                        onAdmitted()
                    }
                    return
                }
                setLockedNote(Boolean(me.locked))
            } catch {
                // Transient - the next tick will tell us. A dead server shows
                // up as the join failing when we are finally admitted.
            }
            timer = setTimeout(tick, POLL_MS)
        }

        timer = setTimeout(tick, POLL_MS)
        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [local, meetingId, onAdmitted])

    if (local === 'waiting') {
        return (
            <div className="room-wait">
                <motion.div
                    className="room-wait-card"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                >
                    <div className="room-wait-spinner" aria-hidden="true">
                        <Loader2 size={24} className="spin" />
                    </div>
                    <div className="room-prejoin-eyebrow">Asking to join…</div>
                    <h1 className="room-wait-title">{title}</h1>
                    <p className="room-wait-body">
                        <Crown size={13} /> {hostName} will let you in shortly. Keep this tab open.
                    </p>
                    {lockedNote && (
                        <p className="room-wait-note">
                            <Lock size={12} /> The host has locked the meeting for now. You will be let in if it is unlocked.
                        </p>
                    )}
                    <div className="room-wait-dots" aria-hidden="true">
                        <span /><span /><span />
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                </motion.div>
            </div>
        )
    }

    const t = TERMINAL[local]
    const Icon = t.icon
    return (
        <div className="room-wait">
            <motion.div
                className="room-wait-card"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
                <div className={`room-wait-spinner is-${local}`} aria-hidden="true">
                    <Icon size={24} />
                </div>
                <h1 className="room-wait-title">{t.title}</h1>
                <p className="room-wait-body">{message || t.body}</p>
                <p className="room-wait-meta"><Clock size={12} /> {title}</p>
                <button type="button" className="btn btn-primary" onClick={onCancel}>
                    Back to dashboard
                </button>
            </motion.div>
        </div>
    )
}
