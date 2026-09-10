import { useCallback, useEffect, useState } from 'react'
import {
    LiveKitRoom,
    VideoConference,
    useLocalParticipant,
    RoomAudioRenderer,
} from '@livekit/components-react'
import '@livekit/components-styles'
import {
    Mic, MicOff, Video, VideoOff, PhoneOff,
    ScreenShare, ScreenShareOff,
} from 'lucide-react'
import { useMeetingRoomStore } from '../../store'
import { useAudioCapture } from '../../hooks/useWebSocket'

interface VideoGridProps {
    meetingId: string
    /** Host action: end the meeting for everyone. */
    onEnd: () => void
    /**
     * This participant has left the room - by pressing Leave, or because the
     * connection dropped for good. Distinct from onEnd: leaving is a personal
     * act, ending is done to the meeting.
     */
    onLeave?: () => void
    /**
     * Raw audio for transcription. Only ever called while LiveKit reports the
     * microphone as enabled.
     */
    onAudioChunk?: (data: ArrayBuffer) => void
}

/**
 * Feeds the transcriber from the microphone LiveKit is already publishing.
 *
 * Lives inside LiveKitRoom because that is the only place the local
 * participant - and therefore the authoritative mute state - is visible. It
 * renders nothing.
 */
function TranscriptionAudioBridge({ onAudioChunk }: { onAudioChunk?: (d: ArrayBuffer) => void }) {
    const { isMicrophoneEnabled, microphoneTrack } = useLocalParticipant()
    const setMicMuted = useMeetingRoomStore((s) => s.setMicMuted)

    // Keep the rest of the app in step with LiveKit rather than with a flag
    // only our own buttons update.
    useEffect(() => {
        setMicMuted(!isMicrophoneEnabled)
    }, [isMicrophoneEnabled, setMicMuted])

    const track = microphoneTrack?.track?.mediaStreamTrack ?? null
    const send = useCallback((data: ArrayBuffer) => onAudioChunk?.(data), [onAudioChunk])

    useAudioCapture(send, isMicrophoneEnabled && !!onAudioChunk, track)
    return null
}

function RoomControls({ onEnd }: Pick<VideoGridProps, 'meetingId' | 'onEnd'>) {
    const { isMicrophoneEnabled, isCameraEnabled, localParticipant } = useLocalParticipant()
    const { toggleMic, toggleCamera } = useMeetingRoomStore()
    const [isSharing, setIsSharing] = useState(false)

    const handleMicToggle = async () => {
        await localParticipant.setMicrophoneEnabled(isMicrophoneEnabled ? false : true)
        toggleMic()
    }

    const handleCameraToggle = async () => {
        await localParticipant.setCameraEnabled(isCameraEnabled ? false : true)
        toggleCamera()
    }

    const handleScreenShare = async () => {
        if (isSharing) {
            await localParticipant.setScreenShareEnabled(false)
        } else {
            await localParticipant.setScreenShareEnabled(true)
        }
        setIsSharing(!isSharing)
    }

    return (
        <div className="controls-bar">
            {/* Recording indicator - always visible during meeting */}
            <div className="recording-indicator" style={{ marginRight: 'auto' }}>
                <span className="recording-dot" />
                REC
            </div>

            <button
                className={`control-btn ${isMicrophoneEnabled ? 'active' : 'muted'}`}
                onClick={handleMicToggle}
                title={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
            >
                {isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
            </button>

            <button
                className={`control-btn ${isCameraEnabled ? 'active' : 'muted'}`}
                onClick={handleCameraToggle}
                title={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
            >
                {isCameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}
            </button>

            <button
                className={`control-btn ${isSharing ? 'muted' : 'active'}`}
                onClick={handleScreenShare}
                title={isSharing ? 'Stop sharing' : 'Share screen'}
            >
                {isSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
            </button>

            <button
                className="control-btn end-call"
                onClick={onEnd}
                title="End meeting"
            >
                <PhoneOff size={20} />
            </button>
        </div>
    )
}

export function VideoGrid({ meetingId, onEnd, onLeave, onAudioChunk }: VideoGridProps) {
    const { livekitToken, livekitUrl } = useMeetingRoomStore()

    if (!livekitToken || !livekitUrl) {
        return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: 'var(--text-muted)' }}>Connecting to room…</p>
            </div>
        )
    }

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-bg-base)' }}>
            <LiveKitRoom
                token={livekitToken}
                serverUrl={livekitUrl}
                connect={true}
                video={true}
                audio={true}
                style={{ flex: 1, overflow: 'hidden' }}
                /*
                 * The Leave button inside LiveKit's own control bar calls
                 * room.disconnect() and nothing else - it has no idea this app
                 * has routes. Without this the room tears down and the user is
                 * left looking at an empty stage on a page they have already
                 * left. This is the only hook that catches both that button and
                 * a connection that has genuinely given up.
                 */
                onDisconnected={onLeave}
            >
                <VideoConference />
                <RoomAudioRenderer />
                <TranscriptionAudioBridge onAudioChunk={onAudioChunk} />
                <RoomControls meetingId={meetingId} onEnd={onEnd} />
            </LiveKitRoom>
        </div>
    )
}
