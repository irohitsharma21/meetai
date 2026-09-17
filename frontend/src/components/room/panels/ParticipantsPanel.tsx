import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
    Check,
    Copy,
    DoorOpen,
    EllipsisVertical,
    Hand,
    Link2,
    Lock,
    MessageSquare,
    Mic,
    MicOff,
    MonitorUp,
    Pin,
    PinOff,
    Search,
    Settings2,
    Smile,
    Sparkles,
    UserCheck,
    UserMinus,
    UserX,
    Users,
    Video,
    VideoOff,
    X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useIsSpeaking, useParticipants } from '@livekit/components-react'
import type { Participant } from 'livekit-client'
import api, { errorMessage } from '../../../lib/api'
import { useMeetingRoomStore, useToastStore } from '../../../store'
import { useRoomSignals } from './useRoomSignals'
import { copyText, initials, speakerColor } from './utils'
import '../../../styles/panels.css'

interface ParticipantsPanelProps {
    meetingId: string
    isHost: boolean
    hostIdentity: string
    onClose: () => void
    onPin?: (identity: string | null) => void
    pinned?: string | null
}

interface MeetingSettings {
    waiting_room: boolean
    locked: boolean
    allow_chat: boolean
    allow_screen_share: boolean
    allow_reactions: boolean
}

interface LobbyEntry {
    username: string
    display_name?: string
    requested_at?: string
}

interface LobbyResponse {
    waiting?: LobbyEntry[]
    admitted?: LobbyEntry[]
    settings?: Partial<MeetingSettings>
}

interface MeetingDoc {
    settings?: Partial<MeetingSettings>
}

const DEFAULT_SETTINGS: MeetingSettings = {
    waiting_room: true,
    locked: false,
    allow_chat: true,
    allow_screen_share: true,
    allow_reactions: true,
}

const SETTING_ROWS: { key: keyof MeetingSettings; label: string; sub: string; icon: LucideIcon }[] = [
    { key: 'waiting_room', label: 'Waiting room', sub: 'People must be admitted before joining', icon: DoorOpen },
    { key: 'locked', label: 'Lock meeting', sub: 'Nobody new can join', icon: Lock },
    { key: 'allow_chat', label: 'Allow chat', sub: 'Participants can send messages', icon: MessageSquare },
    { key: 'allow_screen_share', label: 'Allow screen share', sub: 'Participants can present', icon: MonitorUp },
    { key: 'allow_reactions', label: 'Allow reactions', sub: 'Participants can send emoji', icon: Smile },
]

const LOBBY_POLL_MS = 3000

function displayName(p: Participant): string {
    return p.name?.trim() || p.identity
}

// ── Row ───────────────────────────────────────────────────────────────

interface RowProps {
    participant: Participant
    isLocal: boolean
    isHostRow: boolean
    viewerIsHost: boolean
    handOrder: number | null
    isPinned: boolean
    isSpotlit: boolean
    menuOpen: boolean
    busy: boolean
    onToggleMenu: () => void
    onCloseMenu: () => void
    onPin?: (identity: string | null) => void
    onMute: () => void
    onStopVideo: () => void
    onLowerHand: () => void
    onSpotlight: () => void
    onRemove: () => void
}

