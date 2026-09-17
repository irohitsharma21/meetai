/**
 * Join a meeting with a shared code.
 *
 * Reached two ways: from the dashboard, or by opening an invite link
 * (/join/abc-defg-hij), in which case the code is already in the URL and the
 * page resolves it without asking. The server does the normalising, so a code
 * typed in caps, without hyphens, or pasted as a whole URL all work; the field
 * simply tidies what it is given into the abc-defg-hij shape as you type.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowRight, Loader2, KeyRound, Video, AlertCircle, ClipboardPaste } from 'lucide-react'
import { meetingApi, errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import { usePageTitle } from '../../components/common/usePageTitle'

/**
 * Normalise whatever was typed or pasted into `abc-defg-hij`.
 * A full invite URL is reduced to the code after `/join/`.
 */
export function formatJoinCode(raw: string): string {
    let value = raw.trim()
    const m = value.match(/\/join\/([^/?#\s]+)/i)
    if (m) value = m[1]
    const chars = value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)
    const parts = [chars.slice(0, 3), chars.slice(3, 7), chars.slice(7, 10)].filter(Boolean)
    return parts.join('-')
}

export function JoinPage() {
    usePageTitle('Join a meeting')
    const { code: codeFromUrl } = useParams<{ code: string }>()
    const navigate = useNavigate()
    const { addToast } = useToastStore()

    const [code, setCode] = useState(codeFromUrl ? formatJoinCode(codeFromUrl) : '')
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

    const pasteFromClipboard = async () => {
        try {
            const text = await navigator.clipboard.readText()
            const next = formatJoinCode(text)
            if (!next) {
                addToast({ type: 'info', title: 'Nothing to paste', message: 'Copy a meeting code or invite link first.' })
                return
            }
            setCode(next)
            setError(null)
        } catch {
            addToast({ type: 'info', title: 'Clipboard unavailable', message: 'Paste the code into the field instead.' })
        }
    }

    const complete = code.replace(/-/g, '').length === 10

    return (
        <div className="join-page">
            <div className="join-card">
                <Link to="/dashboard" className="join-mark" aria-label="Back to home" title="Back to home">
                    <Video size={20} aria-hidden="true" />
                </Link>

                <h1 className="join-title">Join a meeting</h1>
                <p className="join-sub">
                    Enter the code the host shared with you. Pasting the full invite link works too.
                </p>

                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        resolve(code)
                    }}
                >
                    <label className="label" htmlFor="join-code" style={{ display: 'block', marginBottom: '0.375rem' }}>
                        Meeting code
                    </label>
                    <div className="join-field">
                        <KeyRound size={16} className="join-field-icon" aria-hidden="true" />
                        <input
                            id="join-code"
                            className="input join-input"
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            autoCapitalize="off"
                            inputMode="text"
                            placeholder="abc-defg-hij"
                            value={code}
                            onChange={(e) => {
                                setCode(formatJoinCode(e.target.value))
                                if (error) setError(null)
                            }}
                            onPaste={(e) => {
                                const text = e.clipboardData.getData('text')
                                if (text) {
                                    e.preventDefault()
                                    setCode(formatJoinCode(text))
                                    if (error) setError(null)
                                }
                            }}
                            aria-invalid={!!error}
                            aria-describedby={error ? 'join-error' : 'join-hint'}
                        />
                    </div>

                    {error ? (
                        <p id="join-error" className="join-error" role="alert">
                            <AlertCircle size={14} aria-hidden="true" style={{ marginTop: 2 }} />
                            <span>{error}</span>
                        </p>
                    ) : (
                        <p id="join-hint" className="field-hint" style={{ marginTop: '0.5rem' }}>
                            Ten letters or numbers; hyphens are added for you.
                        </p>
                    )}

                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                        <button
                            type="button"
                            className="btn"
                            onClick={pasteFromClipboard}
                            title="Paste a code or invite link from the clipboard"
                        >
                            <ClipboardPaste size={16} aria-hidden="true" /> Paste
                        </button>
                        <button
                            type="submit"
                            className="btn btn-primary"
                            style={{ flex: 1 }}
                            disabled={isResolving || !code.trim() || !complete}
                        >
                            {isResolving ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
                            {isResolving ? 'Finding meeting…' : 'Join'}
                        </button>
                    </div>
                </form>

                <div className="join-foot">
                    <Link to="/dashboard">Back to home</Link>
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
