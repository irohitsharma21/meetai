import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocalParticipant } from '@livekit/components-react'
import {
    Mic, MicOff, Video, VideoOff, MonitorUp, MonitorOff, Hand, SmilePlus, Captions,
    Sparkles, MoreHorizontal, PhoneOff, MessageSquare, Users, Bot, Copy, Link as LinkIcon,
    Settings2, FileText, Info, Keyboard, LogOut, Ban, ChevronLeft,
} from 'lucide-react'
import { useMeetingRoomStore, useToastStore, type SidePanelKind } from '../../store'
import { Popover, MenuItem, MenuDivider, MenuHeading } from './Popover'
import { ConfirmDialog } from './Dialog'
import { DeviceSettings } from './DeviceSettings'
import { ShortcutSheet, MeetingDetails } from './RoomDialogs'
import { EFFECT_LABEL, type BackgroundEffect } from './deviceChoices'
import { ReactionBar, type useRoomSignals } from './panels'

export type RoomSignals = ReturnType<typeof useRoomSignals>

export interface ControlBarProps {
    meetingId: string
    isHost: boolean
    hostName: string
    title: string
    joinCode: string | null
    startedAt: string | null
    signals: RoomSignals
    effect: BackgroundEffect
    setEffect: (e: BackgroundEffect) => void
    effectsSupported: boolean
    unread: number
    participantCount: number
    waitingCount: number
    compact: boolean
    onLeave: () => void
    onEnd: () => Promise<void>
    ending: boolean
}

type Menu = 'reactions' | 'effects' | 'more' | 'leave' | null
type Sheet = 'devices' | 'shortcuts' | 'details' | 'confirm-end' | null

const EFFECTS: BackgroundEffect[] = ['none', 'blur-light', 'blur-strong']

function Ctl({
    icon, tip, on, off, danger, badge, onClick, className, ariaLabel, disabled,
}: {
    icon: ReactNode
    tip: string
    on?: boolean
    off?: boolean
    danger?: boolean
    badge?: ReactNode
    onClick: () => void
    className?: string
    ariaLabel?: string
    disabled?: boolean
}) {
    const cls = [
        'room-ctl',
        on ? 'is-on' : '',
        off ? 'is-off' : '',
        danger ? 'is-danger' : '',
        className ?? '',
    ].filter(Boolean).join(' ')
    return (
        <button
            type="button"
            className={cls}
            data-tip={tip}
            aria-label={ariaLabel ?? tip}
            aria-pressed={on !== undefined ? on : undefined}
            onClick={onClick}
            disabled={disabled}
        >
            {icon}
            {badge}
        </button>
    )
}

function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * The 56 px pill at the bottom of the room. Everything the user can do to
 * their own media, plus the panel toggles on the right. Rendered inside
 * `<LiveKitRoom>` so the local participant is in scope.
 */
