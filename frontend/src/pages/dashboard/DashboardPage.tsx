import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
    Activity, BarChart2, CalendarClock, Check, Copy, FileText, KeyRound, Loader2,
    Plus, Search, Sparkles, Trash2, Users, Video, X,
} from 'lucide-react'
import { useAuthStore, useDashboardStore, useToastStore } from '../../store'
import { meetingApi, errorMessage } from '../../lib/api'
import { MeetingWrapUp } from '../../components/meeting/MeetingWrapUp'
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
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/* ── people ───────────────────────────────────────────────────────────── */

function People({ names }: { names: string[] }) {
    if (!names.length) return <span className="cell-dim">—</span>
    const shown = names.slice(0, 4)
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="avatar-stack">
                {shown.map((n) => (
                    <span key={n} className="avatar avatar-sm" title={n}>
                        {n[0]?.toUpperCase()}
                    </span>
                ))}
            </span>
            <span className="cell-dim">
                {names.length}
                {names.length > shown.length ? '' : ''}
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

    if (!code) return <span className="cell-dim">-</span>

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
        <button className="code-chip" onClick={handle} title="Copy invite link">
            {code}
            <span aria-hidden>{copied ? <Check size={12} /> : <Copy size={12} />}</span>
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

    // Mirrors MeetingCreate.title in models/meeting_model.py (min_length=3).
    // Enforced here too so a too-short title is caught before the round trip.
    const trimmed = title.trim()
    const titleValid = trimmed.length >= 3

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

    return (
        <div className="overlay" onClick={onClose}>
            <div className="action-popup" onClick={(e) => e.stopPropagation()}>
                <div className="action-popup-header">
                    <Video size={15} color="var(--color-primary)" />
                    New meeting
                    <button
                        className="btn btn-ghost btn-icon-sm"
                        onClick={onClose}
                        style={{ marginLeft: 'auto' }}
                        aria-label="Close"
                    >
                        <X size={14} />
                    </button>
                </div>
                <form onSubmit={handleCreate} style={{ padding: '1.125rem' }}>
                    <div className="form-group">
                        <label className="label" htmlFor="m-title">Title</label>
                        <input
                            id="m-title" className="input" autoFocus required
                            minLength={3} maxLength={200}
                            placeholder="Q4 roadmap review"
                            value={title} onChange={(e) => setTitle(e.target.value)}
                        />
                        {title.length > 0 && !titleValid && (
                            <span style={{ fontSize: '0.6875rem', color: 'var(--color-warning)' }}>
                                At least 3 characters.
                            </span>
                        )}
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="m-desc">Agenda <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                        <textarea
                            id="m-desc" className="input" rows={3}
                            placeholder="What needs to be decided?"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="m-part">Participants</label>
                        <input
                            id="m-part" className="input"
                            placeholder="priya, arjun, sam"
                            value={participants} onChange={(e) => setParticipants(e.target.value)}
                        />
                        <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                            Comma-separated usernames
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.125rem' }}>
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={isLoading || !titleValid}>
                            {isLoading ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                            Create &amp; join
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

/* ── page ─────────────────────────────────────────────────────────────── */

type Filter = 'all' | 'active' | 'scheduled' | 'done'

export function DashboardPage() {
    const { user } = useAuthStore()
    const { meetings, isLoading, setMeetings, setLoading } = useDashboardStore()
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')
    const [showCreate, setShowCreate] = useState(false)

    // Set by the meeting room on the way out: ?wrapup=<id> opens the
    // post-meeting panel over the dashboard.
    const [searchParams, setSearchParams] = useSearchParams()
    const wrapUpId = searchParams.get('wrapup')

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

    const people = useMemo(() => {
        const set = new Set<string>()
        meetings.forEach((m) => m.participants.forEach((p) => set.add(p)))
        return set.size
    }, [meetings])

    const totalMinutes = useMemo(
        () => Math.round(meetings.reduce((s, m) => s + (m.duration_seconds ?? 0), 0) / 60),
        [meetings],
    )

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

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>Overview</h1>
                    <div className="page-subtitle">
                        {counts.active > 0
                            ? `${counts.active} meeting${counts.active > 1 ? 's' : ''} live right now`
                            : 'Everything your meetings decided, in one place.'}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {/* Available to everyone: a participant with a code needs
                        this even though they cannot create meetings. */}
                    <button className="btn btn-secondary" onClick={() => navigate('/join')}>
                        <KeyRound size={14} /> Join with code
                    </button>
                    {canCreate && (
                        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
                            <Plus size={14} /> New meeting
                        </button>
                    )}
                </div>
            </div>

            {/* KPI strip — one instrument, hairline-divided */}
            <div className="kpi-row">
                <div className="kpi">
                    <div className="kpi-label"><Video size={11} /> Meetings</div>
                    <div className="kpi-value">{counts.all}</div>
                    <div className="kpi-hint">{counts.scheduled} scheduled</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><Activity size={11} /> Live now</div>
                    <div className="kpi-value" style={{ color: counts.active ? 'var(--color-success)' : undefined }}>
                        {counts.active}
                    </div>
                    <div className="kpi-hint">{counts.done} completed</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><BarChart2 size={11} /> AI reports</div>
                    <div className="kpi-value">{reports}</div>
                    <div className="kpi-hint">
                        {counts.done ? `${Math.round((reports / counts.done) * 100)}% of completed` : 'none yet'}
                    </div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><Users size={11} /> Participants</div>
                    <div className="kpi-value">{people}</div>
                    <div className="kpi-hint">{totalMinutes} min recorded</div>
                </div>
            </div>

            {/* Toolbar */}
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
                            className="segment"
                            aria-pressed={filter === key}
                            onClick={() => setFilter(key)}
                        >
                            {label}
                            <span className="segment-count">{counts[key]}</span>
                        </button>
                    ))}
                </div>

                <div className="search-bar">
                    <Search size={15} />
                    <input
                        className="input"
                        placeholder="Search meetings…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </div>
            </div>

            {/* Table */}
            <div className="table-wrap">
                {isLoading ? (
                    <div style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {[0, 1, 2, 3].map((i) => (
                            <div key={i} className="skeleton" style={{ height: 44 }} />
                        ))}
                    </div>
                ) : visible.length === 0 ? (
                    <div className="empty-state">
                        <span className="empty-state-icon"><CalendarClock size={18} /></span>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                            {meetings.length === 0 ? 'No meetings yet' : 'Nothing matches that'}
                        </div>
                        <div style={{ fontSize: '0.8125rem', maxWidth: '38ch' }}>
                            {meetings.length === 0
                                ? 'Start a meeting and MeetAI will transcribe it, pull out the commitments, and write the minutes.'
                                : 'Try a different search or filter.'}
                        </div>
                        {meetings.length === 0 && canCreate && (
                            <button className="btn btn-primary" style={{ marginTop: '0.5rem' }} onClick={() => setShowCreate(true)}>
                                <Plus size={14} /> New meeting
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="table-scroll">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th style={{ width: '38%' }}>Meeting</th>
                                    <th>Status</th>
                                    <th>Participants</th>
                                    <th>Code</th>
                                    <th>Duration</th>
                                    <th>Created</th>
                                    <th style={{ width: 1 }} aria-label="Actions" />
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
                                                {m.has_report && ' · AI report ready'}
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
                                                    <Sparkles size={12} /> Insights
                                                </button>
                                                {(m.status === 'active' || m.status === 'scheduled') && (
                                                    <button className="btn btn-sm btn-primary" onClick={() => navigate(`/meetings/${m.meeting_id}`)}>
                                                        <Video size={12} /> {m.status === 'active' ? 'Join' : 'Start'}
                                                    </button>
                                                )}
                                                {(m.status === 'ended' || m.status === 'processed') && (
                                                    <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/meetings/${m.meeting_id}/report`)}>
                                                        <FileText size={12} /> {m.has_report ? 'Report' : 'Transcript'}
                                                    </button>
                                                )}
                                                <button
                                                    className="btn btn-ghost btn-icon-sm"
                                                    title="Delete meeting"
                                                    onClick={() => remove(m.meeting_id)}
                                                >
                                                    <Trash2 size={13} />
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
