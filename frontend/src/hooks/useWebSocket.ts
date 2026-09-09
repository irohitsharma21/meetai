import { useEffect, useRef, useCallback } from 'react'
import { useMeetingRoomStore, useToastStore } from '../store'
import type { WSMessage } from '../types'

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'

export function useMeetingWebSocket(meetingId: string | null) {
    const wsRef = useRef<WebSocket | null>(null)
    const mounted = useRef(true)
    const { addTranscriptEntry, addPendingAction } = useMeetingRoomStore()

    const connect = useCallback(() => {
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
                setTimeout(connect, 3000)
            }
        }
    }, [meetingId, addTranscriptEntry, addPendingAction])

    useEffect(() => {
        mounted.current = true
        connect()
        return () => {
            mounted.current = false
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
export function useAudioCapture(
    onChunk: (data: ArrayBuffer) => void,
    enabled: boolean
) {
    const mediaRef = useRef<MediaRecorder | null>(null)
    const streamRef = useRef<MediaStream | null>(null)

    useEffect(() => {
        if (!enabled) {
            mediaRef.current?.stop()
            streamRef.current?.getTracks().forEach((t) => t.stop())
            return
        }

        const start = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        sampleRate: 16000,
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                    },
                })
                streamRef.current = stream

                const recorder = new MediaRecorder(stream, {
                    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                        ? 'audio/webm;codecs=opus'
                        : 'audio/webm',
                })

                recorder.ondataavailable = async (e) => {
                    if (e.data.size > 0) {
                        const buf = await e.data.arrayBuffer()
                        onChunk(buf)
                    }
                }

                // Emit chunks every 1.5 seconds
                recorder.start(1500)
                mediaRef.current = recorder
            } catch (err) {
                console.error('Audio capture failed:', err)
                useToastStore.getState().addToast({
                    type: 'error',
                    title: 'Microphone Error',
                    message: 'Could not access your microphone. Please check browser permissions.'
                })
            }
        }

        start()
        return () => {
            mediaRef.current?.stop()
            streamRef.current?.getTracks().forEach((t) => t.stop())
        }
    }, [enabled, onChunk])
}
