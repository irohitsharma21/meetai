import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
    createLocalAudioTrack, createLocalVideoTrack,
    LocalAudioTrack, LocalVideoTrack, VideoPresets,
} from 'livekit-client'
import { useMediaDevices, useMultibandTrackVolume } from '@livekit/components-react'
import {
    Mic, MicOff, Video, VideoOff, Sparkles, Crown, Users, Copy, Check,
    ChevronDown, Loader2, AlertTriangle,
} from 'lucide-react'
import type { Meeting } from '../../types'
import {
    loadChoices, saveChoices, EFFECT_LABEL,
    type BackgroundEffect, type RoomChoices,
} from './deviceChoices'
import { EffectController } from './useBackgroundEffect'
import { Avatar } from './Tile'

export interface PreJoinProps {
    meeting: Meeting
    isHost: boolean
    /** Display name of the host, as best we know it. */
    hostName: string
    /** Your own display name, for the camera-off avatar. */
    selfName: string
    joining: boolean
    onJoin: (choices: RoomChoices) => void
    onCancel: () => void
}

const EFFECTS: BackgroundEffect[] = ['none', 'blur-light', 'blur-strong']

/**
 * "Ready to join?" - the green room before the call.
 *
 * Owns its own preview tracks rather than a LiveKit room, so nothing is
 * published and the meeting is not joined until the button is pressed.
 * Choices persist to localStorage and are handed to the room on join.
 */
