import { memo, type CSSProperties } from 'react'
import { motion } from 'framer-motion'
import { ConnectionQuality, Track } from 'livekit-client'
import {
    VideoTrack, isTrackReference,
    useIsSpeaking, useIsMuted, useConnectionQualityIndicator,
    useParticipantAttribute, useParticipantInfo, useTrackMutedIndicator,
    type TrackReferenceOrPlaceholder,
} from '@livekit/components-react'
import { MicOff, Hand, Crown, Pin, PinOff, MonitorUp, Wifi, WifiOff } from 'lucide-react'
import { useAuthStore, useMeetingRoomStore } from '../../store'

export type TileVariant = 'grid' | 'focus' | 'strip'

export interface TileProps {
    trackRef: TrackReferenceOrPlaceholder
    /** Stable key: `<identity>` for a camera, `<identity>:screen` for a share. */
    tileKey: string
    isHost: boolean
    pinned: boolean
    onPin: (key: string | null) => void
    variant: TileVariant
    style?: CSSProperties
}

/** Key used for pins. Screen shares get their own so both can show at once. */
export function tileKeyOf(ref: TrackReferenceOrPlaceholder): string {
    return ref.source === Track.Source.ScreenShare
        ? `${ref.participant.identity}:screen`
        : ref.participant.identity
}

export function initialsOf(name: string): string {
    const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
    if (!parts.length) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Deterministic hue per identity so a person keeps their colour across tiles. */
function hueOf(identity: string): number {
    let h = 0
    for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) >>> 0
    return h % 360
}

export function Avatar({ name, identity, size = 72 }: { name: string; identity: string; size?: number }) {
    const hue = hueOf(identity)
    return (
        <div
            className="room-avatar"
            aria-hidden="true"
            style={{
                width: size, height: size, fontSize: size * 0.36,
                background: `linear-gradient(145deg, hsl(${hue} 48% 42%), hsl(${(hue + 40) % 360} 46% 30%))`,
            }}
        >
            {initialsOf(name)}
        </div>
    )
}

function QualityIcon({ quality }: { quality: ConnectionQuality }) {
    if (quality === ConnectionQuality.Lost) return <WifiOff size={12} />
    return <Wifi size={12} />
}

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
    [ConnectionQuality.Excellent]: 'Connection: excellent',
    [ConnectionQuality.Good]: 'Connection: good',
    [ConnectionQuality.Poor]: 'Connection: poor',
    [ConnectionQuality.Lost]: 'Connection lost',
    [ConnectionQuality.Unknown]: 'Connection: unknown',
}

/**
 * One participant on the stage: video or initials, and every badge that says
 * who they are and what state they are in. Rendered inside `<LiveKitRoom>`.
 */
export const Tile = memo(function Tile({ trackRef, tileKey, isHost, pinned, onPin, variant, style }: TileProps) {
    const { participant } = trackRef
    const isScreen = trackRef.source === Track.Source.ScreenShare
    const { name, identity } = useParticipantInfo({ participant })
    // The token may carry no display name. The meeting document usually
    // does - in the participant list, or the lobby entry for someone who
    // came through the waiting room - and for ourselves the signed-in user.
    const selfName = useAuthStore((s) => (participant.isLocal ? s.user?.display_name : undefined))
    const docName = useMeetingRoomStore((s) => {
        const m = s.currentMeeting
        if (!m) return undefined
        const id = participant.identity
        return m.participants?.find((p) => p.username === id)?.display_name
            || m.lobby?.find((p) => p.username === id)?.display_name
    })
    // A token name that merely repeats the identity is not a display name.
    const tokenName = name && name !== participant.identity ? name : undefined
    const displayName = tokenName || selfName || docName || identity || participant.identity
    const speaking = useIsSpeaking(participant)
    const { quality } = useConnectionQualityIndicator({ participant })
    const { isMuted: micMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone })
    const camMuted = useIsMuted(trackRef)
    const handRaised = useParticipantAttribute('hand_raised', { participant }) === '1'

    const hasVideo = isTrackReference(trackRef) && !camMuted
    const mirror = participant.isLocal && !isScreen
    const label = isScreen
        ? `${participant.isLocal ? 'Your' : `${displayName}'s`} screen`
        : participant.isLocal ? `${displayName} (You)` : displayName

    const classes = [
        'room-tile',
        `room-tile-${variant}`,
        speaking && !isScreen ? 'is-speaking' : '',
        isScreen ? 'is-screen' : '',
        pinned ? 'is-pinned' : '',
        quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost ? 'is-poor' : '',
    ].filter(Boolean).join(' ')

    return (
        <motion.div
            layout
            layoutId={`tile-${tileKey}`}
            className={classes}
            style={style}
            data-identity={participant.identity}
            transition={{ layout: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
        >
            {hasVideo ? (
                <VideoTrack
                    trackRef={trackRef}
                    className={`room-tile-video${mirror ? ' is-mirrored' : ''}`}
                    manageSubscription={!participant.isLocal}
                />
            ) : (
                <div className="room-tile-off">
                    <Avatar
                        name={displayName}
                        identity={participant.identity}
                        size={variant === 'strip' ? 40 : variant === 'focus' ? 120 : 72}
                    />
                </div>
            )}

            {/* Top-right status cluster */}
            <div className="room-tile-status">
                {handRaised && !isScreen && (
                    <span className="room-badge room-badge-hand" title="Hand raised">
                        <Hand size={12} />
                    </span>
                )}
                {(quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) && (
                    <span className="room-badge room-badge-poor" title={QUALITY_LABEL[quality]}>
                        <QualityIcon quality={quality} />
                    </span>
                )}
            </div>

            {/* Hover toolbar */}
            <div className="room-tile-tools">
                <button
                    type="button"
                    className={`room-tile-tool${pinned ? ' is-on' : ''}`}
                    onClick={() => onPin(pinned ? null : tileKey)}
                    data-tip={pinned ? 'Unpin' : 'Pin to stage'}
                    aria-label={pinned ? 'Unpin' : 'Pin'}
                >
                    {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
            </div>

            {/* Name label */}
            <div className="room-tile-label">
                {isScreen ? <MonitorUp size={12} /> : micMuted ? <MicOff size={12} className="room-tile-muted" /> : null}
                <span className="room-tile-name">{label}</span>
                {isHost && !isScreen && (
                    <span className="room-badge room-badge-host" title="Host">
                        <Crown size={10} /> Host
                    </span>
                )}
                {pinned && (
                    <span className="room-badge room-badge-pin" title="Pinned">
                        <Pin size={10} />
                    </span>
                )}
            </div>
        </motion.div>
    )
})
