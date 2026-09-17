import { useEffect, useState } from 'react'
import { Video, Zap, Bot, Users, Copy, Check, Link as LinkIcon, Clock } from 'lucide-react'
import { useToastStore } from '../../store'

export interface RoomHeaderProps {
    title: string
    joinCode: string | null
    role: string | null
    sttLabel: string
    sttColour: string
    sttReason: string | null
    aiActive: boolean
    /** ISO start time; falls back to the moment we joined. */
    startedAt: string | null
    waitingCount: number
    isHost: boolean
    compact: boolean
}

function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(s).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function useElapsed(startedAt: string | null): string {
    const [origin] = useState(() => Date.now())
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [])
    const start = startedAt ? Date.parse(startedAt) : NaN
    const from = Number.isFinite(start) && start <= now ? start : origin
    return formatElapsed(now - from)
}

export function RoomHeader({
    title, joinCode, role, sttLabel, sttColour, sttReason, aiActive, startedAt, waitingCount, isHost, compact,
}: RoomHeaderProps) {
    const addToast = useToastStore((s) => s.addToast)
    const elapsed = useElapsed(startedAt)
    const [copied, setCopied] = useState<'code' | 'link' | null>(null)

    const copy = async (text: string, which: 'code' | 'link') => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(which)
            setTimeout(() => setCopied(null), 1600)
        } catch {
            // Clipboard access is refused on insecure origins and in some
            // browsers; show the value so it can still be copied by hand.
            addToast({ type: 'info', title: 'Copy this', message: text })
        }
    }

    return (
        <header className="room-header">
            <div className="room-header-brand" aria-hidden="true">
                <Video size={14} />
            </div>
            <div className="room-header-title" title={title}>{title}</div>

            <span className="room-header-timer" title="Elapsed">
                <Clock size={12} /> {elapsed}
            </span>

            {joinCode && !compact && (
                <div className="code-chip" title="Anyone signed in with this code can join">
                    <Users size={12} />
                    {joinCode}
                    <button onClick={() => copy(joinCode, 'code')} aria-label="Copy meeting code" title="Copy code">
                        {copied === 'code' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                        onClick={() => copy(`${window.location.origin}/join/${joinCode}`, 'link')}
                        aria-label="Copy invite link"
                        title="Copy invite link"
                    >
                        {copied === 'link' ? <Check size={12} /> : <LinkIcon size={12} />}
                    </button>
                </div>
            )}

            <div className="room-header-right">
                {isHost && waitingCount > 0 && (
                    <span className="badge badge-amber" title="People in the waiting room">
                        {waitingCount} waiting
                    </span>
                )}
                {!compact && (
                    <>
                        <span className="room-header-ind" title={sttReason ?? undefined}>
                            <Zap size={12} color={sttColour} />
                            {sttLabel}
                        </span>
                        <span className="room-header-ind">
                            <Bot size={12} color={aiActive ? 'var(--color-purple)' : 'var(--text-muted)'} />
                            {aiActive ? 'AI active' : 'AI idle'}
                        </span>
                    </>
                )}
                {compact && (
                    <span className="room-header-ind" title={`${sttLabel}${sttReason ? ` - ${sttReason}` : ''}`}>
                        <Zap size={12} color={sttColour} />
                    </span>
                )}
                {role && (
                    <span className={`badge ${role === 'host' ? 'badge-blue' : 'badge-gray'}`}>
                        {role}
                    </span>
                )}
            </div>
        </header>
    )
}
