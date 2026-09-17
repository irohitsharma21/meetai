import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Send, Sparkles, Volume2, X } from 'lucide-react'
import { insightApi, errorMessage } from '../../lib/api'
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
                message: errorMessage(err, 'Could not reach the assistant'),
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
                        message: errorMessage(err, 'Speech-to-text failed'),
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
        <div className="assistant-dock" role="dialog" aria-label="Meeting assistant">
            <div className="assistant-head">
                <span className="action-toast-icon"><Sparkles size={16} aria-hidden="true" /></span>
                <span>Assistant</span>
                <button
                    className="btn btn-ghost btn-icon-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={onClose}
                    aria-label="Close assistant"
                >
                    <X size={16} />
                </button>
            </div>

            <div className="assistant-body" aria-live="polite">
                {!reply && !thinking && (
                    <div className="text-sm muted" style={{ lineHeight: 1.6 }}>
                        Hold the mic and ask about this meeting — “what did Arjun
                        commit to?” — or type it. Answers come from what has
                        actually been said, plus your past meetings.
                    </div>
                )}

                {thinking && (
                    <div className="assistant-bubble" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Loader2 size={14} className="spin" aria-hidden="true" />
                        <span className="text-sm muted">Thinking…</span>
                    </div>
                )}

                {reply && !thinking && (
                    <>
                        <div className="assistant-q">
                            {reply.heard ? `“${reply.heard}”` : reply.question}
                        </div>
                        <div className="assistant-bubble">
                            <div className="assistant-a">{reply.answer}</div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.625rem', flexWrap: 'wrap' }}>
                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => speak(reply)}
                                title="Play the answer again"
                            >
                                <Volume2 size={14} aria-hidden="true" /> Replay
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
                            <div className="text-xs muted" style={{ marginTop: '0.5rem' }}>
                                From: {reply.sources.map((s) => s.meeting_title).join(', ')}
                            </div>
                        )}
                    </>
                )}
            </div>

            <div className="assistant-foot">
                <button
                    className="mic-button"
                    data-recording={recording}
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={() => recording && stopRecording()}
                    onTouchStart={(e) => { e.preventDefault(); startRecording() }}
                    onTouchEnd={(e) => { e.preventDefault(); stopRecording() }}
                    title="Hold to speak"
                    aria-label={recording ? 'Listening; release to send' : 'Hold to speak'}
                    aria-pressed={recording}
                    style={{ width: 36, height: 36, flexShrink: 0 }}
                >
                    <Mic size={16} />
                </button>
                <input
                    className="input"
                    placeholder={recording ? 'Listening…' : 'Type a question'}
                    aria-label="Ask the assistant"
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
                    <Send size={15} />
                </button>
            </div>
        </div>
    )
}
