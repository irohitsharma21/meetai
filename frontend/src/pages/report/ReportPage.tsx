import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import {
    ArrowLeft, FileText, CheckCircle2,
    Clock, Users, Sparkles, Brain, Calendar,
    TrendingUp, TrendingDown, Minus, Download, RefreshCw
} from 'lucide-react'
import { meetingApi, transcriptApi } from '../../lib/api'
import { useToastStore } from '../../store'
import { TranscriptPanel } from '../../components/meeting/TranscriptPanel'
import type { Meeting, SentimentLabel } from '../../types'
import { format } from 'date-fns'

function SentimentIcon({ sentiment }: { sentiment: SentimentLabel }) {
    if (sentiment === 'positive') return <TrendingUp size={20} color="var(--color-success)" />
    if (sentiment === 'negative') return <TrendingDown size={20} color="var(--color-danger)" />
    return <Minus size={20} color="var(--color-warning)" />
}

function SentimentCard({ analysis }: { analysis: Meeting['ai_analysis'] }) {
    const s = analysis.sentiment
    if (!s) return null

    const color = s.overall === 'positive' ? 'var(--color-success)'
        : s.overall === 'negative' ? 'var(--color-danger)'
            : 'var(--color-warning)'

    return (
        <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <SentimentIcon sentiment={s.overall} />
                <div>
                    <h4 style={{ textTransform: 'capitalize', color }}>{s.overall}</h4>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Confidence: {Math.round(s.confidence * 100)}%
                    </div>
                </div>
                {/* Confidence bar */}
                <div style={{ flex: 1, height: 6, background: 'var(--color-bg-base)', borderRadius: '999px', overflow: 'hidden' }}>
                    <div style={{
                        height: '100%', width: `${s.confidence * 100}%`,
                        background: color, borderRadius: '999px',
                        transition: 'width 1s ease',
                    }} />
                </div>
            </div>

            {s.emotional_tone && (
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', fontStyle: 'italic' }}>
                    "{s.emotional_tone}"
                </p>
            )}

            {s.key_shifts.length > 0 && (
                <div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                        Key Moments
                    </div>
                    <ul style={{ padding: '0', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        {s.key_shifts.map((shift, i) => (
                            <li key={i} style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>•</span>
                                {shift}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

function NextActionsCard({ actions, meetingId: _meetingId }: { actions: Meeting['ai_analysis']['next_actions']; meetingId: string }) {
    const localActions = actions

    const statusColor = {
        pending: 'var(--color-warning)',
        confirmed: 'var(--color-success)',
        rejected: 'var(--color-danger)',
        cancelled: 'var(--text-muted)',
    }

    return (
        <div className="card">
            <h3 style={{ fontSize: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={18} color="var(--color-success)" />
                Action Items ({localActions.length})
            </h3>
            {localActions.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No action items detected</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {localActions.map((action) => (
                        <div key={action.id} style={{
                            padding: '0.875rem',
                            background: 'var(--color-bg-elevated)',
                            borderRadius: 'var(--radius-md)',
                            border: `1px solid ${statusColor[action.status] || 'var(--color-border)'}30`,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                                <div style={{ fontWeight: 600, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>
                                    {action.task}
                                </div>
                                <span className={`badge ${action.status === 'confirmed' ? 'badge-green'
                                    : action.status === 'rejected' ? 'badge-red'
                                        : 'badge-amber'
                                    }`}>{action.status}</span>
                            </div>
                            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                                {action.assignee && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        👤 {action.assignee}
                                    </span>
                                )}
                                {action.date && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        📅 {action.date}
                                    </span>
                                )}
                                {action.deadline && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)' }}>
                                        ⏰ {action.deadline}
                                    </span>
                                )}
                                {action.calendar_event_id && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--color-success)' }}>
                                        ✅ On Calendar
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export function ReportPage() {
    const { meetingId } = useParams<{ meetingId: string }>()
    const { addToast } = useToastStore()
    const [meeting, setMeeting] = useState<Meeting | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isGenerating, setIsGenerating] = useState(false)
    const [activeTab, setActiveTab] = useState<'summary' | 'mom' | 'transcript' | 'actions'>('summary')

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

    const handleExport = async () => {
        try {
            const res = await transcriptApi.export(meetingId!, 'txt')
            const blob = new Blob([res.data], { type: 'text/plain' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `meeting-${meetingId}.txt`
            a.click()
        } catch {
            addToast({ type: 'error', title: 'Export failed' })
        }
    }

    if (isLoading) {
        return (
            <div className="page">
                <div className="container">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 100, borderRadius: 'var(--radius-lg)' }} />)}
                    </div>
                </div>
            </div>
        )
    }

    if (!meeting) return null

    const analysis = meeting.ai_analysis
    const hasReport = !!(analysis.summary || analysis.mom)
    const duration = meeting.duration_seconds
        ? `${Math.floor(meeting.duration_seconds / 60)}m ${meeting.duration_seconds % 60}s`
        : 'N/A'

    const tabs = [
        { key: 'summary', label: 'Summary', icon: <Brain size={14} /> },
        { key: 'mom', label: 'Minutes', icon: <FileText size={14} /> },
        { key: 'transcript', label: 'Transcript', icon: <Users size={14} /> },
        { key: 'actions', label: `Actions (${analysis.next_actions.length})`, icon: <CheckCircle2 size={14} /> },
    ]

    return (
        <div className="page">
            <div className="container">
                {/* Back link */}
                <Link to="/dashboard" className="btn btn-ghost btn-sm" style={{ marginBottom: '1.5rem', display: 'inline-flex' }}>
                    <ArrowLeft size={15} /> Back to Dashboard
                </Link>

                {/* Meeting header */}
                <div className="card" style={{ marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                <h1 style={{ fontSize: '1.5rem' }}>{meeting.title}</h1>
                                <span className={`badge ${meeting.status === 'processed' ? 'badge-purple' : 'badge-gray'}`}>
                                    {meeting.status}
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <Calendar size={13} />
                                    {format(new Date(meeting.timestamp), 'PPP')}
                                </span>
                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <Clock size={13} /> {duration}
                                </span>
                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <Users size={13} /> {meeting.participants.length} participants
                                </span>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn btn-secondary btn-sm" onClick={handleExport}>
                                <Download size={14} /> Export
                            </button>
                            <button className="btn btn-primary" onClick={handleGenerateReport} disabled={isGenerating}>
                                {isGenerating ? (
                                    <><RefreshCw size={15} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</>
                                ) : (
                                    <><Sparkles size={15} /> {hasReport ? 'Regenerate Report' : 'Generate AI Report'}</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Sentiment (always shown if available) */}
                {analysis.sentiment && (
                    <div style={{ marginBottom: '1.5rem' }}>
                        <SentimentCard analysis={analysis} />
                    </div>
                )}

                {/* Tab navigation */}
                <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', background: 'var(--color-bg-surface)', padding: '0.25rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', width: 'fit-content' }}>
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            className={`btn btn-sm ${activeTab === tab.key ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setActiveTab(tab.key as typeof activeTab)}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                        >
                            {tab.icon} {tab.label}
                        </button>
                    ))}
                </div>

                {/* Tab content */}
                {activeTab === 'summary' && (
                    <div className="card animate-fadeIn">
                        {analysis.summary ? (
                            <>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                                    <Brain size={18} color="var(--color-purple)" />
                                    <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Executive Summary</h3>
                                </div>
                                <p style={{ lineHeight: 1.8, fontSize: '0.9375rem', color: 'var(--text-secondary)' }}>
                                    {analysis.summary}
                                </p>
                                {analysis.keywords.length > 0 && (
                                    <div style={{ marginTop: '1.5rem' }}>
                                        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Keywords</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                                            {analysis.keywords.map((k) => (
                                                <span key={k} className="badge badge-blue">{k}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="empty-state">
                                <Brain size={40} style={{ opacity: 0.3 }} />
                                <p>No summary yet. Click "Generate AI Report" to create one.</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'mom' && (
                    <div className="card animate-fadeIn">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                            <FileText size={18} color="var(--color-accent)" />
                            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Minutes of Meeting</h3>
                        </div>
                        {analysis.mom ? (
                            <div className="markdown-body">
                                <ReactMarkdown>{analysis.mom}</ReactMarkdown>
                            </div>
                        ) : (
                            <div className="empty-state">
                                <FileText size={40} style={{ opacity: 0.3 }} />
                                <p>No MoM yet. Click "Generate AI Report" to create one.</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'transcript' && (
                    <div className="card animate-fadeIn" style={{ padding: 0, overflow: 'hidden' }}>
                        <div style={{ maxHeight: 600, overflow: 'auto' }}>
                            <TranscriptPanel
                                meetingId={meetingId}
                                entries={meeting.transcript}
                                compact
                            />
                        </div>
                    </div>
                )}

                {activeTab === 'actions' && (
                    <div className="animate-fadeIn">
                        <NextActionsCard actions={analysis.next_actions} meetingId={meetingId!} />
                    </div>
                )}
            </div>

            <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
        </div>
    )
}
