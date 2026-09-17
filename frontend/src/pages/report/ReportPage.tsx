import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import {
    ArrowLeft, FileText, CheckCircle2, Clock, Users, Sparkles, Calendar,
    FileDown, RefreshCw, BarChart3, Mail, Printer, Smile, Frown, Meh,
    MessageSquare, CalendarCheck, Loader2,
} from 'lucide-react'
import { insightApi, meetingApi, transcriptApi, errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import { TranscriptPanel } from '../../components/meeting/TranscriptPanel'
import { AnalyticsPanel } from '../../components/meeting/AnalyticsPanel'
import { usePageTitle } from '../../components/common/usePageTitle'
import { SectionTools } from '../../components/common/SectionTools'
import {
    downloadText, minutesToMarkdown, reportToMarkdown, slugify, summaryToMarkdown,
    transcriptToJson, transcriptToText,
} from '../../components/common/exporters'
import type { Meeting, SentimentLabel, NextAction } from '../../types'
import { format } from 'date-fns'

const SECTIONS = [
    { id: 'summary', label: 'Summary' },
    { id: 'minutes', label: 'Minutes' },
    { id: 'actions', label: 'Actions' },
    { id: 'sentiment', label: 'Sentiment' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'transcript', label: 'Transcript' },
] as const

type SectionId = typeof SECTIONS[number]['id']

const ACTION_BADGE: Record<NextAction['status'], string> = {
    pending: 'badge-amber',
    confirmed: 'badge-green',
    rejected: 'badge-red',
    cancelled: 'badge-gray',
}

function SentimentIcon({ sentiment }: { sentiment: SentimentLabel }) {
    if (sentiment === 'positive') return <Smile size={22} />
    if (sentiment === 'negative') return <Frown size={22} />
    return <Meh size={22} />
}

function SentimentSection({ analysis }: { analysis: Meeting['ai_analysis'] }) {
    const s = analysis.sentiment
    if (!s) return <div className="report-empty"><Meh size={16} /> No sentiment analysis yet. Generate the report to add one.</div>

    return (
        <div className="sentiment-strip">
            <span className="sentiment-face" data-tone={s.overall}><SentimentIcon sentiment={s.overall} /></span>
            <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '1rem', fontWeight: 500, textTransform: 'capitalize' }}>{s.overall}</span>
                    <span className="text-sm muted">{Math.round(s.confidence * 100)}% confidence</span>
                </div>
                <div className="sentiment-meter" style={{ marginTop: '0.5rem' }} role="meter" aria-valuenow={Math.round(s.confidence * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Sentiment confidence">
                    <i style={{ width: `${Math.round(s.confidence * 100)}%` }} />
                </div>
                {s.emotional_tone && (
                    <p className="text-sm muted" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>“{s.emotional_tone}”</p>
                )}
            </div>
            {s.key_shifts.length > 0 && (
                <ul className="sentiment-shifts">
                    {s.key_shifts.map((shift, i) => <li key={i}>{shift}</li>)}
                </ul>
            )}
        </div>
    )
}

function ActionsTable({ actions }: { actions: NextAction[] }) {
    if (actions.length === 0) {
        return <div className="report-empty"><CheckCircle2 size={16} /> No action items were detected in this meeting.</div>
    }
    return (
        <div className="table-wrap">
            <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th style={{ width: '46%' }}>Task</th>
                            <th>Owner</th>
                            <th>Due</th>
                            <th>Status</th>
                            <th>Calendar</th>
                        </tr>
                    </thead>
                    <tbody>
                        {actions.map((a) => (
                            <tr key={a.id} style={{ cursor: 'default' }}>
                                <td>
                                    <div className="cell-title">{a.task}</div>
                                    {a.description && <div className="cell-meta">{a.description}</div>}
                                </td>
                                <td className="cell-dim">{a.assignee || '—'}</td>
                                <td className="cell-dim">{a.deadline || a.date || '—'}</td>
                                <td><span className={`badge ${ACTION_BADGE[a.status] ?? 'badge-gray'}`}>{a.status}</span></td>
                                <td className="cell-dim">
                                    {a.calendar_event_id
                                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-success-text)' }}><CalendarCheck size={14} aria-hidden="true" /> Scheduled</span>
                                        : '—'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

export function ReportPage() {
    const { meetingId } = useParams<{ meetingId: string }>()
    const { addToast } = useToastStore()
    const [meeting, setMeeting] = useState<Meeting | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isGenerating, setIsGenerating] = useState(false)
    const [isSendingDigest, setIsSendingDigest] = useState(false)
    const [active, setActive] = useState<SectionId>('summary')
    const docRef = useRef<HTMLDivElement>(null)

    usePageTitle(meeting ? `${meeting.title} · Report` : 'Report')

    const loadMeeting = async () => {
        try {
            setIsLoading(true)
            const res = await meetingApi.get(meetingId!)
            setMeeting(res.data)
        } catch {
            addToast({ type: 'error', title: 'Failed to load meeting' })
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => { loadMeeting() }, [meetingId])

    // Highlight the section under the reader in the mini table of contents.
    useEffect(() => {
        if (!meeting || typeof IntersectionObserver === 'undefined') return
        const nodes = SECTIONS
            .map((s) => document.getElementById(`section-${s.id}`))
            .filter((n): n is HTMLElement => !!n)
        const io = new IntersectionObserver(
            (entries) => {
                const hit = entries
                    .filter((e) => e.isIntersecting)
                    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
                if (hit) setActive(hit.target.id.replace('section-', '') as SectionId)
            },
            { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
        )
        nodes.forEach((n) => io.observe(n))
        return () => io.disconnect()
    }, [meeting])

    const handleGenerateReport = async () => {
        try {
            setIsGenerating(true)
            const res = await meetingApi.generateReport(meetingId!, ['summary', 'mom', 'sentiment'])
            setMeeting((m) => m ? { ...m, ai_analysis: res.data.analysis } : m)
            addToast({ type: 'success', title: 'AI Report generated successfully!' })
        } catch {
            addToast({ type: 'error', title: 'Report generation failed' })
        } finally {
            setIsGenerating(false)
        }
    }

    /**
     * Transcript file body. The server's export endpoint already produces
     * both formats, so it is the source of truth; the client-side rendering
     * of the loaded transcript is the fallback when the request fails.
     */
    const transcriptFile = async (fmt: 'txt' | 'json'): Promise<string> => {
        try {
            const res = await transcriptApi.export(meetingId!, fmt)
            return typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2)
        } catch {
            if (!meeting) throw new Error('no transcript loaded')
            return fmt === 'json'
                ? transcriptToJson(meetingId, meeting.transcript)
                : transcriptToText(meeting.transcript, { title: meeting.title, date: meeting.timestamp })
        }
    }

    const handleExportReport = () => {
        if (!meeting) return
        try {
            const dateLabel = Number.isNaN(new Date(meeting.timestamp).getTime()) ? meeting.timestamp : format(new Date(meeting.timestamp), 'PPP p')
            downloadText(`${slugify(meeting.title)}-report.md`, reportToMarkdown(meeting, { dateLabel }), 'text/markdown')
        } catch {
            addToast({ type: 'error', title: 'Export failed' })
        }
    }

    const handleDigest = async () => {
        setIsSendingDigest(true)
        try {
            const res = await insightApi.sendDigest(meetingId!)
            addToast({
                type: res.data.sent > 0 ? 'success' : 'info',
                title: res.data.sent > 0 ? 'Digest sent' : 'Nothing sent',
                message: res.data.sent > 0
                    ? `Delivered to ${res.data.sent} participant${res.data.sent === 1 ? '' : 's'}`
                    : res.data.note ?? 'No participants had an email address on file',
            })
        } catch (err: any) {
            addToast({
                type: 'error',
                title: 'Could not send digest',
                message: errorMessage(err, 'Email is not configured'),
            })
        } finally {
            setIsSendingDigest(false)
        }
    }

    if (isLoading) {
        return (
            <div className="report-layout" aria-busy="true">
                <div className="report-doc" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div className="skeleton" style={{ height: 36, width: '60%' }} />
                    <div className="skeleton" style={{ height: 16, width: '40%' }} />
                    {[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 120, borderRadius: 'var(--radius-lg)' }} />)}
                </div>
            </div>
        )
    }

    if (!meeting) {
        return (
            <div className="empty-state">
                <span className="empty-state-icon"><FileText size={22} /></span>
                <div className="empty-title">Meeting not found</div>
                <div className="empty-text">It may have been deleted, or you may not have access to it.</div>
                <Link to="/dashboard" className="btn" style={{ marginTop: '0.5rem' }}><ArrowLeft size={16} /> Back to home</Link>
            </div>
        )
    }

    const analysis = meeting.ai_analysis
    const hasReport = !!(analysis.summary || analysis.mom)
    const duration = meeting.duration_seconds
        ? `${Math.floor(meeting.duration_seconds / 60)} min ${meeting.duration_seconds % 60} s`
        : 'N/A'
    const when = Number.isNaN(new Date(meeting.timestamp).getTime()) ? '—' : format(new Date(meeting.timestamp), 'PPP')

    const counts: Partial<Record<SectionId, number>> = {
        actions: analysis.next_actions.length,
        transcript: meeting.transcript.length,
    }
    const slug = slugify(meeting.title)

    return (
        <div className="report-layout">
            <article className="report-doc" ref={docRef}>
                <Link to="/dashboard" className="btn btn-ghost btn-sm no-print" style={{ marginLeft: '-0.75rem', marginBottom: '1rem' }}>
                    <ArrowLeft size={16} aria-hidden="true" /> Home
                </Link>

                <header className="report-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                        <span className={`badge ${meeting.status === 'processed' ? 'badge-purple' : meeting.status === 'active' ? 'badge-green' : 'badge-gray'}`}>
                            {meeting.status}
                        </span>
                        {hasReport && <span className="badge badge-blue badge-plain"><Sparkles size={12} aria-hidden="true" /> AI report</span>}
                    </div>
                    <h1 className="report-title">{meeting.title}</h1>
                    <div className="report-meta">
                        <span><Calendar size={14} aria-hidden="true" /> {when}</span>
                        <span><Clock size={14} aria-hidden="true" /> {duration}</span>
                        <span><Users size={14} aria-hidden="true" /> {meeting.participants.length} participant{meeting.participants.length === 1 ? '' : 's'}</span>
                        <span>Hosted by {meeting.created_by}</span>
                    </div>
                    {meeting.description && (
                        <p className="report-prose" style={{ marginTop: '0.75rem' }}>{meeting.description}</p>
                    )}
                    <div className="report-toolbar no-print">
                        <button className="btn btn-primary" onClick={handleGenerateReport} disabled={isGenerating}>
                            {isGenerating
                                ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Generating…</>
                                : <><Sparkles size={16} aria-hidden="true" /> {hasReport ? 'Regenerate report' : 'Generate AI report'}</>}
                        </button>
                        <button className="btn" onClick={handleExportReport} title={`Download ${slug}-report.md`}>
                            <FileDown size={16} aria-hidden="true" /> Export report
                        </button>
                        <button
                            className="btn"
                            onClick={handleDigest}
                            disabled={isSendingDigest}
                            title="Email the summary and action items to participants"
                        >
                            {isSendingDigest ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
                            Email digest
                        </button>
                        <button className="btn" onClick={() => window.print()}>
                            <Printer size={16} aria-hidden="true" /> Print
                        </button>
                    </div>
                </header>

                <section id="section-summary" className="report-section">
                    <h2 className="report-h2">
                        <Sparkles size={18} aria-hidden="true" /> Summary
                        {analysis.summary && (
                            <SectionTools
                                className="no-print"
                                label="summary"
                                getText={() => analysis.summary}
                                downloads={[{ label: 'Markdown', filename: `${slug}-summary.md`, getText: () => summaryToMarkdown(meeting) }]}
                            />
                        )}
                    </h2>
                    {analysis.summary ? (
                        <div className="report-prose">
                            <p>{analysis.summary}</p>
                            {analysis.keywords.length > 0 && (
                                <div className="keyword-row">
                                    {analysis.keywords.map((k) => <span key={k} className="badge badge-gray badge-plain">{k}</span>)}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="report-empty"><Sparkles size={16} /> No summary yet. Generate the report to write one.</div>
                    )}
                </section>

                <section id="section-minutes" className="report-section">
                    <h2 className="report-h2">
                        <FileText size={18} aria-hidden="true" /> Minutes
                        {analysis.mom && (
                            <SectionTools
                                className="no-print"
                                label="minutes"
                                getText={() => analysis.mom}
                                downloads={[{ label: 'Markdown', filename: `${slug}-minutes.md`, getText: () => minutesToMarkdown(meeting) }]}
                            />
                        )}
                    </h2>
                    {analysis.mom ? (
                        <div className="markdown-body">
                            <ReactMarkdown>{analysis.mom}</ReactMarkdown>
                        </div>
                    ) : (
                        <div className="report-empty"><FileText size={16} /> No minutes yet. Generate the report to write them.</div>
                    )}
                </section>

                <section id="section-actions" className="report-section">
                    <h2 className="report-h2"><CheckCircle2 size={18} aria-hidden="true" /> Action items <span className="muted" style={{ fontWeight: 400 }}>({analysis.next_actions.length})</span></h2>
                    <ActionsTable actions={analysis.next_actions} />
                </section>

                <section id="section-sentiment" className="report-section">
                    <h2 className="report-h2"><Smile size={18} aria-hidden="true" /> Sentiment</h2>
                    <SentimentSection analysis={analysis} />
                </section>

                <section id="section-analytics" className="report-section">
                    <h2 className="report-h2"><BarChart3 size={18} aria-hidden="true" /> Analytics</h2>
                    {meetingId && <AnalyticsPanel meetingId={meetingId} />}
                </section>

                <section id="section-transcript" className="report-section">
                    <h2 className="report-h2">
                        <MessageSquare size={18} aria-hidden="true" /> Transcript <span className="muted" style={{ fontWeight: 400 }}>({meeting.transcript.length})</span>
                        {meeting.transcript.length > 0 && (
                            <SectionTools
                                className="no-print"
                                label="transcript"
                                getText={() => transcriptToText(meeting.transcript)}
                                downloads={[
                                    { label: 'Plain text', filename: `${slug}-transcript.txt`, getText: () => transcriptFile('txt') },
                                    { label: 'JSON', filename: `${slug}-transcript.json`, getText: () => transcriptFile('json') },
                                ]}
                            />
                        )}
                    </h2>
                    <div className="panel" style={{ overflow: 'hidden' }}>
                        <div style={{ maxHeight: 640, overflow: 'auto', display: 'flex' }}>
                            <TranscriptPanel
                                meetingId={meetingId}
                                entries={meeting.transcript}
                                compact
                            />
                        </div>
                    </div>
                </section>
            </article>

            <nav className="report-toc no-print" aria-label="On this page">
                <div className="report-toc-label">On this page</div>
                {SECTIONS.map((s) => (
                    <a
                        key={s.id}
                        href={`#section-${s.id}`}
                        aria-current={active === s.id ? 'true' : undefined}
                        onClick={(e) => {
                            e.preventDefault()
                            document.getElementById(`section-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            setActive(s.id)
                        }}
                    >
                        {s.label}
                        {counts[s.id] !== undefined && <span className="report-toc-count">{counts[s.id]}</span>}
                    </a>
                ))}
            </nav>
        </div>
    )
}