export function PreJoin({ meeting, isHost, hostName, selfName, joining, onJoin, onCancel }: PreJoinProps) {
    const [choices, setChoices] = useState<RoomChoices>(loadChoices)
    const update = useCallback((patch: Partial<RoomChoices>) => {
        setChoices((c) => {
            const next = { ...c, ...patch }
            saveChoices(next)
            return next
        })
    }, [])

    const audioDevices = useMediaDevices({ kind: 'audioinput' })
    const videoDevices = useMediaDevices({ kind: 'videoinput' })

    // ── Camera preview ──
    const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null)
    const [camError, setCamError] = useState<string | null>(null)
    const videoRef = useRef<HTMLVideoElement>(null)
    const effects = useMemo(() => new EffectController(), [])
    const effectsSupported = useMemo(() => EffectController.supported, [])

    useEffect(() => {
        if (!choices.camOn) {
            setVideoTrack(null)
            return
        }
        let cancelled = false
        let track: LocalVideoTrack | null = null
        setCamError(null)
        createLocalVideoTrack({
            deviceId: choices.videoDeviceId ?? undefined,
            resolution: VideoPresets.h720.resolution,
        })
            .then((t) => {
                if (cancelled) {
                    t.stop()
                    return
                }
                track = t
                setVideoTrack(t)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setCamError(err instanceof Error && err.name === 'NotAllowedError'
                    ? 'Camera access is blocked. Allow it in your browser to be seen.'
                    : 'No camera could be started.')
                setVideoTrack(null)
            })
        return () => {
            cancelled = true
            if (track) {
                const t = track
                void effects.release().finally(() => t.stop())
            }
        }
    }, [choices.camOn, choices.videoDeviceId, effects])

    useEffect(() => {
        const el = videoRef.current
        if (!el || !videoTrack) return
        videoTrack.attach(el)
        return () => {
            videoTrack.detach(el)
        }
    }, [videoTrack])

    useEffect(() => {
        if (!videoTrack) return
        if (choices.effect !== 'none' && !effectsSupported) return
        effects.apply(videoTrack, choices.effect).catch(() => {
            setChoices((c) => ({ ...c, effect: 'none' }))
        })
    }, [videoTrack, choices.effect, effects, effectsSupported])

    // ── Microphone preview (level meter only; nothing is sent anywhere) ──
    const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null)
    const [micError, setMicError] = useState<string | null>(null)

    useEffect(() => {
        if (!choices.micOn) {
            setAudioTrack(null)
            return
        }
        let cancelled = false
        let track: LocalAudioTrack | null = null
        setMicError(null)
        createLocalAudioTrack({ deviceId: choices.audioDeviceId ?? undefined })
            .then((t) => {
                if (cancelled) {
                    t.stop()
                    return
                }
                track = t
                setAudioTrack(t)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setMicError(err instanceof Error && err.name === 'NotAllowedError'
                    ? 'Microphone access is blocked. Allow it in your browser to be heard.'
                    : 'No microphone could be started.')
                setAudioTrack(null)
            })
        return () => {
            cancelled = true
            track?.stop()
        }
    }, [choices.micOn, choices.audioDeviceId])

    const bands = useMultibandTrackVolume(audioTrack ?? undefined, { bands: 9, updateInterval: 60 })

    // ── Join ──
    const handleJoin = () => {
        if (joining) return
        saveChoices(choices)
        onJoin(choices)
    }

    const [copied, setCopied] = useState(false)
    const copyCode = async () => {
        if (!meeting.join_code) return
        try {
            await navigator.clipboard.writeText(meeting.join_code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            /* insecure origin - the code is visible on screen anyway */
        }
    }

    const labelFor = (d: MediaDeviceInfo, i: number, kind: 'Microphone' | 'Camera') =>
        d.label || `${kind} ${i + 1}`

    return (
        <div className="room-prejoin">
            <motion.div
                className="room-prejoin-card"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
                {/* ── Preview ── */}
                <div className="room-prejoin-preview">
                    <div className="room-prejoin-video">
                        {choices.camOn && videoTrack && !camError ? (
                            <video ref={videoRef} autoPlay muted playsInline />
                        ) : (
                            <div className="room-prejoin-off">
                                {choices.camOn && !camError ? (
                                    <Loader2 size={26} className="spin" />
                                ) : (
                                    <>
                                        <Avatar name={selfName} identity={selfName} size={88} />
                                        <span>{camError ?? 'Camera is off'}</span>
                                    </>
                                )}
                            </div>
                        )}

                        {choices.effect !== 'none' && videoTrack && (
                            <span className="room-prejoin-chip">
                                <Sparkles size={11} /> {EFFECT_LABEL[choices.effect]}
                            </span>
                        )}

                        <div className="room-prejoin-toggles">
                            <button
                                type="button"
                                className={`room-ctl room-ctl-lg${choices.micOn ? '' : ' is-off'}`}
                                onClick={() => update({ micOn: !choices.micOn })}
                                aria-pressed={choices.micOn}
                                data-tip={choices.micOn ? 'Turn off microphone' : 'Turn on microphone'}
                            >
                                {choices.micOn ? <Mic size={20} /> : <MicOff size={20} />}
                            </button>
                            <button
                                type="button"
                                className={`room-ctl room-ctl-lg${choices.camOn ? '' : ' is-off'}`}
                                onClick={() => update({ camOn: !choices.camOn })}
                                aria-pressed={choices.camOn}
                                data-tip={choices.camOn ? 'Turn off camera' : 'Turn on camera'}
                            >
                                {choices.camOn ? <Video size={20} /> : <VideoOff size={20} />}
                            </button>
                        </div>
                    </div>

                    <div className="room-meter" aria-label="Microphone level">
                        {choices.micOn ? <Mic size={13} /> : <MicOff size={13} />}
                        <div className="room-meter-bars">
                            {Array.from({ length: 9 }, (_, i) => {
                                const v = choices.micOn && audioTrack ? Math.min(1, (bands[i] ?? 0) * 2.2) : 0
                                return (
                                    <span
                                        key={i}
                                        style={{ transform: `scaleY(${Math.max(0.12, v)})`, opacity: v > 0.05 ? 1 : 0.45 }}
                                    />
                                )
                            })}
                        </div>
                        <span className="room-meter-text">
                            {micError ?? (choices.micOn ? (audioTrack ? 'Microphone is working' : 'Starting microphone…') : 'Microphone is off')}
                        </span>
                    </div>
                </div>

                {/* ── Details + settings ── */}
                <div className="room-prejoin-side">
                    <div className="room-prejoin-eyebrow">Ready to join?</div>
                    <h1 className="room-prejoin-title">{meeting.title}</h1>

                    <div className="room-prejoin-meta">
                        {meeting.join_code && (
                            <button type="button" className="code-chip" onClick={copyCode} title="Copy meeting code">
                                <Users size={12} />
                                {meeting.join_code}
                                <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: 22, height: 22 }}>
                                    {copied ? <Check size={12} /> : <Copy size={12} />}
                                </span>
                            </button>
                        )}
                        <span className="room-prejoin-host">
                            <Crown size={12} />
                            {isHost ? 'You are the host' : `Hosted by ${hostName}`}
                        </span>
                    </div>

                    {!isHost && meeting.settings?.waiting_room !== false && (
                        <p className="room-prejoin-note">
                            <AlertTriangle size={13} />
                            This meeting has a waiting room. The host will let you in.
                        </p>
                    )}

                    <div className="room-field">
                        <label className="label" htmlFor="prejoin-mic">Microphone</label>
                        <div className="room-select">
                            <select
                                id="prejoin-mic"
                                className="input"
                                value={choices.audioDeviceId ?? ''}
                                onChange={(e) => update({ audioDeviceId: e.target.value || null })}
                            >
                                <option value="">Default microphone</option>
                                {audioDevices.map((d, i) => (
                                    <option key={d.deviceId} value={d.deviceId}>{labelFor(d, i, 'Microphone')}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} />
                        </div>
                    </div>

                    <div className="room-field">
                        <label className="label" htmlFor="prejoin-cam">Camera</label>
                        <div className="room-select">
                            <select
                                id="prejoin-cam"
                                className="input"
                                value={choices.videoDeviceId ?? ''}
                                onChange={(e) => update({ videoDeviceId: e.target.value || null })}
                            >
                                <option value="">Default camera</option>
                                {videoDevices.map((d, i) => (
                                    <option key={d.deviceId} value={d.deviceId}>{labelFor(d, i, 'Camera')}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} />
                        </div>
                    </div>

                    <div className="room-field">
                        <span className="label">Background</span>
                        <div className="segmented room-effects" role="radiogroup" aria-label="Background effect">
                            {EFFECTS.map((e) => (
                                <button
                                    key={e}
                                    type="button"
                                    role="radio"
                                    className="segment"
                                    aria-checked={choices.effect === e}
                                    aria-pressed={choices.effect === e}
                                    disabled={e !== 'none' && !effectsSupported}
                                    title={e !== 'none' && !effectsSupported ? 'Not supported in this browser' : undefined}
                                    onClick={() => update({ effect: e })}
                                >
                                    {EFFECT_LABEL[e]}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="room-prejoin-actions">
                        <button
                            type="button"
                            className="btn btn-primary btn-lg room-join-btn"
                            onClick={handleJoin}
                            disabled={joining}
                        >
                            {joining ? <><Loader2 size={16} className="spin" /> Joining…</> : 'Join now'}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={joining}>
                            Back to dashboard
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
    )
}
