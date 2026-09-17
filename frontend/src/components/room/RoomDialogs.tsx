import { useState } from 'react'
import { Keyboard, Info, Copy, Check, Link as LinkIcon, Crown, Clock, Lock, DoorOpen, MessageSquare, MonitorUp, SmilePlus } from 'lucide-react'
import { Dialog } from './Dialog'
import { meetingApi, errorMessage } from '../../lib/api'
import { useMeetingRoomStore, useToastStore } from '../../store'
import type { MeetingSettings } from '../../types'

const SHORTCUTS: { keys: string[]; what: string }[] = [
    { keys: ['Ctrl', 'D'], what: 'Mute / unmute microphone' },
    { keys: ['Ctrl', 'E'], what: 'Turn camera on / off' },
    { keys: ['Ctrl', 'Alt', 'H'], what: 'Raise / lower hand' },
    { keys: ['Ctrl', 'Alt', 'C'], what: 'Toggle captions' },
    { keys: ['?'], what: 'Show this sheet' },
    { keys: ['Esc'], what: 'Close menus and panels' },
]

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" icon={<Keyboard size={15} />} width={400}>
            <ul className="room-keys">
                {SHORTCUTS.map((s) => (
                    <li key={s.what}>
                        <span className="room-keys-what">{s.what}</span>
                        <span className="room-keys-combo">
                            {s.keys.map((k) => <kbd key={k}>{k}</kbd>)}
                        </span>
                    </li>
                ))}
            </ul>
        </Dialog>
    )
}

const SETTING_ROWS: { key: keyof MeetingSettings; icon: typeof Lock; label: string; hint: string }[] = [
    { key: 'waiting_room', icon: DoorOpen, label: 'Waiting room', hint: 'New people wait until you admit them' },
    { key: 'locked', icon: Lock, label: 'Lock meeting', hint: 'Nobody new can join, even if admitted' },
    { key: 'allow_chat', icon: MessageSquare, label: 'Allow chat', hint: 'Participants can send messages' },
    { key: 'allow_screen_share', icon: MonitorUp, label: 'Allow screen share', hint: 'Participants can present' },
    { key: 'allow_reactions', icon: SmilePlus, label: 'Allow reactions', hint: 'Participants can send emoji' },
]

export interface MeetingDetailsProps {
    open: boolean
    onClose: () => void
    meetingId: string
    title: string
    joinCode: string | null
    hostName: string
    startedAt: string | null
    isHost: boolean
}

/** Meeting info + (for the host) the room settings switches. */
export function MeetingDetails({ open, onClose, meetingId, title, joinCode, hostName, startedAt, isHost }: MeetingDetailsProps) {
    const settings = useMeetingRoomStore((s) => s.meetingSettings)
    const setMeetingSettings = useMeetingRoomStore((s) => s.setMeetingSettings)
    const addToast = useToastStore((s) => s.addToast)
    const [copied, setCopied] = useState<'code' | 'link' | null>(null)
    const [saving, setSaving] = useState<keyof MeetingSettings | null>(null)

    const link = joinCode ? `${window.location.origin}/join/${joinCode}` : null

    const copy = async (text: string, which: 'code' | 'link') => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(which)
            setTimeout(() => setCopied(null), 1500)
        } catch {
            addToast({ type: 'info', title: 'Copy this', message: text })
        }
    }

    const toggle = async (key: keyof MeetingSettings) => {
        if (!settings || saving) return
        const next = !settings[key]
        setSaving(key)
        try {
            const res = await meetingApi.updateSettings(meetingId, { [key]: next })
            setMeetingSettings(res.data as MeetingSettings)
        } catch (err) {
            addToast({ type: 'error', title: 'Could not update setting', message: errorMessage(err) })
        } finally {
            setSaving(null)
        }
    }

    const started = startedAt ? new Date(startedAt) : null

    return (
        <Dialog open={open} onClose={onClose} title="Meeting details" icon={<Info size={15} />} width={460}>
            <div className="room-details">
                <div className="room-details-title">{title}</div>
                <div className="room-details-row">
                    <Crown size={13} /> Hosted by {hostName}
                </div>
                {started && !Number.isNaN(started.getTime()) && (
                    <div className="room-details-row">
                        <Clock size={13} /> Started {started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                )}
                {joinCode && (
                    <div className="room-details-copy">
                        <div>
                            <div className="label">Meeting code</div>
                            <code>{joinCode}</code>
                        </div>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => copy(joinCode, 'code')}>
                            {copied === 'code' ? <Check size={12} /> : <Copy size={12} />} Copy
                        </button>
                    </div>
                )}
                {link && (
                    <div className="room-details-copy">
                        <div style={{ minWidth: 0 }}>
                            <div className="label">Invite link</div>
                            <code className="room-details-link">{link}</code>
                        </div>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => copy(link, 'link')}>
                            {copied === 'link' ? <Check size={12} /> : <LinkIcon size={12} />} Copy
                        </button>
                    </div>
                )}
            </div>

            {isHost && settings && (
                <div className="room-settings">
                    <div className="room-menu-heading">Host controls</div>
                    {SETTING_ROWS.map(({ key, icon: Icon, label, hint }) => (
                        <label key={key} className="room-setting">
                            <Icon size={15} />
                            <span className="room-setting-text">
                                <span>{label}</span>
                                <span className="room-setting-hint">{hint}</span>
                            </span>
                            <input
                                type="checkbox"
                                role="switch"
                                className="room-switch"
                                checked={settings[key]}
                                disabled={saving !== null}
                                onChange={() => void toggle(key)}
                                aria-label={label}
                            />
                        </label>
                    ))}
                </div>
            )}
        </Dialog>
    )
}
