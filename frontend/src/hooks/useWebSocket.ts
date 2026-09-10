import { useEffect, useRef, useCallback } from 'react'
import { useMeetingRoomStore, useToastStore } from '../store'
import type { WSMessage } from '../types'

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:8010'

export function useMeetingWebSocket(meetingId: string | null) {
    const wsRef = useRef<WebSocket | null>(null)
    const mounted = useRef(true)
    // Held so leaving the room can cancel a pending reconnect. Without this the
    // timer fires after unmount and opens a socket for a meeting nobody is in,
    // which then closes, and schedules another - one zombie connection per
    // visit to the room.
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const { addTranscriptEntry, addPendingAction, setTranscriptionStatus } = useMeetingRoomStore()

    const connect = useCallback(() => {
        // A reconnect scheduled just before unmount can still arrive here.
        if (!mounted.current) return
        if (!meetingId) {
            console.log('[WS] No meetingId, skipping connection');
            return
        }
        const token = localStorage.getItem('access_token')
        if (!token) {
            console.error('[WS] No access token found');
            return
        }

        const url = `${WS_BASE}/meetings/${meetingId}/ws`
        console.log(`[WS] Connecting to ${url}...`)
        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onopen = () => {
            console.log('[WS] Connection established');
            // Send identify message
            ws.send(JSON.stringify({ cmd: 'identify', token }))
            ws.send(JSON.stringify({ cmd: 'audio_config', format: 'webm', sample_rate: 16000 }))
            useMeetingRoomStore.getState().setConnected(true)
        }

        ws.onmessage = (event) => {
            if (!mounted.current) return
            try {
                const msg: WSMessage = JSON.parse(event.data)
                console.debug('[WS] Message received:', msg.type)

                switch (msg.type) {
                    case 'transcript':
                        addTranscriptEntry(msg.entry)
                        break
                    case 'transcription_status':
                        setTranscriptionStatus({
                            available: msg.available,
                            reason: msg.reason,
                            model: msg.model,
                            provider: msg.provider,
                        })
                        break
                    case 'action_detected':
                        if (msg.result.trigger) {
                            addPendingAction(msg.result)
                        }
                        break
                    case 'error':
                        console.error('[WS] Server error:', msg.message)
                        useToastStore.getState().addToast({
                            type: 'error',
                            title: 'Transcription Error',
                            message: msg.message
                        })
                        break
                }
            } catch (e) {
                console.warn('[WS] Failed to parse message', e)
            }
        }

        ws.onerror = (err) => {
            console.error('[WS] Connection error:', err)
        }

        ws.onclose = (event) => {
            console.log(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason})`)
            if (mounted.current) {
                useMeetingRoomStore.getState().setConnected(false)
                if (event.code === 4001 || event.code === 4004) {
                    console.error('[WS] Critical failure, not reconnecting');
                    return
                }
                // Reconnect after 3s
                retryRef.current = setTimeout(connect, 3000)
            }
        }
    }, [meetingId, addTranscriptEntry, addPendingAction, setTranscriptionStatus])

    useEffect(() => {
        mounted.current = true
        connect()
        return () => {
            mounted.current = false
            if (retryRef.current) {
                clearTimeout(retryRef.current)
                retryRef.current = null
            }
            wsRef.current?.close()
        }
    }, [connect])

    const sendAudio = useCallback((audioData: ArrayBuffer) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(audioData)
        }
    }, [])

    return { sendAudio }
}

// ── Audio capture hook ───────────────────────────────────────────────
/**
 * Record the microphone for transcription.
 *
 * `track` must be the microphone track LiveKit is already publishing, and
 * `enabled` must be LiveKit's own view of whether the mic is on.
 *
 * This used to call getUserMedia itself, which opened a *second*, independent
 * microphone stream, and gated it on a store flag that only this app's custom
 * control bar ever set. The mute button people actually press belongs to
 * LiveKit's control bar, which mutes LiveKit's track and knows nothing about
 * that flag - so muting silenced the call while this stream carried on
 * recording and sending audio away for transcription. Someone who had muted
 * was still being transcribed.
 *
 * Sharing LiveKit's track makes that structurally impossible: there is one
 * microphone, and if it is muted there is nothing to record.
 */
export function useAudioCapture(
    onChunk: (data: ArrayBuffer) => void,
    enabled: boolean,
    track: MediaStreamTrack | null,
) {
    const mediaRef = useRef<MediaRecorder | null>(null)

    useEffect(() => {
        // No track, or the mic is off: make sure nothing is recording. The
        // cleanup below also covers this, but being explicit means a mute
        // stops capture immediately rather than on the next render.
        if (!enabled || !track) {
            if (mediaRef.current && mediaRef.current.state !== 'inactive') {
                mediaRef.current.stop()
            }
            mediaRef.current = null
            return
        }

        let recorder: MediaRecorder
        try {
            // A new MediaStream wrapping LiveKit's track - not a new capture.
            // Stopping this recorder never stops LiveKit's own publication.
            recorder = new MediaRecorder(new MediaStream([track]), {
                mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm',
            })
        } catch (err) {
            console.error('Could not record the microphone track:', err)
            useToastStore.getState().addToast({
                type: 'error',
                title: 'Transcription unavailable',
                message: 'This browser could not record the microphone for transcription.',
            })
            return
        }

        recorder.ondataavailable = async (e) => {
            if (e.data.size > 0) onChunk(await e.data.arrayBuffer())
        }

        // 1.5s chunks. Deepgram's streaming endpoint keeps decoder state across
        // the whole socket, so these can be raw WebM clusters.
        recorder.start(1500)
        mediaRef.current = recorder

        return () => {
            if (recorder.state !== 'inactive') recorder.stop()
            mediaRef.current = null
        }
    }, [enabled, track, onChunk])
}
