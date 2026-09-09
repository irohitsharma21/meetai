import { useState } from 'react'
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

interface VideoGridProps {
    meetingId: string
    onEnd: () => void
}

function RoomControls({ onEnd }: VideoGridProps) {
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

export function VideoGrid({ meetingId, onEnd }: VideoGridProps) {
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
            >
                <VideoConference />
                <RoomAudioRenderer />
                <RoomControls meetingId={meetingId} onEnd={onEnd} />
            </LiveKitRoom>
        </div>
    )
}
