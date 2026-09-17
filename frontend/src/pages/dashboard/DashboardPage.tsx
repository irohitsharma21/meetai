import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
    ArrowRight, BarChart2, CalendarClock, Check, Clock, Copy, FileText, KeyRound, Loader2,
    Plus, Search, Sparkles, Trash2, Video, X, Activity,
} from 'lucide-react'
import { useAuthStore, useDashboardStore, useToastStore } from '../../store'
import { meetingApi, errorMessage } from '../../lib/api'
import { MeetingWrapUp } from '../../components/meeting/MeetingWrapUp'
import { formatJoinCode } from '../join/JoinPage'
import type { MeetingListItem } from '../../types'
import { formatDistanceToNow } from 'date-fns'

/* ── helpers ──────────────────────────────────────────────────────────── */

const STATUS_BADGE: Record<string, string> = {
    scheduled: 'badge-blue',
    active: 'badge-green',
    ended: 'badge-gray',
    processed: 'badge-purple',
}

const STATUS_LABEL: Record<string, string> = {
    scheduled: 'Scheduled',
    active: 'Live',
    ended: 'Ended',
    processed: 'Processed',
}

function relative(iso: string): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '—' : formatDistanceToNow(d, { addSuffix: true })
}

function duration(seconds?: number): string {
    if (!seconds) return '—'
    const m = Math.round(seconds / 60)
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

function greetingFor(date: Date): string {
    const h = date.getHours()
    if (h < 5) return 'Good evening'
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
}

/** Stable 0–5 bucket for a name, used to pick an avatar colour. */
function hueOf(name: string): number {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return h % 6
}

/* ── people ───────────────────────────────────────────────────────────── */

function People({ names }: { names: string[] }) {
    if (!names.length) return <span className="cell-dim">—</span>
    const shown = names.slice(0, 4)
    const extra = names.length - shown.length
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} title={names.join(', ')}>
            <span className="avatar-stack" aria-label={`${names.length} participants`}>
                {shown.map((n) => (
                    <span key={n} className="avatar avatar-sm" data-hue={hueOf(n)} aria-hidden="true">
                        {n[0]?.toUpperCase()}
                    </span>
                ))}
                {extra > 0 && <span className="avatar avatar-sm avatar-more" aria-hidden="true">+{extra}</span>}
            </span>
        </div>
    )
}

/* ── invite code ──────────────────────────────────────────────────────── */

/**
 * Copy a meeting's join code straight from the list.
 *
 * Sharing is the whole point of a code, and making the host open the meeting
 * first to find it is a pointless step.
 */
function CodeCell({ code }: { code?: string }) {
    const [copied, setCopied] = useState(false)
    const { addToast } = useToastStore()

    if (!code) return <span className="cell-dim">—</span>

    const handle = async (e: React.MouseEvent) => {
        e.stopPropagation()
        try {
            await navigator.clipboard.writeText(`${window.location.origin}/join/${code}`)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
        } catch {
            addToast({ type: 'info', title: 'Invite link', message: `${window.location.origin}/join/${code}` })
        }
    }

    return (
        <button className="code-chip" onClick={handle} title="Copy invite link" aria-label={`Copy invite link for code ${code}`}>
            {code}
            <span aria-hidden="true">{copied ? <Check size={12} /> : <Copy size={12} />}</span>
        </button>
    )
}

/* ── create modal ─────────────────────────────────────────────────────── */

function CreateMeetingModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const [title, setTitle] = useState('')
    const [description, setDescription] = useState('')
    const [participants, setParticipants] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const { addToast } = useToastStore()
    const navigate = useNavigate()
    const titleRef = useRef<HTMLInputElement>(null)

    // Mirrors MeetingCreate.title in models/meeting_model.py (min_length=3).
    // Enforced here too so a too-short title is caught before the round trip.
    const trimmed = title.trim()
    const titleValid = trimmed.length >= 3

    useEffect(() => {
        titleRef.current?.focus()
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!titleValid) return
        try {
            setIsLoading(true)
            const res = await meetingApi.create({
                title: trimmed,
                description,
                participants: participants.split(',').map((p) => p.trim()).filter(Boolean),
            })
            addToast({
                type: 'success',
                title: 'Meeting created',
                message: res.data.join_code
                    ? `Share code ${res.data.join_code} to invite others.`
                    : 'Joining now…',
            })
            onCreated()
            onClose()
            navigate(`/meetings/${res.data.meeting_id}`)
        } catch (err: any) {
            addToast({
                type: 'error',
                title: 'Could not create meeting',
                message: errorMessage(err, 'Could not create the meeting'),
            })
        } finally {
            setIsLoading(false)
        }
    }

    const invitees = participants.split(',').map((p) => p.trim()).filter(Boolean)

    return (
        <div className="overlay" onClick={onClose}>
            <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="new-meeting-title"
            >
                <div className="modal-head">
                    <h2 id="new-meeting-title" className="modal-title">New meeting</h2>
                    <button
                        type="button"
                        className="btn btn-ghost btn-icon-sm"
                        onClick={onClose}
                        style={{ marginLeft: 'auto' }}
                        aria-label="Close"
                    >
                        <X size={18} />
                    </button>
                </div>
                <form onSubmit={handleCreate}>
                    <div className="modal-body">
                        <div className="form-group">
                            <label className="label" htmlFor="m-title">Title</label>
                            <input
                                id="m-title" className="input" ref={titleRef} required
                                minLength={3} maxLength={200}
                                placeholder="Q4 roadmap review"
                                value={title} onChange={(e) => setTitle(e.target.value)}
                                aria-invalid={title.length > 0 && !titleValid}
                                aria-describedby="m-title-hint"
                            />
                            <span id="m-title-hint" className={title.length > 0 && !titleValid ? 'field-error' : 'field-hint'}>
                                {title.length > 0 && !titleValid ? 'At least 3 characters.' : 'What is this meeting about?'}
                            </span>
                        </div>
                        <div className="form-group">
                            <label className="label" htmlFor="m-desc">Description <span className="muted">(optional)</span></label>
                            <textarea
                                id="m-desc" className="input" rows={3}
                                placeholder="Agenda, goals, links — anything the minutes should know."
                                value={description} onChange={(e) => setDescription(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label className="label" htmlFor="m-part">Invitees</label>
                            <input
                                id="m-part" className="input"
                                placeholder="priya, arjun, sam"
                                value={participants} onChange={(e) => setParticipants(e.target.value)}
                                aria-describedby="m-part-hint"
                            />
                            <span id="m-part-hint" className="field-hint">Comma-separated usernames. Anyone with the code can still join.</span>
                            {invitees.length > 0 && (
                                <div className="avatar-stack" style={{ marginTop: '0.25rem' }} aria-hidden="true">
                                    {invitees.slice(0, 6).map((n) => (
                                        <span key={n} className="avatar avatar-sm" data-hue={hueOf(n)} title={n}>{n[0]?.toUpperCase()}</span>
                                    ))}
                                    {invitees.length > 6 && <span className="avatar avatar-sm avatar-more">+{invitees.length - 6}</span>}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="modal-foot">
                        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={isLoading || !titleValid}>
                            {isLoading ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Video size={16} aria-hidden="true" />}
                            Create &amp; join
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

/* ── empty state illustration ─────────────────────────────────────────── */

function EmptyIllustration() {
    return (
        <svg className="empty-illus" viewBox="0 0 160 100" fill="none" aria-hidden="true">
            <rect x="8" y="14" width="144" height="72" rx="10" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
            <rect x="18" y="24" width="58" height="36" rx="6" fill="currentColor" fillOpacity="0.14" />
            <rect x="84" y="24" width="58" height="36" rx="6" fill="currentColor" fillOpacity="0.08" />
            <circle cx="47" cy="40" r="7" fill="currentColor" fillOpacity="0.5" />
            <circle cx="113" cy="40" r="7" fill="currentColor" fillOpacity="0.3" />
            <rect x="18" y="68" width="72" height="6" rx="3" fill="currentColor" fillOpacity="0.25" />
            <rect x="96" y="68" width="46" height="6" rx="3" fill="currentColor" fillOpacity="0.15" />
        </svg>
    )
}

/* ── page ─────────────────────────────────────────────────────────────── */

type Filter = 'all' | 'active' | 'scheduled' | 'done'

export function DashboardPage() {
    const { user } = useAuthStore()
    const { meetings, isLoading, setMeetings, setLoading } = useDashboardStore()
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const [filter, setFilter] = useState<Filter>('all')
    const [showCreate, setShowCreate] = useState(false)
    const [joinCode, setJoinCode] = useState('')

    // Set by the meeting room on the way out: ?wrapup=<id> opens the
    // post-meeting panel over the dashboard. ?q=<term> is the app-bar search.
    const [searchParams, setSearchParams] = useSearchParams()
    const wrapUpId = searchParams.get('wrapup')
    const urlQuery = searchParams.get('q') ?? ''
    const [query, setQuery] = useState(urlQuery)
    useEffect(() => { setQuery(urlQuery) }, [urlQuery])

    // Opened by clicking a row rather than by leaving a meeting. Tracked
    // separately so only the leave path writes the report unprompted.
    const [insightsId, setInsightsId] = useState<string | null>(null)

    const closeWrapUp = () => {
        // Drop the parameter so a refresh, or a back navigation, does not
        // reopen a panel the user has already dismissed.
        searchParams.delete('wrapup')
        setSearchParams(searchParams, { replace: true })
        load()
    }

    const load = async () => {
        try {
            setLoading(true)
            const res = await meetingApi.list({ limit: 100 })
            setMeetings(res.data.meetings ?? [])
        } catch {
            addToast({ type: 'error', title: 'Could not load meetings' })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const counts = useMemo(() => ({
        all: meetings.length,
        active: meetings.filter((m) => m.status === 'active').length,
        scheduled: meetings.filter((m) => m.status === 'scheduled').length,
        done: meetings.filter((m) => m.status === 'ended' || m.status === 'processed').length,
    }), [meetings])

    const reports = useMemo(
        () => meetings.filter((m) => m.has_report).length,
        [meetings],
    )

    const thisWeek = useMemo(() => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        return meetings.filter((m) => {
            const t = new Date(m.started_at ?? m.timestamp).getTime()
            return !Number.isNaN(t) && t >= cutoff
        }).length
    }, [meetings])

    const totalSeconds = useMemo(
        () => meetings.reduce((s, m) => s + (m.duration_seconds ?? 0), 0),
        [meetings],
    )
    const hours = totalSeconds / 3600
    const hoursLabel = hours >= 10 ? Math.round(hours).toString() : hours.toFixed(1)

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        return meetings.filter((m) => {
            const byFilter =
                filter === 'all' ||
                (filter === 'done' ? m.status === 'ended' || m.status === 'processed' : m.status === filter)
            if (!byFilter) return false
            if (!q) return true
            return (
                m.title.toLowerCase().includes(q) ||
                m.created_by.toLowerCase().includes(q) ||
                (m.join_code ?? '').toLowerCase().includes(q) ||
                m.participants.some((p) => p.toLowerCase().includes(q))
            )
        })
    }, [meetings, filter, query])

    const remove = async (id: string) => {
        try {
            await meetingApi.delete(id)
            setMeetings(meetings.filter((m) => m.meeting_id !== id))
            addToast({ type: 'success', title: 'Meeting deleted' })
        } catch {
            addToast({ type: 'error', title: 'Could not delete meeting' })
        }
    }

    const open = (m: MeetingListItem) => {
        navigate(
            m.status === 'active' || m.status === 'scheduled'
                ? `/meetings/${m.meeting_id}`
                : `/meetings/${m.meeting_id}/report`,
        )
    }

    const canCreate = user?.role === 'host' || user?.role === 'admin'
    const firstName = (user?.display_name || user?.username || '').split(/\s+/)[0]

    const submitJoin = (e: React.FormEvent) => {
        e.preventDefault()
        const code = formatJoinCode(joinCode)
        if (!code) return
        navigate(`/join/${code}`)
    }

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="greeting">{greetingFor(new Date())}{firstName ? `, ${firstName}` : ''}</h1>
                    <div className="greeting-sub">
                        {counts.active > 0
                            ? `${counts.active} meeting${counts.active > 1 ? 's' : ''} live right now`
                            : 'Everything your meetings decided, in one place.'}
                    </div>
                </div>
                <div className="page-actions">
                    {canCreate && (
                        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
                            <Plus size={16} aria-hidden="true" /> New meeting
                        </button>
                    )}
                </div>
            </div>

            {/* Quick actions */}
            <div className="quick-actions">
                {canCreate && (
                    <button type="button" className="quick-action" data-tone="primary" onClick={() => setShowCreate(true)}>
                        <span className="quick-action-icon"><Video size={20} aria-hidden="true" /></span>
                        <span>
                            <span className="quick-action-title" style={{ display: 'block' }}>New meeting</span>
                            <span className="quick-action-sub" style={{ display: 'block' }}>Start now and share a code</span>
                        </span>
                    </button>
                )}
                <form className="quick-action" onSubmit={submitJoin} style={{ cursor: 'default' }}>
                    <span className="quick-action-icon"><KeyRound size={20} aria-hidden="true" /></span>
                    <div className="join-inline">
                        <input
                            className="input"
                            placeholder="Enter a code"
                            aria-label="Meeting code"
                            value={joinCode}
                            onChange={(e) => setJoinCode(formatJoinCode(e.target.value))}
                            spellCheck={false}
                            autoComplete="off"
                            style={{ height: 40 }}
                        />
                        <button type="submit" className="btn btn-tonal" disabled={!joinCode} aria-label="Join with this code">
                            Join
                        </button>
                    </div>
                </form>
                <Link to="/ask" className="quick-action">
                    <span className="quick-action-icon"><Sparkles size={20} aria-hidden="true" /></span>
                    <span>
                        <span className="quick-action-title" style={{ display: 'block' }}>Ask your meetings</span>
                        <span className="quick-action-sub" style={{ display: 'block' }}>Search every transcript</span>
                    </span>
                </Link>
            </div>

            {/* KPI row */}
            <div className="kpi-row">
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><CalendarClock size={15} aria-hidden="true" /></span> Meetings this week</div>
                    <div className="kpi-value">{thisWeek}</div>
                    <div className="kpi-hint">{counts.all} total · {counts.scheduled} scheduled</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><Clock size={15} aria-hidden="true" /></span> Hours in meetings</div>
                    <div className="kpi-value">{hoursLabel}</div>
                    <div className="kpi-hint">{Math.round(totalSeconds / 60)} minutes recorded</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label">
                        <span className="kpi-icon" style={counts.active ? { background: 'var(--color-success-soft)', color: 'var(--color-success-text)' } : undefined}>
                            <Activity size={15} aria-hidden="true" />
                        </span>
                        Live now
                    </div>
                    <div className="kpi-value" style={{ color: counts.active ? 'var(--color-success-text)' : undefined }}>
                        {counts.active}
                    </div>
                    <div className="kpi-hint">{counts.done} completed</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><BarChart2 size={15} aria-hidden="true" /></span> Reports ready</div>
                    <div className="kpi-value">{reports}</div>
                    <div className="kpi-hint">
                        {counts.done ? `${Math.round((reports / counts.done) * 100)}% of completed` : 'none yet'}
                    </div>
                </div>
            </div>

            {/* Toolbar */}
            <div className="section-title">
                <span>Your meetings</span>
            </div>
            <div className="toolbar">
                <div className="segmented" role="group" aria-label="Filter meetings">
                    {([
                        ['all', 'All'],
                        ['active', 'Live'],
                        ['scheduled', 'Scheduled'],
                        ['done', 'Completed'],
                    ] as [Filter, string][]).map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            className="segment"
                            aria-pressed={filter === key}
                            onClick={() => setFilter(key)}
                        >
                            {label}
                            <span className="segment-count">{counts[key]}</span>
                        </button>
                    ))}
                </div>

                <div className="search-bar" style={{ marginLeft: 'auto' }}>
                    <Search size={16} aria-hidden="true" />
                    <input
                        className="input"
                        type="search"
                        placeholder="Filter by title, person or code"
                        aria-label="Filter meetings"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </div>
            </div>

            {/* Table */}
            <div className="table-wrap">
                {isLoading ? (
                    <div aria-busy="true" aria-label="Loading meetings">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <div key={i} className="skeleton-row">
                                <div className="skeleton skeleton-text" style={{ width: `${55 + (i % 3) * 12}%` }} />
                                <div className="skeleton skeleton-text" style={{ width: 64 }} />
                                <div className="skeleton skeleton-text" style={{ width: 80 }} />
                                <div className="skeleton skeleton-text" style={{ width: 48 }} />
                            </div>
                        ))}
                    </div>
                ) : visible.length === 0 ? (
                    <div className="empty-state">
                        <EmptyIllustration />
                        <div className="empty-title">
                            {meetings.length === 0 ? 'No meetings yet' : 'Nothing matches that'}
                        </div>
                        <div className="empty-text">
                            {meetings.length === 0
                                ? 'Start a meeting and MeetAI will transcribe it, pull out the commitments, and write the minutes.'
                                : 'Try a different search or filter.'}
                        </div>
                        {meetings.length === 0 && canCreate && (
                            <button className="btn btn-primary" style={{ marginTop: '0.75rem' }} onClick={() => setShowCreate(true)}>
                                <Plus size={16} aria-hidden="true" /> New meeting
                            </button>
                        )}
                        {meetings.length > 0 && (
                            <button className="btn btn-ghost" style={{ marginTop: '0.5rem' }} onClick={() => { setQuery(''); setFilter('all') }}>
                                Clear filters
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="table-scroll">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th style={{ width: '36%' }}>Meeting</th>
                                    <th>Status</th>
                                    <th>Participants</th>
                                    <th>Code</th>
                                    <th>Duration</th>
                                    <th>When</th>
                                    <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((m) => (
                                    <tr key={m.meeting_id} onClick={() => open(m)} tabIndex={0}
                                        onKeyDown={(e) => { if (e.key === 'Enter') open(m) }}>
                                        <td>
                                            <div className="cell-title">{m.title}</div>
                                            <div className="cell-meta">
                                                by {m.created_by}
                                                {m.has_report && ' · Report ready'}
                                            </div>
                                        </td>
                                        <td>
                                            <span className={`badge ${STATUS_BADGE[m.status] ?? 'badge-gray'}`}>
                                                {STATUS_LABEL[m.status] ?? m.status}
                                            </span>
                                        </td>
                                        <td><People names={m.participants} /></td>
                                        <td onClick={(e) => e.stopPropagation()}><CodeCell code={m.join_code} /></td>
                                        <td className="cell-dim">{duration(m.duration_seconds)}</td>
                                        <td className="cell-dim">{relative(m.timestamp)}</td>
                                        <td onClick={(e) => e.stopPropagation()}>
                                            <div className="row-actions">
                                                <button
                                                    className="btn btn-sm btn-ghost"
                                                    onClick={() => setInsightsId(m.meeting_id)}
                                                    title="Summary, minutes, next actions and transcript"
                                                >
                                                    <Sparkles size={14} aria-hidden="true" /> Insights
                                                </button>
                                                {(m.status === 'active' || m.status === 'scheduled') && (
                                                    <button className="btn btn-sm btn-primary" onClick={() => navigate(`/meetings/${m.meeting_id}`)}>
                                                        <Video size={14} aria-hidden="true" /> {m.status === 'active' ? 'Join' : 'Start'}
                                                    </button>
                                                )}
                                                {(m.status === 'ended' || m.status === 'processed') && (
                                                    <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/meetings/${m.meeting_id}/report`)}>
                                                        <FileText size={14} aria-hidden="true" /> {m.has_report ? 'Report' : 'Transcript'}
                                                        <ArrowRight size={14} aria-hidden="true" />
                                                    </button>
                                                )}
                                                <button
                                                    className="btn btn-ghost btn-icon-sm"
                                                    title="Delete meeting"
                                                    aria-label={`Delete ${m.title}`}
                                                    onClick={() => remove(m.meeting_id)}
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {wrapUpId && <MeetingWrapUp meetingId={wrapUpId} onClose={closeWrapUp} autoGenerate />}

            {!wrapUpId && insightsId && (
                <MeetingWrapUp meetingId={insightsId} onClose={() => { setInsightsId(null); load() }} />
            )}

            {showCreate && (
                <CreateMeetingModal onClose={() => setShowCreate(false)} onCreated={load} />
            )}
        </>
    )
}
