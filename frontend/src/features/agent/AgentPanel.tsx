import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertTriangle, Ban, Bot, Check, CheckCircle2, ExternalLink, Keyboard, Loader2, Lock, Mail, Mic,
    NotebookPen, RotateCcw, Send, Settings2, X, XCircle,
} from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import { useAgentStore, useMeetingActions } from './store'
import { TOOL_LABELS } from './types'
import type { AgentAction, AgentActionStatus, ApprovePayload } from './types'
import './agent.css'

export const SETTINGS_PATH = '/assistant'

const EXAMPLE_CHIPS = [
    'Send my contact details to Rohit',
    'Share the pricing snippet with everyone',
    'Remind me to follow up on the budget',
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const STATUS_META: Record<AgentActionStatus, { label: string; tone: string }> = {
    pending: { label: 'Needs approval', tone: 'badge-amber' },
    needs_input: { label: 'Needs details', tone: 'badge-amber' },
    blocked: { label: 'Not allowed', tone: 'badge-gray' },
    running: { label: 'Working', tone: 'badge-blue' },
    done: { label: 'Done', tone: 'badge-green' },
    failed: { label: 'Failed', tone: 'badge-red' },
    rejected: { label: 'Cancelled', tone: 'badge-gray' },
}

export function formatTime(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function recipientLine(a: AgentAction): string {
    if (!a.recipients?.length) return ''
    return a.recipients.map((r) => r.name || r.email).join(', ')
}

export function openSettings() {
    window.open(SETTINGS_PATH, '_blank', 'noopener')
}

interface ActionCardProps {
    action: AgentAction
    meetingId: string
}

function ActionCard({ action, meetingId }: ActionCardProps) {
    const { addToast } = useToastStore()
    const approve = useAgentStore((s) => s.approve)
    const reject = useAgentStore((s) => s.reject)
    const busy = useAgentStore((s) => !!s.busy[action.id])

    const editable = action.tool === 'send_email' && action.status === 'pending'
    const [subject, setSubject] = useState(action.preview?.subject ?? '')
    const [body, setBody] = useState(action.preview?.body ?? '')
    const [pick, setPick] = useState<string | null>(null)
    const [email, setEmail] = useState('')
    const [showPreview, setShowPreview] = useState(editable)

    // A socket update may bring a fresh preview; reset only while it isn't being edited.
    useEffect(() => {
        if (!editable) {
            setSubject(action.preview?.subject ?? '')
            setBody(action.preview?.body ?? '')
        }
    }, [action.preview, editable])

    const run = async (fn: () => Promise<AgentAction>, verb: string) => {
        try {
            await fn()
        } catch (err) {
            addToast({ type: 'error', title: `Couldn't ${verb}`, message: errorMessage(err) })
        }
    }

    const onApprove = () => {
        const payload: ApprovePayload = {}
        if (editable) {
            if (subject !== (action.preview?.subject ?? '')) payload.subject = subject
            if (body !== (action.preview?.body ?? '')) payload.body = body
        }
        if (action.status === 'needs_input') {
            if (pick) payload.recipient_username = pick
            else if (email.trim()) payload.recipient_email = email.trim()
        }
        void run(() => approve(meetingId, action.id, payload), 'approve')
    }
    const onReject = () => void run(() => reject(meetingId, action.id), 'cancel')

    const meta = STATUS_META[action.status] ?? STATUS_META.pending
    const SourceIcon = action.source === 'voice' ? Mic : Keyboard
    const who = recipientLine(action)
    const emailValid = EMAIL_RE.test(email.trim())
    const canApproveInput = !!pick || emailValid
    const emailOk = !editable || (subject.trim().length > 0 && body.trim().length > 0)

    return (
        <motion.article
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="agt-action"
            data-status={action.status}
        >
            <div className="agt-action-head">
                <span className="agt-src" title={action.source === 'voice' ? 'Spoken' : 'Typed'}>
                    <SourceIcon size={12} aria-hidden="true" />
                    <span className="sr-only">{action.source === 'voice' ? 'Spoken command' : 'Typed command'}</span>
                </span>
                <span className="agt-action-tool">{TOOL_LABELS[action.tool] ?? action.tool}</span>
                <span className="agt-action-time">{formatTime(action.created_at)}</span>
                <span className={`badge ${meta.tone} agt-badge`}>{meta.label}</span>
            </div>

            <div className="agt-action-summary">{action.summary || action.command}</div>
            {action.command && action.summary && (
                <div className="agt-action-cmd" title="What you asked">“{action.command}”</div>
            )}

            {who && action.status !== 'needs_input' && (
                <div className="agt-action-to">
                    <Mail size={12} aria-hidden="true" />
                    <span>To {action.recipients.map((r, i) => (
                        <span key={`${r.email}-${i}`} title={r.email}>{i > 0 ? ', ' : ''}{r.name || r.email}</span>
                    ))}</span>
                </div>
            )}

            {/* ── pending: preview + approve/cancel ──────────────── */}
            {action.status === 'pending' && (
                <>
                    {action.preview && (
                        editable ? (
                            <div className="agt-edit">
                                <label className="agt-mini-label" htmlFor={`agt-sub-${action.id}`}>Subject</label>
                                <input
                                    id={`agt-sub-${action.id}`}
                                    className="input agt-input-sm"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                />
                                <label className="agt-mini-label" htmlFor={`agt-body-${action.id}`}>Message</label>
                                <textarea
                                    id={`agt-body-${action.id}`}
                                    className="input agt-textarea agt-input-sm"
                                    rows={5}
                                    value={body}
                                    onChange={(e) => setBody(e.target.value)}
                                />
                            </div>
                        ) : (
                            <>
                                <button type="button" className="agt-link-btn" onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview}>
                                    {showPreview ? 'Hide what will be sent' : 'Show what will be sent'}
                                </button>
                                {showPreview && (
                                    <div className="agt-mail-preview">
                                        {action.preview.subject && <div className="agt-mail-subject">{action.preview.subject}</div>}
                                        <div className="agt-mail-body">{action.preview.body}</div>
                                    </div>
                                )}
                            </>
                        )
                    )}
                    <div className="agt-action-foot">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={onReject} disabled={busy}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" onClick={onApprove} disabled={busy || !emailOk}>
                            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                            {action.tool === 'add_note' ? 'Save note' : 'Approve & send'}
                        </button>
                    </div>
                </>
            )}

            {/* ── needs_input: choose a recipient ─────────────────── */}
            {action.status === 'needs_input' && (
                <>
                    {action.message && <div className="agt-action-msg">{action.message}</div>}
                    {action.candidates?.length > 0 && (
                        <div className="agt-cands" role="radiogroup" aria-label="Choose who to send to">
                            {action.candidates.map((c) => (
                                <button
                                    key={c.username}
                                    type="button"
                                    role="radio"
                                    aria-checked={pick === c.username}
                                    className="agt-cand"
                                    onClick={() => { setPick(c.username); setEmail('') }}
                                >
                                    <span className="agt-cand-name">{c.name || c.username}</span>
                                    {c.email_hint && <span className="agt-cand-hint">{c.email_hint}</span>}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="agt-email-in">
                        <input
                            className="input agt-input-sm"
                            type="email"
                            placeholder={action.candidates?.length ? 'Or type an email address' : 'Recipient email address'}
                            aria-label="Recipient email"
                            value={email}
                            onChange={(e) => { setEmail(e.target.value); if (e.target.value) setPick(null) }}
                            onKeyDown={(e) => { if (e.key === 'Enter' && canApproveInput && !busy) onApprove() }}
                            aria-invalid={email.trim() && !emailValid ? 'true' : undefined}
                        />
                    </div>
                    <div className="agt-action-foot">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={onReject} disabled={busy}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" onClick={onApprove} disabled={busy || !canApproveInput}>
                            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                            Approve
                        </button>
                    </div>
                </>
            )}

            {action.status === 'blocked' && (
                <div className="agt-action-state is-muted">
                    <Lock size={14} aria-hidden="true" />
                    <div>
                        <div>{action.message || "Your assistant isn't allowed to do this yet."}</div>
                        <button type="button" className="agt-link-btn" onClick={openSettings}>
                            Open assistant settings <ExternalLink size={12} aria-hidden="true" />
                        </button>
                    </div>
                </div>
            )}

            {action.status === 'running' && (
                <div className="agt-action-state">
                    <Loader2 size={14} className="spin" aria-hidden="true" /> {action.message || 'Working on it…'}
                </div>
            )}

            {action.status === 'failed' && (
                <div className="agt-action-state is-danger">
                    <XCircle size={14} aria-hidden="true" /> <span>{action.message || 'Something went wrong.'}</span>
                </div>
            )}

            {action.status === 'done' && (
                <div className="agt-action-state is-success">
                    <CheckCircle2 size={14} aria-hidden="true" /> <span>{action.message || 'Done.'}</span>
                </div>
            )}

            {action.status === 'rejected' && (
                <div className="agt-action-state is-muted">
                    <Ban size={14} aria-hidden="true" /> <span>{action.message || 'Cancelled.'}</span>
                </div>
            )}
        </motion.article>
    )
}

interface AgentPanelProps {
    meetingId: string
    onClose: () => void
}

/**
 * The in-room assistant panel: type a command, watch what the assistant is
 * doing, and approve anything that waits on you. Rendered by the room inside
 * `.room-panel-col`; this component supplies its own head and body.
 */
export function AgentPanel({ meetingId, onClose }: AgentPanelProps): JSX.Element {
    const { addToast } = useToastStore()
    const actions = useMeetingActions(meetingId)
    const loaded = useAgentStore((s) => !!s.loaded[meetingId])
    const load = useAgentStore((s) => s.load)
    const command = useAgentStore((s) => s.command)
    const dismiss = useAgentStore((s) => s.dismiss)

    const [loadError, setLoadError] = useState<string | null>(null)
    const [draft, setDraft] = useState('')
    const [sending, setSending] = useState(false)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const bodyRef = useRef<HTMLDivElement>(null)

    const refresh = () => {
        setLoadError(null)
        load(meetingId).catch((err) => setLoadError(errorMessage(err, 'Could not load assistant activity.')))
    }

    useEffect(() => {
        refresh()
        inputRef.current?.focus()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId])

    // With the panel open, open actions are handled here, not in floating cards.
    useEffect(() => {
        actions.forEach((a) => { if (a.status === 'pending' || a.status === 'needs_input') dismiss(a.id) })
    }, [actions, dismiss])

    const notes = useMemo(() => actions.filter((a) => a.tool === 'add_note' && a.status === 'done'), [actions])
    const feed = useMemo(() => actions.filter((a) => !(a.tool === 'add_note' && a.status === 'done')), [actions])
    const waiting = feed.filter((a) => a.status === 'pending' || a.status === 'needs_input').length

    const autosize = () => {
        const ta = inputRef.current
        if (!ta) return
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    }

    const send = async (text: string) => {
        const t = text.trim()
        if (!t || sending) return
        setSending(true)
        setDraft('')
        requestAnimationFrame(autosize)
        try {
            await command(meetingId, t)
            bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
        } catch (err) {
            setDraft((d) => d || t)
            addToast({ type: 'error', title: "Your assistant couldn't take that", message: errorMessage(err) })
        } finally {
            setSending(false)
            inputRef.current?.focus()
        }
    }

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send(draft)
        }
    }

    return (
        <>
            <div className="room-panel-head">
                <Bot size={16} color="var(--color-primary)" aria-hidden="true" />
                <span>Your assistant</span>
                {waiting > 0 && <span className="agt-count" aria-label={`${waiting} waiting for you`}>{waiting}</span>}
                <button
                    type="button"
                    className="room-icon-btn agt-head-settings"
                    onClick={openSettings}
                    aria-label="Assistant settings (opens in a new tab)"
                    title="Assistant settings"
                >
                    <Settings2 size={16} />
                </button>
                <button type="button" className="room-icon-btn agt-head-close" onClick={onClose} aria-label="Close assistant panel">
                    <X size={16} />
                </button>
            </div>

            <div className="room-panel-body agt-panel">
                <div className="agt-panel-scroll" ref={bodyRef}>
                    {loadError && (
                        <div className="agt-inline-error" role="alert">
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>{loadError}</span>
                            <button type="button" className="agt-link-btn" onClick={refresh}>
                                <RotateCcw size={12} aria-hidden="true" /> Retry
                            </button>
                        </div>
                    )}

                    {notes.length > 0 && (
                        <section className="agt-notes" aria-label="Notes for you">
                            <div className="agt-section-label"><NotebookPen size={13} aria-hidden="true" /> Notes for you</div>
                            <ul>
                                {notes.map((n) => (
                                    <li key={n.id}>
                                        <span className="agt-note-text">{n.preview?.body || n.message || n.summary}</span>
                                        <span className="agt-note-time">{formatTime(n.created_at)}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {!loaded && !loadError ? (
                        <div className="agt-feed" aria-busy="true">
                            {[0, 1].map((i) => (
                                <div key={i} className="agt-action">
                                    <div className="skeleton skeleton-text" style={{ width: '45%' }} />
                                    <div className="skeleton skeleton-text" style={{ width: '85%', marginTop: 8 }} />
                                </div>
                            ))}
                        </div>
                    ) : feed.length === 0 && notes.length === 0 ? (
                        <div className="pnl-empty agt-empty">
                            <span className="pnl-empty-icon"><Bot size={20} /></span>
                            <p>
                                Say <b>“Hey MeetAI”</b> and a request, or type it below. Your assistant only does what you've
                                allowed in <button type="button" className="agt-link-btn" onClick={openSettings}>settings</button>.
                            </p>
                        </div>
                    ) : (
                        <div className="agt-feed" aria-live="polite">
                            <AnimatePresence initial={false}>
                                {feed.map((a) => <ActionCard key={a.id} action={a} meetingId={meetingId} />)}
                            </AnimatePresence>
                        </div>
                    )}
                </div>

                <div className="agt-composer">
                    {feed.length === 0 && (
                        <div className="agt-chips" aria-label="Examples">
                            {EXAMPLE_CHIPS.map((c) => (
                                <button key={c} type="button" className="agt-chip" onClick={() => { setDraft(c); inputRef.current?.focus(); requestAnimationFrame(autosize) }}>
                                    {c}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="agt-composer-box">
                        <textarea
                            ref={inputRef}
                            className="agt-composer-input"
                            rows={1}
                            value={draft}
                            placeholder="Tell your assistant…"
                            aria-label="Tell your assistant"
                            onChange={(e) => { setDraft(e.target.value); autosize() }}
                            onKeyDown={onKeyDown}
                            disabled={sending}
                        />
                        <button
                            type="button"
                            className="agt-composer-send"
                            onClick={() => void send(draft)}
                            disabled={!draft.trim() || sending}
                            aria-label="Send to assistant"
                        >
                            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                        </button>
                    </div>
                    <div className="agt-composer-hint">Enter to send · only you see this</div>
                </div>
            </div>
        </>
    )
}
