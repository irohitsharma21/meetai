import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Send, Sparkles, Volume2, X } from 'lucide-react'
import { insightApi } from '../../lib/api'
import { useToastStore } from '../../store'

interface Reply {
    heard?: string
    question: string
    answer: string
    used_history: boolean
    speech?: {
        provider: string
        audio: string | null
        mime_type: string | null
        text: string
        client_should_speak: boolean
        error?: string | null
    }
    sources?: { meeting_title: string; start_time: string }[]
}

/**
 * In-meeting voice assistant.
 *
 * Push-to-talk rather than always-listening: the button is the addressing
 * gesture, so meeting audio is only ever sent for transcription when someone
 * deliberately asks a question. An assistant that streams the whole meeting to
 * a third-party STT endpoint on the chance it is addressed is a worse product
 * and a worse privacy posture.
 */
export function AssistantDock({
    meetingId,
    onClose,
}: {
    meetingId: string
    onClose: () => void
}) {
    const [recording, setRecording] = useState(false)
    const [thinking, setThinking] = useState(false)
    const [typed, setTyped] = useState('')
    const [reply, setReply] = useState<Reply | null>(null)
    const { addToast } = useToastStore()

    const recorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<BlobPart[]>([])
    const streamRef = useRef<MediaStream | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    // Release the microphone and cancel any speech when the dock closes;
    // leaving a live track running keeps the browser's recording indicator on.
    useEffect(() => {
        return () => {
            streamRef.current?.getTracks().forEach((t) => t.stop())
            window.speechSynthesis?.cancel()
            audioRef.current?.pause()
        }
    }, [])

    const speak = useCallback((r: Reply) => {
        const s = r.speech
        if (!s) return

        if (s.audio && s.mime_type) {
            const audio = new Audio(`data:${s.mime_type};base64,${s.audio}`)
            audioRef.current = audio
            audio.play().catch(() => {})
            return
        }

        // Browser fallback: no key needed, and it keeps the feature working
        // for anyone who clones this without a TTS provider.
        if (s.client_should_speak && window.speechSynthesis) {
            window.speechSynthesis.cancel()
            const utterance = new SpeechSynthesisUtterance(s.text || r.answer)
            utterance.rate = 1.05
            utterance.pitch = 1.0
            window.speechSynthesis.speak(utterance)
        }
    }, [])

    const submitTyped = async () => {
        const question = typed.trim()
        if (!question || thinking) return

        setThinking(true)
        setReply(null)
        try {
            const r = await insightApi.assistantAsk(meetingId, question)
            setReply(r.data)
            speak(r.data)
            setTyped('')
        } catch (err: any) {
            addToast({
                type: 'error',
                title: 'Assistant unavailable',
                message: err?.response?.data?.detail ?? 'Could not reach the assistant',
            })
        } finally {
            setThinking(false)
        }
    }

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream
            chunksRef.current = []

            const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data)
            }
            recorder.onstop = async () => {
                stream.getTracks().forEach((t) => t.stop())
                const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
                if (blob.size < 1200) return  // a tap, not a question

                setThinking(true)
                setReply(null)
                try {
                    const r = await insightApi.assistantListen(meetingId, blob)
                    if (!r.data.answer) {
                        addToast({
                            type: 'info',
                            title: 'Nothing heard',
                            message: r.data.note ?? 'No speech was detected',
                        })
                        return
                    }
                    setReply(r.data)
                    speak(r.data)
                } catch (err: any) {
                    addToast({
                        type: 'error',
                        title: 'Assistant unavailable',
                        message: err?.response?.data?.detail ?? 'Speech-to-text failed',
                    })
                } finally {
                    setThinking(false)
                }
            }

            recorder.start()
            recorderRef.current = recorder
            setRecording(true)
        } catch {
            addToast({
                type: 'error',
                title: 'Microphone blocked',
                message: 'Allow microphone access to ask by voice',
            })
        }
    }

    const stopRecording = () => {
        recorderRef.current?.stop()
        recorderRef.current = null
        setRecording(false)
    }

    return (
        <div className="assistant-dock">
            <div className="action-popup-header">
                <Sparkles size={15} color="var(--color-primary)" />
                Assistant
                <button
                    className="btn btn-ghost btn-icon-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={onClose}
                    aria-label="Close assistant"
                >
                    <X size={14} />
                </button>
            </div>

            <div className="assistant-body">
                {!reply && !thinking && (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Hold the mic and ask about this meeting — “what did Arjun
                        commit to?” — or type it. Answers come from what has
                        actually been said, plus your past meetings.
                    </div>
                )}

                {thinking && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        <Loader2 size={14} className="spin" /> Thinking…
                    </div>
                )}

                {reply && !thinking && (
                    <>
                        <div className="assistant-q">
                            {reply.heard ? `“${reply.heard}”` : reply.question}
                        </div>
                        <div className="assistant-a">{reply.answer}</div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.625rem', flexWrap: 'wrap' }}>
                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => speak(reply)}
                                title="Play the answer again"
                            >
                                <Volume2 size={13} /> Replay
                            </button>
                            {reply.used_history && (
                                <span className="badge badge-purple">used past meetings</span>
                            )}
                            {reply.speech?.error && (
                                <span className="badge badge-amber" title={reply.speech.error}>
                                    browser voice
                                </span>
                            )}
                        </div>

                        {reply.sources && reply.sources.length > 0 && (
                            <div style={{ marginTop: '0.5rem', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                From: {reply.sources.map((s) => s.meeting_title).join(', ')}
                            </div>
                        )}
                    </>
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.625rem 0.75rem', borderTop: '1px solid var(--color-border)' }}>
                <button
                    className="mic-button"
                    data-recording={recording}
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={() => recording && stopRecording()}
                    onTouchStart={(e) => { e.preventDefault(); startRecording() }}
                    onTouchEnd={(e) => { e.preventDefault(); stopRecording() }}
                    title="Hold to speak"
                    style={{ width: 34, height: 34, flexShrink: 0 }}
                >
                    <Mic size={15} />
                </button>
                <input
                    className="input"
                    style={{ fontSize: '0.8125rem' }}
                    placeholder={recording ? 'Listening…' : 'or type a question'}
                    value={typed}
                    disabled={recording}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitTyped() }}
                />
                <button
                    className="btn btn-primary btn-icon-sm"
                    onClick={submitTyped}
                    disabled={!typed.trim() || thinking}
                    aria-label="Send question"
                >
                    <Send size={14} />
                </button>
            </div>
        </div>
    )
}
