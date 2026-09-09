import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Video, Bot, Zap } from 'lucide-react'
import { VideoGrid } from '../../components/meeting/VideoGrid'
import { TranscriptPanel } from '../../components/meeting/TranscriptPanel'
import { ActionPopupSystem } from '../../components/meeting/ActionPopup'
import { useMeetingRoomStore, useToastStore } from '../../store'
import { meetingApi } from '../../lib/api'
import { useMeetingWebSocket, useAudioCapture } from '../../hooks/useWebSocket'
import type { Meeting } from '../../types'

export function MeetingRoomPage() {
    const { meetingId } = useParams<{ meetingId: string }>()
    const navigate = useNavigate()
    const { addToast } = useToastStore()
    const {
        currentMeeting, setMeeting, clearRoom, livekitToken,
        roomRole, isConnected, isMicMuted,
    } = useMeetingRoomStore()

    const [isJoining, setIsJoining] = useState(true)
    const [isEnding, setIsEnding] = useState(false)

    // WebSocket for transcription
    const { sendAudio } = useMeetingWebSocket(meetingId && livekitToken ? meetingId : null)

    // Audio capture → WebSocket
    const handleAudioChunk = useCallback((data: ArrayBuffer) => {
        sendAudio(data)
    }, [sendAudio])

    useAudioCapture(handleAudioChunk, !!livekitToken && !isMicMuted)

    useEffect(() => {
        if (!meetingId) return

        const joinMeeting = async () => {
            try {
                setIsJoining(true)
                // Join meeting to get LiveKit token
                const joinRes = await meetingApi.join(meetingId)
                const { livekit_token, livekit_url, role } = joinRes.data

                // Fetch full meeting details
                const meetingRes = await meetingApi.get(meetingId)
                const meeting: Meeting = meetingRes.data

                setMeeting(meeting, livekit_token, livekit_url, role)

                // Start meeting if host and not already started
                if (role === 'host' && meeting.status === 'scheduled') {
                    await meetingApi.start(meetingId)
                }
            } catch (err: any) {
                const detail = err.response?.data?.detail
                addToast({
                    type: 'error',
                    title: err.response?.status === 503 ? 'Video not configured' : 'Failed to join meeting',
                    message: typeof detail === 'string' ? detail : 'Please try again',
                })
                navigate('/dashboard')
            } finally {
                setIsJoining(false)
            }
        }

        joinMeeting()

        return () => {
            clearRoom()
        }
    }, [meetingId])

    const handleEndMeeting = async () => {
        if (!meetingId || isEnding) return
        try {
            setIsEnding(true)
            await meetingApi.end(meetingId)
            addToast({ type: 'success', title: 'Meeting ended', message: 'Generating AI report…' })
            clearRoom()
            navigate(`/meetings/${meetingId}/report`)
        } catch (err) {
            addToast({ type: 'error', title: 'Failed to end meeting' })
            setIsEnding(false)
        }
    }

    if (isJoining) {
        return (
            <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' }}>
                <div style={{
                    width: 60, height: 60, borderRadius: '16px',
                    background: 'var(--gradient-brand)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'glow-pulse 2s ease infinite',
                }}>
                    <Video size={28} color="#fff" />
                </div>
                <p style={{ color: 'var(--text-secondary)' }}>Joining meeting…</p>
            </div>
        )
    }

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-base)' }}>
            {/* Header bar */}
            <div style={{
                height: 52,
                background: 'var(--color-bg-surface)',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 1.25rem',
                gap: '0.75rem',
                flexShrink: 0,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{
                        width: 28, height: 28, borderRadius: '8px',
                        background: 'var(--gradient-brand)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <Video size={14} color="#fff" />
                    </div>
                    <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>
                        {currentMeeting?.title || 'Meeting'}
                    </span>
                </div>

                {/* Live indicators */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginLeft: 'auto' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <Zap size={12} color={isConnected ? 'var(--color-success)' : (livekitToken ? 'var(--color-warning)' : 'var(--color-error)')} />
                        {isConnected ? 'Transcribing' : (livekitToken ? 'Waiting for WS...' : 'Connection Failed')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <Bot size={12} color="var(--color-purple)" />
                        AI Active
                    </div>
                    {roomRole && (
                        <span className={`badge ${roomRole === 'host' ? 'badge-blue' : 'badge-gray'}`}>
                            {roomRole}
                        </span>
                    )}
                </div>
            </div>

            {/* Main content: video + transcript */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Video area */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <VideoGrid
                        meetingId={meetingId!}
                        onEnd={handleEndMeeting}
                    />
                </div>

                {/* Transcript panel */}
                <TranscriptPanel meetingId={meetingId} />
            </div>

            {/* Action popups */}
            {meetingId && <ActionPopupSystem meetingId={meetingId} />}
        </div>
    )
}