function ParticipantRow({
    participant: p,
    isLocal,
    isHostRow,
    viewerIsHost,
    handOrder,
    isPinned,
    isSpotlit,
    menuOpen,
    busy,
    onToggleMenu,
    onCloseMenu,
    onPin,
    onMute,
    onStopVideo,
    onLowerHand,
    onSpotlight,
    onRemove,
}: RowProps): JSX.Element {
    const isSpeaking = useIsSpeaking(p)
    const [confirmRemove, setConfirmRemove] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)
    const name = displayName(p)

    useEffect(() => {
        if (!menuOpen) {
            setConfirmRemove(false)
            return
        }
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onCloseMenu()
        }
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onCloseMenu()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [menuOpen, onCloseMenu])

    const micOn = p.isMicrophoneEnabled
    const camOn = p.isCameraEnabled
    const sharing = p.isScreenShareEnabled

    const canManage = viewerIsHost && !isLocal
    const canLowerOwn = isLocal && handOrder !== null
    const hasMenu = Boolean(onPin) || canManage || canLowerOwn

    const items: ReactNode[] = []
    if (onPin) {
        items.push(
            <button key="pin" type="button" className="ppl-menu-item" onClick={() => { onPin(isPinned ? null : p.identity); onCloseMenu() }}>
                {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                {isPinned ? 'Unpin' : 'Pin for me'}
            </button>,
        )
    }
    if (canLowerOwn) {
        items.push(
            <button key="lower-own" type="button" className="ppl-menu-item" onClick={() => { onLowerHand(); onCloseMenu() }}>
                <Hand size={14} /> Lower my hand
            </button>,
        )
    }
    if (canManage) {
        if (items.length) items.push(<div key="sep1" className="ppl-menu-sep" />)
        items.push(
            <button key="mute" type="button" className="ppl-menu-item" disabled={!micOn || busy} onClick={() => { onMute(); onCloseMenu() }}>
                <MicOff size={14} /> {micOn ? 'Mute' : 'Already muted'}
            </button>,
            <button key="video" type="button" className="ppl-menu-item" disabled={!camOn || busy} onClick={() => { onStopVideo(); onCloseMenu() }}>
                <VideoOff size={14} /> {camOn ? 'Stop video' : 'Video is off'}
            </button>,
        )
        if (handOrder !== null) {
            items.push(
                <button key="lower" type="button" className="ppl-menu-item" onClick={() => { onLowerHand(); onCloseMenu() }}>
                    <Hand size={14} /> Lower hand
                </button>,
            )
        }
        items.push(
            <button key="spot" type="button" className="ppl-menu-item" onClick={() => { onSpotlight(); onCloseMenu() }}>
                <Sparkles size={14} /> {isSpotlit ? 'Remove spotlight' : 'Spotlight for everyone'}
            </button>,
            <div key="sep2" className="ppl-menu-sep" />,
        )
        if (confirmRemove) {
            items.push(
                <div key="confirm" className="ppl-confirm">
                    <p>Remove <strong>{name}</strong> from the meeting? They won't be able to rejoin.</p>
                    <div className="ppl-confirm-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => { onRemove(); onCloseMenu() }}>Remove</button>
                    </div>
                </div>,
            )
        } else {
            items.push(
                <button key="remove" type="button" className="ppl-menu-item is-danger" onClick={() => setConfirmRemove(true)}>
                    <UserMinus size={14} /> Remove from meeting
                </button>,
            )
        }
    }

    return (
        <div className={`ppl-row${menuOpen ? ' is-menu-open' : ''}`}>
            <div className="ppl-avatar-wrap">
                <span className={`ppl-avatar${isSpeaking ? ' is-speaking' : ''}`} style={{ background: speakerColor(p.identity) }} aria-hidden="true">
                    {initials(name)}
                </span>
                {isSpeaking && <span className="ppl-speaking-dot" />}
            </div>

            <div className="ppl-main">
                <div className="ppl-name">
                    <span title={p.identity}>{name}</span>
                    {isLocal && <span className="ppl-you">(You)</span>}
                    {isHostRow && <span className="ppl-tag ppl-tag-host">Host</span>}
                </div>
                {(handOrder !== null || isSpotlit || isPinned) && (
                    <div className="ppl-meta">
                        {handOrder !== null && (
                            <span className="ppl-tag ppl-tag-hand" title="Hand raised">
                                <Hand size={10} /> #{handOrder}
                            </span>
                        )}
                        {isSpotlit && <span className="ppl-tag ppl-tag-spot"><Sparkles size={10} /> Spotlight</span>}
                        {isPinned && <span className="ppl-tag ppl-tag-pin"><Pin size={10} /> Pinned</span>}
                    </div>
                )}
            </div>

            <div className="ppl-icons" aria-label={`${micOn ? 'Mic on' : 'Mic off'}, ${camOn ? 'camera on' : 'camera off'}`}>
                {sharing && <span className="ppl-icon is-share" title="Presenting"><MonitorUp size={14} /></span>}
                <span className={`ppl-icon${micOn ? '' : ' is-off'}`} title={micOn ? 'Microphone on' : 'Microphone off'}>
                    {micOn ? <Mic size={14} /> : <MicOff size={14} />}
                </span>
                <span className={`ppl-icon${camOn ? '' : ' is-off'}`} title={camOn ? 'Camera on' : 'Camera off'}>
                    {camOn ? <Video size={14} /> : <VideoOff size={14} />}
                </span>
                {hasMenu && (
                    <button
                        type="button"
                        className="btn btn-ghost btn-icon-sm ppl-menu-btn"
                        aria-label={`More options for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={onToggleMenu}
                    >
                        <EllipsisVertical size={14} />
                    </button>
                )}
            </div>

            {menuOpen && hasMenu && (
                <div className="ppl-menu" role="menu" ref={menuRef}>
                    {items}
                </div>
            )}
        </div>
    )
}

// ── Panel ─────────────────────────────────────────────────────────────

export function ParticipantsPanel({ meetingId, isHost, hostIdentity, onClose, onPin, pinned = null }: ParticipantsPanelProps): JSX.Element {
    const participants = useParticipants()
    const joinCode = useMeetingRoomStore((s) => s.joinCode)
    const meetingJoinCode = useMeetingRoomStore((s) => s.currentMeeting?.join_code ?? null)
    // The ROOM agent is adding this field concurrently; read it defensively.
    const lobbyWaitingCount = useMeetingRoomStore((s) => (s as any).lobbyWaitingCount as number | undefined)
    const addToast = useToastStore((s) => s.addToast)
    const signals = useRoomSignals({ hostIdentity, isHost })

    const [search, setSearch] = useState('')
    const [lobby, setLobby] = useState<LobbyEntry[]>([])
    const [settings, setSettings] = useState<MeetingSettings | null>(null)
    const [showSettings, setShowSettings] = useState(false)
    const [busy, setBusy] = useState<Record<string, boolean>>({})
    const [menuFor, setMenuFor] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const fail = useCallback(
        (title: string, err: unknown) => addToast({ type: 'error', title, message: errorMessage(err) }),
        [addToast],
    )

    const run = useCallback(
        async (key: string, title: string, fn: () => Promise<void>) => {
            setBusy((b) => ({ ...b, [key]: true }))
            try {
                await fn()
            } catch (err) {
                fail(title, err)
            } finally {
                setBusy((b) => {
                    const next = { ...b }
                    delete next[key]
                    return next
                })
            }
        },
        [fail],
    )

    // ── Lobby polling (host only) ─────────────────────────────────────
    const fetchLobby = useCallback(async () => {
        if (!isHost) return
        try {
            const { data } = await api.get<LobbyResponse>(`/meetings/${meetingId}/lobby`)
            setLobby(data.waiting ?? [])
            if (data.settings) setSettings((s) => ({ ...DEFAULT_SETTINGS, ...(s ?? {}), ...data.settings }))
        } catch {
            // Polling: a transient failure just means the next tick retries.
        }
    }, [isHost, meetingId])

    useEffect(() => {
        if (!isHost) return
        void fetchLobby()
        const id = window.setInterval(() => void fetchLobby(), LOBBY_POLL_MS)
        return () => window.clearInterval(id)
    }, [isHost, fetchLobby])

    useEffect(() => {
        if (isHost && lobbyWaitingCount !== undefined) void fetchLobby()
    }, [isHost, lobbyWaitingCount, fetchLobby])

    useEffect(() => {
        if (!isHost) return
        let cancelled = false
        api.get<MeetingDoc>(`/meetings/${meetingId}`)
            .then(({ data }) => {
                if (!cancelled) setSettings({ ...DEFAULT_SETTINGS, ...(data.settings ?? {}) })
            })
            .catch(() => {
                if (!cancelled) setSettings((s) => s ?? DEFAULT_SETTINGS)
            })
        return () => {
            cancelled = true
        }
    }, [isHost, meetingId])

    const admit = (username: string) =>
        run(`lobby:${username}`, 'Could not admit', async () => {
            await api.post(`/meetings/${meetingId}/lobby/${encodeURIComponent(username)}/admit`)
            setLobby((l) => l.filter((e) => e.username !== username))
            void fetchLobby()
        })

    const deny = (username: string) =>
        run(`lobby:${username}`, 'Could not deny', async () => {
            await api.post(`/meetings/${meetingId}/lobby/${encodeURIComponent(username)}/deny`)
            setLobby((l) => l.filter((e) => e.username !== username))
            void fetchLobby()
        })

    const admitAll = () =>
        run('lobby:all', 'Could not admit everyone', async () => {
            await api.post(`/meetings/${meetingId}/lobby/admit-all`)
            setLobby([])
            void fetchLobby()
        })

    // ── Host controls ────────────────────────────────────────────────
    const muteAll = () =>
        run('mute-all', 'Could not mute everyone', async () => {
            await api.post(`/meetings/${meetingId}/mute-all`)
            signals.requestMute('*')
            addToast({ type: 'success', title: 'Everyone muted' })
        })

    const muteOne = (identity: string) =>
        run(`p:${identity}`, 'Could not mute', async () => {
            await api.post(`/meetings/${meetingId}/participants/${encodeURIComponent(identity)}/mute`, { kind: 'audio' })
            signals.requestMute(identity)
        })

    const stopVideo = (identity: string) =>
        run(`p:${identity}`, 'Could not stop video', async () => {
            await api.post(`/meetings/${meetingId}/participants/${encodeURIComponent(identity)}/mute`, { kind: 'video' })
        })

    const remove = (identity: string) =>
        run(`p:${identity}`, 'Could not remove participant', async () => {
            await api.post(`/meetings/${meetingId}/participants/${encodeURIComponent(identity)}/remove`)
            if (onPin && pinned === identity) onPin(null)
            if (signals.spotlight === identity) signals.setSpotlight(null)
        })

    const patchSetting = (key: keyof MeetingSettings, value: boolean) => {
        const previous = settings ?? DEFAULT_SETTINGS
        setSettings({ ...previous, [key]: value })
        void run(`setting:${key}`, 'Could not update setting', async () => {
            try {
                const { data } = await api.patch<Partial<MeetingSettings>>(`/meetings/${meetingId}/settings`, { [key]: value })
                setSettings({ ...previous, [key]: value, ...(data ?? {}) })
            } catch (err) {
                setSettings(previous)
                throw err
            }
        })
    }

    // ── List ─────────────────────────────────────────────────────────
    const handOrder = useMemo(() => new Map(signals.raisedHands.map((id, i) => [id, i + 1] as const)), [signals.raisedHands])

    const sorted = useMemo(() => {
        const q = search.trim().toLowerCase()
        const list = q
            ? participants.filter((p) => displayName(p).toLowerCase().includes(q) || p.identity.toLowerCase().includes(q))
            : [...participants]
        return list.sort((a, b) => {
            const ha = handOrder.get(a.identity) ?? Infinity
            const hb = handOrder.get(b.identity) ?? Infinity
            if (ha !== hb) return ha - hb
            const hostA = a.identity === hostIdentity ? 0 : 1
            const hostB = b.identity === hostIdentity ? 0 : 1
            if (hostA !== hostB) return hostA - hostB
            if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
            return displayName(a).localeCompare(displayName(b))
        })
    }, [participants, search, handOrder, hostIdentity])

    const code = joinCode ?? meetingJoinCode
    const inviteLink = code ? `${window.location.origin}/join/${code}` : null

    const copyInvite = async () => {
        if (!inviteLink) return
        const ok = await copyText(inviteLink)
        if (ok) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
        } else {
            fail('Copy failed', new Error('Clipboard is not available'))
        }
    }

    const closeMenu = useCallback(() => setMenuFor(null), [])

    return (
        <div className="pnl" role="complementary" aria-label="People">
            <div className="pnl-header">
                <Users size={16} color="var(--color-primary)" />
                <span className="pnl-title">People</span>
                <span className="pnl-count">{participants.length}</span>
                <button type="button" className="btn btn-ghost btn-icon-sm" onClick={onClose} aria-label="Close people panel">
                    <X size={14} />
                </button>
            </div>

            {isHost && (
                <>
                    <div className="ppl-toolbar">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void muteAll()} disabled={busy['mute-all']}>
                            <MicOff size={13} /> Mute all
                        </button>
                        <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={signals.lowerAllHands}
                            disabled={signals.raisedHands.length === 0}
                        >
                            <Hand size={13} /> Lower all hands
                        </button>
                        <button
                            type="button"
                            className={`btn btn-ghost btn-sm${showSettings ? ' is-active' : ''}`}
                            style={{ marginLeft: 'auto' }}
                            onClick={() => setShowSettings((v) => !v)}
                            aria-expanded={showSettings}
                            aria-label="Meeting settings"
                            title="Meeting settings"
                        >
                            <Settings2 size={13} /> Settings
                        </button>
                    </div>

                    {showSettings && (
                        <div className="ppl-settings" role="group" aria-label="Meeting settings">
                            {SETTING_ROWS.map(({ key, label, sub, icon: Icon }) => (
                                <div key={key} className="ppl-setting-row">
                                    <div>
                                        <div className="ppl-setting-label">
                                            <Icon size={14} /> {label}
                                        </div>
                                        <div className="ppl-setting-sub">{sub}</div>
                                    </div>
                                    <label className="pnl-switch" title={label}>
                                        <input
                                            type="checkbox"
                                            checked={(settings ?? DEFAULT_SETTINGS)[key]}
                                            disabled={settings === null || busy[`setting:${key}`]}
                                            onChange={(e) => patchSetting(key, e.target.checked)}
                                            aria-label={label}
                                        />
                                        <span className="pnl-switch-track" />
                                    </label>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            <div className="pnl-search">
                <Search size={13} />
                <input
                    className="input"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search people"
                    aria-label="Search people"
                />
            </div>

            <div className="pnl-body">
                {isHost && (
                    <div className="pnl-section">
                        <div className="pnl-section-title">
                            <span>Waiting to join ({lobby.length})</span>
                            {lobby.length > 1 && (
                                <button type="button" className="btn btn-primary btn-sm" onClick={() => void admitAll()} disabled={busy['lobby:all']}>
                                    <UserCheck size={12} /> Admit all
                                </button>
                            )}
                        </div>
                        {lobby.length === 0 ? (
                            <div className="ppl-lobby-empty">No one is waiting</div>
                        ) : (
                            lobby.map((e) => {
                                const name = e.display_name?.trim() || e.username
                                const rowBusy = busy[`lobby:${e.username}`] || busy['lobby:all']
                                return (
                                    <div key={e.username} className="ppl-lobby-row">
                                        <span className="ppl-avatar" aria-hidden="true">{initials(name)}</span>
                                        <div className="ppl-main">
                                            <div className="ppl-name"><span title={e.username}>{name}</span></div>
                                            <div className="ppl-meta">wants to join</div>
                                        </div>
                                        <div className="ppl-lobby-actions">
                                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void deny(e.username)} disabled={rowBusy} aria-label={`Deny ${name}`}>
                                                <UserX size={12} /> Deny
                                            </button>
                                            <button type="button" className="btn btn-primary btn-sm" onClick={() => void admit(e.username)} disabled={rowBusy} aria-label={`Admit ${name}`}>
                                                <UserCheck size={12} /> Admit
                                            </button>
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </div>
                )}

                <div className="pnl-section">
                    <div className="pnl-section-title">
                        <span>In call ({participants.length})</span>
                        {signals.raisedHands.length > 0 && (
                            <span className="ppl-tag ppl-tag-hand" style={{ marginLeft: 'auto' }}>
                                <Hand size={10} /> {signals.raisedHands.length} raised
                            </span>
                        )}
                    </div>
                    {sorted.length === 0 ? (
                        <div className="ppl-lobby-empty">{search ? 'No one matches your search' : 'Nobody here yet'}</div>
                    ) : (
                        sorted.map((p) => (
                            <ParticipantRow
                                key={p.identity}
                                participant={p}
                                isLocal={p.isLocal}
                                isHostRow={p.identity === hostIdentity}
                                viewerIsHost={isHost}
                                handOrder={handOrder.get(p.identity) ?? null}
                                isPinned={pinned === p.identity}
                                isSpotlit={signals.spotlight === p.identity}
                                menuOpen={menuFor === p.identity}
                                busy={Boolean(busy[`p:${p.identity}`])}
                                onToggleMenu={() => setMenuFor((m) => (m === p.identity ? null : p.identity))}
                                onCloseMenu={closeMenu}
                                onPin={onPin}
                                onMute={() => void muteOne(p.identity)}
                                onStopVideo={() => void stopVideo(p.identity)}
                                onLowerHand={() => (p.isLocal ? void signals.toggleHand() : signals.lowerHand(p.identity))}
                                onSpotlight={() => signals.setSpotlight(signals.spotlight === p.identity ? null : p.identity)}
                                onRemove={() => void remove(p.identity)}
                            />
                        ))
                    )}
                </div>
            </div>

            <div className="pnl-footer">
                <div className="ppl-invite">
                    <Link2 size={14} color="var(--text-muted)" />
                    <span className="ppl-invite-link" title={inviteLink ?? undefined}>
                        {inviteLink ?? 'Invite link unavailable'}
                    </span>
                    <button
                        type="button"
                        className={`btn btn-sm ${copied ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => void copyInvite()}
                        disabled={!inviteLink}
                        aria-label="Copy invite link"
                    >
                        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy link'}
                    </button>
                </div>
            </div>
        </div>
    )
}
