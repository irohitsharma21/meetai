/**
 * Join a meeting with a shared code.
 *
 * Reached two ways: from the dashboard, or by opening an invite link
 * (/join/abc-defg-hij), in which case the code is already in the URL and the
 * page resolves it without asking. The server does the normalising, so a code
 * typed in caps, without hyphens, or pasted as a whole URL all work.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowRight, Loader2, KeyRound, Video } from 'lucide-react'
import { meetingApi, errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'

export function JoinPage() {
    const { code: codeFromUrl } = useParams<{ code: string }>()
    const navigate = useNavigate()
    const { addToast } = useToastStore()

    const [code, setCode] = useState(codeFromUrl ?? '')
    const [isResolving, setIsResolving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const resolve = useCallback(
        async (raw: string) => {
            const value = raw.trim()
            if (!value) return
            try {
                setIsResolving(true)
                setError(null)
                const { data } = await meetingApi.joinByCode(value)
                navigate(`/meetings/${data.meeting_id}`, { replace: true })
            } catch (err) {
                // Shown inline rather than as a toast: the message is about the
                // field the user is looking at, so it belongs next to it.
                setError(errorMessage(err, 'Could not find that meeting.'))
            } finally {
                setIsResolving(false)
            }
        },
        [navigate],
    )

    // An invite link carries the code, so resolve it straight away.
    useEffect(() => {
        if (codeFromUrl) resolve(codeFromUrl)
    }, [codeFromUrl, resolve])

    return (
        <div className="join-page">
            <div className="join-card">
                <div className="join-mark">
                    <Video size={20} />
                </div>

                <h1 className="join-title">Join a meeting</h1>
                <p className="join-sub">
                    Enter the code the host shared with you. A full invite link works too.
                </p>

                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        resolve(code)
                    }}
                >
                    <div className="join-field">
                        <KeyRound size={15} className="join-field-icon" />
                        <input
                            className="input join-input"
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="abc-defg-hij"
                            value={code}
                            onChange={(e) => {
                                setCode(e.target.value)
                                if (error) setError(null)
                            }}
                            aria-invalid={!!error}
                            aria-describedby={error ? 'join-error' : undefined}
                        />
                    </div>

                    {error && (
                        <p id="join-error" className="join-error" role="alert">
                            {error}
                        </p>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary join-submit"
                        disabled={isResolving || !code.trim()}
                    >
                        {isResolving ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
                        {isResolving ? 'Finding meeting…' : 'Join'}
                    </button>
                </form>

                <div className="join-foot">
                    <Link to="/dashboard">Back to meetings</Link>
                    <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                            addToast({
                                type: 'info',
                                title: 'No code?',
                                message: 'Ask the host to share the meeting code or invite link from their meeting room.',
                            })
                        }
                    >
                        I don&apos;t have a code
                    </button>
                </div>
            </div>
        </div>
    )
}