export function ControlBar({
    meetingId, isHost, hostName, title, joinCode, startedAt, signals,
    effect, setEffect, effectsSupported,
    unread, participantCount, waitingCount, compact,
    onLeave, onEnd, ending,
}: ControlBarProps) {
    const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant()
    const addToast = useToastStore((s) => s.addToast)
    const sidePanel = useMeetingRoomStore((s) => s.sidePanel)
    const togglePanel = useMeetingRoomStore((s) => s.togglePanel)
    const captionsOn = useMeetingRoomStore((s) => s.captionsOn)
    const setCaptionsOn = useMeetingRoomStore((s) => s.setCaptionsOn)
    const settings = useMeetingRoomStore((s) => s.meetingSettings)

    const [menu, setMenu] = useState<Menu>(null)
    const [sheet, setSheet] = useState<Sheet>(null)
    const [moreReactions, setMoreReactions] = useState(false)
    const closeMenu = useCallback(() => {
        setMenu(null)
        setMoreReactions(false)
    }, [])
    const openMenu = (m: Menu) => setMenu((cur) => (cur === m ? null : m))

    const allowShare = isHost || settings?.allow_screen_share !== false
    const allowReactions = isHost || settings?.allow_reactions !== false
    const allowChat = isHost || settings?.allow_chat !== false

    // ── Media toggles ──
    const [busy, setBusy] = useState<'mic' | 'cam' | 'share' | null>(null)

    const toggleMic = useCallback(async () => {
        if (busy) return
        setBusy('mic')
        try {
            await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)
        } catch (err) {
            addToast({ type: 'error', title: 'Microphone unavailable', message: err instanceof Error ? err.message : undefined })
        } finally {
            setBusy(null)
        }
    }, [busy, localParticipant, isMicrophoneEnabled, addToast])

    const toggleCam = useCallback(async () => {
        if (busy) return
        setBusy('cam')
        try {
            await localParticipant.setCameraEnabled(!isCameraEnabled)
        } catch (err) {
            addToast({ type: 'error', title: 'Camera unavailable', message: err instanceof Error ? err.message : undefined })
        } finally {
            setBusy(null)
        }
    }, [busy, localParticipant, isCameraEnabled, addToast])

    const toggleShare = useCallback(async () => {
        if (busy) return
        if (!isScreenShareEnabled && !allowShare) {
            addToast({ type: 'info', title: 'Screen sharing is off', message: 'The host has turned off screen sharing for participants.' })
            return
        }
        setBusy('share')
        try {
            await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true })
        } catch (err) {
            // Cancelling the browser picker is not an error worth a toast.
            if (!(err instanceof Error && err.name === 'NotAllowedError')) {
                addToast({ type: 'error', title: 'Could not share screen', message: err instanceof Error ? err.message : undefined })
            }
        } finally {
            setBusy(null)
        }
    }, [busy, isScreenShareEnabled, allowShare, localParticipant, addToast])

    const toggleHand = useCallback(() => {
        void signals.toggleHand()
    }, [signals])

    const toggleCaptions = useCallback(() => setCaptionsOn(!captionsOn), [captionsOn, setCaptionsOn])

    const pickReaction = (emoji: string) => {
        if (!allowReactions) {
            addToast({ type: 'info', title: 'Reactions are off', message: 'The host has turned off reactions for participants.' })
        } else {
            signals.sendReaction(emoji)
        }
        closeMenu()
    }

    // ── Copy helpers ──
    const copy = async (text: string, what: string) => {
        try {
            await navigator.clipboard.writeText(text)
            addToast({ type: 'success', title: `${what} copied` })
        } catch {
            addToast({ type: 'info', title: 'Copy this', message: text })
        }
    }

    // ── Keyboard shortcuts ──
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isTyping(e.target)) return
            const key = e.key.toLowerCase()
            if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'd') {
                e.preventDefault()
                void toggleMic()
            } else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'e') {
                e.preventDefault()
                void toggleCam()
            } else if (e.ctrlKey && e.altKey && key === 'h') {
                e.preventDefault()
                toggleHand()
            } else if (e.ctrlKey && e.altKey && key === 'c') {
                e.preventDefault()
                toggleCaptions()
            } else if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault()
                setSheet((s) => (s === 'shortcuts' ? null : 'shortcuts'))
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [toggleMic, toggleCam, toggleHand, toggleCaptions])

    const panelBtn = (kind: SidePanelKind) => () => togglePanel(kind)

    const secondary = (
        <>
            <Ctl
                icon={isScreenShareEnabled ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
                tip={isScreenShareEnabled ? 'Stop presenting' : allowShare ? 'Present screen' : 'Presenting is off'}
                on={isScreenShareEnabled}
                onClick={() => void toggleShare()}
                disabled={busy === 'share'}
            />
            <Ctl
                icon={<Hand size={20} />}
                tip={signals.handRaised ? 'Lower hand (Ctrl+Alt+H)' : 'Raise hand (Ctrl+Alt+H)'}
                on={signals.handRaised}
                onClick={toggleHand}
            />
            <div className="room-anchor">
                <Ctl
                    icon={<SmilePlus size={20} />}
                    tip="Send a reaction"
                    on={menu === 'reactions'}
                    onClick={() => openMenu('reactions')}
                />
                <Popover open={menu === 'reactions'} onClose={closeMenu} label="Reactions">
                    <ReactionBar onPick={pickReaction} onClose={closeMenu} />
                </Popover>
            </div>
            <Ctl
                icon={<Captions size={20} />}
                tip={captionsOn ? 'Turn off captions (Ctrl+Alt+C)' : 'Turn on captions (Ctrl+Alt+C)'}
                on={captionsOn}
                onClick={toggleCaptions}
            />
            <div className="room-anchor">
                <Ctl
                    icon={<Sparkles size={20} />}
                    tip="Background effects"
                    on={menu === 'effects' || effect !== 'none'}
                    onClick={() => openMenu('effects')}
                />
                <Popover open={menu === 'effects'} onClose={closeMenu} label="Background effects" width={220}>
                    <MenuHeading>Background</MenuHeading>
                    {EFFECTS.map((e) => (
                        <MenuItem
                            key={e}
                            label={EFFECT_LABEL[e]}
                            checked={effect === e}
                            disabled={e !== 'none' && !effectsSupported}
                            hint={e !== 'none' && !effectsSupported ? 'Unsupported' : undefined}
                            onSelect={() => { setEffect(e); closeMenu() }}
                        />
                    ))}
                </Popover>
            </div>
        </>
    )

    return (
        <>
            <footer className={`room-bar${compact ? ' is-compact' : ''}`}>
                <div className="room-bar-left" aria-hidden="true" />

                <div className="room-bar-center" role="toolbar" aria-label="Call controls">
                    <Ctl
                        icon={isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                        tip={isMicrophoneEnabled ? 'Mute (Ctrl+D)' : 'Unmute (Ctrl+D)'}
                        off={!isMicrophoneEnabled}
                        onClick={() => void toggleMic()}
                        disabled={busy === 'mic'}
                    />
                    <Ctl
                        icon={isCameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                        tip={isCameraEnabled ? 'Turn off camera (Ctrl+E)' : 'Turn on camera (Ctrl+E)'}
                        off={!isCameraEnabled}
                        onClick={() => void toggleCam()}
                        disabled={busy === 'cam'}
                    />

                    {!compact && secondary}

                    <div className="room-anchor">
                        <Ctl
                            icon={<MoreHorizontal size={20} />}
                            tip="More options"
                            on={menu === 'more'}
                            onClick={() => openMenu('more')}
                        />
                        <Popover open={menu === 'more'} onClose={closeMenu} label="More options" width={moreReactions ? undefined : 260}>
                            {moreReactions ? (
                                <>
                                    <button type="button" className="room-menu-item" onClick={() => setMoreReactions(false)}>
                                        <span className="room-menu-icon"><ChevronLeft size={15} /></span>
                                        <span className="room-menu-label">Back</span>
                                    </button>
                                    <ReactionBar onPick={pickReaction} onClose={closeMenu} />
                                </>
                            ) : (
                                <>
                                    {compact && (
                                        <>
                                            <MenuItem
                                                icon={isScreenShareEnabled ? <MonitorOff size={15} /> : <MonitorUp size={15} />}
                                                label={isScreenShareEnabled ? 'Stop presenting' : 'Present screen'}
                                                onSelect={() => { closeMenu(); void toggleShare() }}
                                            />
                                            <MenuItem
                                                icon={<Hand size={15} />}
                                                label={signals.handRaised ? 'Lower hand' : 'Raise hand'}
                                                checked={signals.handRaised}
                                                onSelect={() => { closeMenu(); toggleHand() }}
                                            />
                                            <MenuItem
                                                icon={<SmilePlus size={15} />}
                                                label="Send a reaction"
                                                onSelect={() => setMoreReactions(true)}
                                            />
                                            <MenuItem
                                                icon={<Captions size={15} />}
                                                label="Captions"
                                                checked={captionsOn}
                                                onSelect={() => { closeMenu(); toggleCaptions() }}
                                            />
                                            <MenuHeading>Background</MenuHeading>
                                            {EFFECTS.map((e) => (
                                                <MenuItem
                                                    key={e}
                                                    icon={<Sparkles size={15} />}
                                                    label={EFFECT_LABEL[e]}
                                                    checked={effect === e}
                                                    disabled={e !== 'none' && !effectsSupported}
                                                    onSelect={() => { setEffect(e); closeMenu() }}
                                                />
                                            ))}
                                            <MenuDivider />
                                            <MenuItem
                                                icon={<Bot size={15} />}
                                                label="AI assistant"
                                                checked={sidePanel === 'assistant'}
                                                onSelect={() => { closeMenu(); togglePanel('assistant') }}
                                            />
                                        </>
                                    )}
                                    <MenuItem
                                        icon={<FileText size={15} />}
                                        label="Transcript"
                                        checked={sidePanel === 'transcript'}
                                        onSelect={() => { closeMenu(); togglePanel('transcript') }}
                                    />
                                    <MenuItem
                                        icon={<Settings2 size={15} />}
                                        label="Devices"
                                        onSelect={() => { closeMenu(); setSheet('devices') }}
                                    />
                                    <MenuDivider />
                                    <MenuItem
                                        icon={<LinkIcon size={15} />}
                                        label="Copy invite link"
                                        disabled={!joinCode}
                                        onSelect={() => { closeMenu(); if (joinCode) void copy(`${window.location.origin}/join/${joinCode}`, 'Invite link') }}
                                    />
                                    <MenuItem
                                        icon={<Copy size={15} />}
                                        label="Copy meeting code"
                                        hint={joinCode ?? undefined}
                                        disabled={!joinCode}
                                        onSelect={() => { closeMenu(); if (joinCode) void copy(joinCode, 'Meeting code') }}
                                    />
                                    <MenuItem
                                        icon={<Info size={15} />}
                                        label="Meeting details"
                                        onSelect={() => { closeMenu(); setSheet('details') }}
                                    />
                                    <MenuItem
                                        icon={<Keyboard size={15} />}
                                        label="Keyboard shortcuts"
                                        hint="?"
                                        onSelect={() => { closeMenu(); setSheet('shortcuts') }}
                                    />
                                </>
                            )}
                        </Popover>
                    </div>

                    {isHost ? (
                        <div className="room-anchor">
                            <Ctl
                                icon={<PhoneOff size={20} />}
                                tip="Leave or end"
                                danger
                                className="room-ctl-leave"
                                onClick={() => openMenu('leave')}
                                disabled={ending}
                            />
                            <Popover open={menu === 'leave'} onClose={closeMenu} align="right" width={250} label="Leave">
                                <MenuItem
                                    icon={<LogOut size={15} />}
                                    label="Leave meeting"
                                    hint="Others stay"
                                    onSelect={() => { closeMenu(); onLeave() }}
                                />
                                <MenuItem
                                    icon={<Ban size={15} />}
                                    label="End meeting for everyone"
                                    danger
                                    onSelect={() => { closeMenu(); setSheet('confirm-end') }}
                                />
                            </Popover>
                        </div>
                    ) : (
                        <Ctl
                            icon={<PhoneOff size={20} />}
                            tip="Leave meeting"
                            danger
                            className="room-ctl-leave"
                            onClick={onLeave}
                        />
                    )}
                </div>

                <div className="room-bar-right" role="toolbar" aria-label="Panels">
                    <Ctl
                        icon={<MessageSquare size={19} />}
                        tip={allowChat ? 'Chat' : 'Chat (read only)'}
                        on={sidePanel === 'chat'}
                        onClick={panelBtn('chat')}
                        badge={unread > 0 && sidePanel !== 'chat' ? (
                            <span className="room-ctl-badge is-alert">{unread > 99 ? '99+' : unread}</span>
                        ) : null}
                    />
                    <Ctl
                        icon={<Users size={19} />}
                        tip="Participants"
                        on={sidePanel === 'participants'}
                        onClick={panelBtn('participants')}
                        badge={(
                            <>
                                <span className="room-ctl-badge">{participantCount}</span>
                                {isHost && waitingCount > 0 && (
                                    <span className="room-ctl-badge is-wait" title={`${waitingCount} waiting`}>
                                        {waitingCount}
                                    </span>
                                )}
                            </>
                        )}
                    />
                    {!compact && (
                        <Ctl
                            icon={<Bot size={19} />}
                            tip="AI assistant"
                            on={sidePanel === 'assistant'}
                            onClick={panelBtn('assistant')}
                        />
                    )}
                </div>
            </footer>

            <DeviceSettings open={sheet === 'devices'} onClose={() => setSheet(null)} />
            <ShortcutSheet open={sheet === 'shortcuts'} onClose={() => setSheet(null)} />
            <MeetingDetails
                open={sheet === 'details'}
                onClose={() => setSheet(null)}
                meetingId={meetingId}
                title={title}
                joinCode={joinCode}
                hostName={hostName}
                startedAt={startedAt}
                isHost={isHost}
            />
            <ConfirmDialog
                open={sheet === 'confirm-end'}
                onClose={() => setSheet(null)}
                onConfirm={() => { void onEnd() }}
                title="End meeting for everyone?"
                body="Everyone will be disconnected and the AI report will start generating. This cannot be undone."
                confirmLabel="End meeting"
                busy={ending}
            />
        </>
    )
}
