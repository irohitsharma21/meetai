import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Video, Bot, Zap, Sparkles, Users, Copy, Check, Link as LinkIcon } from 'lucide-react'
import { VideoGrid } from '../../components/meeting/VideoGrid'
import { TranscriptPanel } from '../../components/meeting/TranscriptPanel'
import { ActionPopupSystem } from '../../components/meeting/ActionPopup'
import { AssistantDock } from '../../components/meeting/AssistantDock'
import { useMeetingRoomStore, useToastStore } from '../../store'
import { meetingApi, errorMessage } from '../../lib/api'
import { useMeetingWebSocket, useAudioCapture } from '../../hooks/useWebSocket'
import type { Meeting } from '../../types'

export function MeetingRoomPage() {
    const { meetingId } = useParams<{ meetingId: string }>()
    const navigate = useNavigate()
    const { addToast } = useToastStore()
    const {
        currentMeeting, setMeeting, clearRoom, livekitToken,
        roomRole, isConnected, isMicMuted, transcriptionStatus, joinCode,
    } = useMeetingRoomStore()

    /*
     * The badge used to read "Transcribing" whenever the socket was open, which
     * is a claim about the socket, not about speech-to-text. If the provider is
     * unreachable that reads as a working feature producing nothing. The server
     * now reports whether STT can actually run, and the badge follows it.
     */
    const sttOk = isConnected && transcriptionStatus?.available === true
    const sttReason = transcriptionStatus?.reason ?? null
    const sttLabel = !livekitToken
        ? 'Connection failed'
        : !isConnected
            ? 'Connecting...'
            : transcriptionStatus === null
                ? 'Connecting...'
                : transcriptionStatus.available
                    ? 'Transcribing'
                    : 'Transcription off'
    const sttColour = sttOk
        ? 'var(--color-success)'
        : livekitToken
            ? 'var(--color-warning)'
            : 'var(--color-error)'

    // Which of the two copy buttons last succeeded, so the tick appears on the
    // right one.
    const [copied, setCopied] = useState<'code' | 'link' | null>(null)

    const copy = async (text: string, which: 'code' | 'link') => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(which)
            setTimeout(() => setCopied(null), 1600)
        } catch {
            // Clipboard access is refused on insecure origins and in some
            // browsers; show the value so it can still be copied by hand.
            addToast({ type: 'info', title: 'Copy this', message: text })
        }
    }

    const handleCopyCode = () => joinCode && copy(joinCode, 'code')
    const handleCopyLink = () =>
        joinCode && copy(`${window.location.origin}/join/${joinCode}`, 'link')

    const [isJoining, setIsJoining] = useState(true)
    const [isEnding, setIsEnding] = useState(false)
    const [showAssistant, setShowAssistant] = useState(false)

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
                const { livekit_token, livekit_url, role, join_code } = joinRes.data

                // Fetch full meeting details
                const meetingRes = await meetingApi.get(meetingId)
                const meeting: Meeting = meetingRes.data

                setMeeting(meeting, livekit_token, livekit_url, role, join_code)

                // Start meeting if host and not already started
                if (role === 'host' && meeting.status === 'scheduled') {
                    await meetingApi.start(meetingId)
                }
            } catch (err: any) {
                addToast({
                    type: 'error',
                    title: err.response?.status === 503 ? 'Video not configured' : 'Failed to join meeting',
                    message: errorMessage(err, 'Please try again'),
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
        <div style={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-base)' }}>
            {showAssistant && meetingId && (
                <AssistantDock meetingId={meetingId} onClose={() => setShowAssistant(false)} />
            )}

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

                {joinCode && (
                    <div className="code-chip" title="Anyone signed in with this code can join">
                        <Users size={12} />
                        {joinCode}
                        <button onClick={handleCopyCode} aria-label="Copy meeting code" title="Copy code">
                            {copied === 'code' ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button onClick={handleCopyLink} aria-label="Copy invite link" title="Copy invite link">
                            {copied === 'link' ? <Check size={12} /> : <LinkIcon size={12} />}
                        </button>
                    </div>
                )}

                {/* Live indicators */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginLeft: 'auto' }}>
                    <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                        title={sttReason ?? undefined}
                    >
                        <Zap size={12} color={sttColour} />
                        {sttLabel}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <Bot size={12} color={sttOk ? 'var(--color-purple)' : 'var(--text-muted)'} />
                        {sttOk ? 'AI Active' : 'AI Idle'}
                    </div>
                    <button
                        className={`btn btn-sm ${showAssistant ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setShowAssistant((v) => !v)}
                        title="Ask the assistant about this meeting"
                    >
                        <Sparkles size={13} /> Assistant
                    </button>
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
