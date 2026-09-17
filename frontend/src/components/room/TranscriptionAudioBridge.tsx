import { useCallback, useEffect } from 'react'
import { useLocalParticipant } from '@livekit/components-react'
import { useMeetingRoomStore } from '../../store'
import { useAudioCapture } from '../../hooks/useWebSocket'

/**
 * Feeds the transcriber from the microphone LiveKit is already publishing.
 *
 * Lives inside LiveKitRoom because that is the only place the local
 * participant - and therefore the authoritative mute state - is visible. It
 * renders nothing.
 */
export function TranscriptionAudioBridge({ onAudioChunk }: { onAudioChunk?: (d: ArrayBuffer) => void }) {
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
