/**
 * Meeting insights panel.
 *
 * Opened two ways: automatically over the dashboard when someone leaves a
 * meeting, and from the Insights button on any row in the meetings list.
 *
 * Each section is written on demand, when its own tab is first shown. That is
 * deliberate rather than incidental - a meeting has four things you might want
 * from it, and generating all four costs four model calls, most of which
 * nobody asked for. Opening a row to read the transcript costs nothing at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    CheckCircle2, ClipboardList, FileText, Loader2, ListTodo,
    ExternalLink, X, AlertTriangle, Clock, Users, MessageSquare, Sparkles, Radio,
} from 'lucide-react'
import { meetingApi, transcriptApi, errorMessage } from '../../lib/api'
import type { AIAnalysis, Meeting, NextAction, TranscriptEntry } from '../../types'
import { SectionTools } from '../common/SectionTools'
import {
    minutesToMarkdown, slugify, summaryToMarkdown, transcriptToJson, transcriptToText,
} from '../common/exporters'

type Tab = 'summary' | 'mom' | 'actions' | 'transcript'
type Generated = Exclude<Tab, 'transcript'>

/** Tabs backed by a model call, and the report_type each one asks for. */
const REPORT_TYPE: Record<Generated, string> = {
    summary: 'summary',
    mom: 'mom',
    actions: 'actions',
}

/** Stable, theme-aware colour for a speaker name. */
function speakerColor(name: string): string {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return `var(--speaker-${(h % 6) + 1})`
}

/** Minimal Markdown rendering: the models emit headings, bullets and bold. */
function Markdown({ text }: { text: string }) {
    const lines = useMemo(() => text.split('\n'), [text])

    const bold = (s: string) =>
        s.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith('**') && part.endsWith('**')
                ? <strong key={j}>{part.slice(2, -2)}</strong>
                : <span key={j}>{part}</span>,
        )

    return (
        <div className="wrapup-prose">
            {lines.map((line, i) => {
                if (/^###\s/.test(line)) return <h4 key={i}>{bold(line.replace(/^###\s/, ''))}</h4>
                if (/^##?\s/.test(line)) return <h3 key={i}>{bold(line.replace(/^##?\s/, ''))}</h3>
                if (/^\s*[-*]\s/.test(line)) {
                    return <div key={i} className="wrapup-bullet">{bold(line.replace(/^\s*[-*]\s/, ''))}</div>
                }
                if (!line.trim()) return <div key={i} style={{ height: '0.5rem' }} />
                return <p key={i}>{bold(line)}</p>
            })}
        </div>
    )
}

function TranscriptView({ entries, live }: { entries: TranscriptEntry[]; live: boolean }) {
    if (!entries.length) {
        return (
            <div className="wrapup-empty">
                <span className="empty-state-icon"><MessageSquare size={20} /></span>
                <p>{live
                    ? 'Nothing has been transcribed yet. Lines appear here as people speak.'
                    : 'No transcript was recorded for this meeting.'}</p>
            </div>
        )
    }
    return (
        <div className="wrapup-transcript">
            {entries.map((e, i) => (
                <div key={e.id ?? i} className="wrapup-line">
                    <span className="transcript-avatar" style={{ background: speakerColor(e.speaker) }} aria-hidden="true">
                        {e.speaker[0]?.toUpperCase()}
                    </span>
                    <div style={{ minWidth: 0 }}>
                        <div className="wrapup-line-head">
                            <span className="wrapup-speaker">{e.speaker}</span>
                            <span className="wrapup-time">{e.time}</span>
                        </div>
                        <div className="wrapup-line-text">{e.text}</div>
                    </div>
                </div>
            ))}
        </div>
    )
}

function ActionList({ actions }: { actions: NextAction[] }) {
    if (!actions.length) {
        return (
            <div className="wrapup-empty">
                <span className="empty-state-icon"><ListTodo size={20} /></span>
                <p>No commitments were found in this meeting.</p>
            </div>
        )
    }
    return (
        <div className="wrapup-actions">
            {actions.map((a, i) => (
                <div key={i} className="wrapup-action">
                    <CheckCircle2 size={15} className="wrapup-action-icon" />
                    <div style={{ minWidth: 0 }}>
                        <div className="wrapup-action-task">{a.task}</div>
                        <div className="wrapup-action-meta">
                            {a.assignee && <span><Users size={11} /> {a.assignee}</span>}
                            {(a.deadline || a.date) && <span><Clock size={11} /> {a.deadline || a.date}</span>}
                            {typeof a.confidence === 'number' && (
                                <span className="wrapup-conf">{Math.round(a.confidence * 100)}%</span>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

export function MeetingWrapUp({
    meetingId,
    onClose,
    /**
     * Open straight onto the summary and write it. True when someone has just
     * left a meeting - that is the moment the wrap-up exists for. False from
     * the meetings list, where the transcript is the landing tab because it
     * needs no model call.
     */
    autoGenerate = false,
}: {
    meetingId: string
    onClose: () => void
    autoGenerate?: boolean
}) {
    const navigate = useNavigate()
    const [meeting, setMeeting] = useState<Meeting | null>(null)
    const [tab, setTab] = useState<Tab>(autoGenerate ? 'summary' : 'transcript')
    const [pending, setPending] = useState<Partial<Record<Tab, boolean>>>({})
    const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({})
    const [loadError, setLoadError] = useState<string | null>(null)

    const analysis: AIAnalysis | undefined = meeting?.ai_analysis
    const transcript = meeting?.transcript ?? []
    const isLive = meeting?.status === 'active'

    /** Whether a tab already has something to show. */
    const has = useCallback((t: Tab): boolean => {
        if (t === 'transcript') return true
        if (t === 'summary') return !!analysis?.summary
        if (t === 'mom') return !!analysis?.mom
        return (analysis?.next_actions?.length ?? 0) > 0
    }, [analysis])

    /**
     * Ask the server for exactly one section.
     *
     * Called only for the tab being looked at, and only when that tab has
     * nothing yet, so an open panel costs as many model calls as the reader
     * asked questions - no more.
     */
    const generate = useCallback(async (t: Generated) => {
        setPending((p) => ({ ...p, [t]: true }))
        setErrors((e) => ({ ...e, [t]: undefined }))
        try {
            const { data } = await meetingApi.generateReport(meetingId, [REPORT_TYPE[t]])
            // Response is {status, meeting_id, analysis}. The server merges the
            // new section into the stored analysis, so this is the whole object
            // and previously generated sections survive.
            setMeeting((prev) => (prev ? { ...prev, ai_analysis: data.analysis } : prev))
        } catch (err) {
            setErrors((e) => ({ ...e, [t]: errorMessage(err, 'That section could not be written.') }))
        } finally {
            setPending((p) => ({ ...p, [t]: false }))
        }
    }, [meetingId])

    useEffect(() => {
        let cancelled = false
        meetingApi.get(meetingId)
            .then(({ data }) => { if (!cancelled) setMeeting(data) })
            .catch((err) => { if (!cancelled) setLoadError(errorMessage(err, 'Could not load the meeting.')) })
        return () => { cancelled = true }
    }, [meetingId])

    // Write whatever the visible tab needs, once the meeting has loaded. A tab
    // that already failed is not retried automatically - the user gets a button.
    useEffect(() => {
        if (!meeting || tab === 'transcript') return
        if (has(tab) || pending[tab] || errors[tab] || transcript.length === 0) return
        generate(tab as Generated)
    }, [meeting, tab, has, pending, errors, transcript.length, generate])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const tabs: { key: Tab; label: string; icon: JSX.Element }[] = [
        { key: 'summary', label: 'Summary', icon: <FileText size={13} /> },
        { key: 'mom', label: 'Minutes', icon: <ClipboardList size={13} /> },
        { key: 'actions', label: 'Next actions', icon: <ListTodo size={13} /> },
        { key: 'transcript', label: 'Transcript', icon: <MessageSquare size={13} /> },
    ]

    const labelFor = (t: Tab) => tabs.find((x) => x.key === t)?.label.toLowerCase() ?? 'section'
    const slug = slugify(meeting?.title)

    /** Server export where it exists; the loaded transcript otherwise. */
    const transcriptFile = async (fmt: 'txt' | 'json'): Promise<string> => {
        try {
            const res = await transcriptApi.export(meetingId, fmt)
            return typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2)
        } catch {
            return fmt === 'json'
                ? transcriptToJson(meetingId, transcript)
                : transcriptToText(transcript, { title: meeting?.title, date: meeting?.timestamp })
        }
    }

    /** Copy / download row for the visible tab, when it has content. */
    const tools = () => {
        if (!meeting) return null
        if (tab === 'transcript' && transcript.length > 0) {
            return (
                <div className="wrapup-tools">
                    <SectionTools
                        label="transcript"
                        getText={() => transcriptToText(transcript)}
                        downloads={[
                            { label: 'Plain text', filename: `${slug}-transcript.txt`, getText: () => transcriptFile('txt') },
                            { label: 'JSON', filename: `${slug}-transcript.json`, getText: () => transcriptFile('json') },
                        ]}
                    />
                </div>
            )
        }
        if (tab === 'summary' && analysis?.summary) {
            return (
                <div className="wrapup-tools">
                    <SectionTools
                        label="summary"
                        getText={() => analysis.summary}
                        downloads={[{ label: 'Markdown', filename: `${slug}-summary.md`, getText: () => summaryToMarkdown(meeting) }]}
                    />
                </div>
            )
        }
        if (tab === 'mom' && analysis?.mom) {
            return (
                <div className="wrapup-tools">
                    <SectionTools
                        label="minutes"
                        getText={() => analysis.mom}
                        downloads={[{ label: 'Markdown', filename: `${slug}-minutes.md`, getText: () => minutesToMarkdown(meeting) }]}
                    />
                </div>
            )
        }
        return null
    }

    const body = () => {
        if (loadError) {
            return <div className="wrapup-empty"><span className="empty-state-icon" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-text)' }}><AlertTriangle size={20} /></span><p>{loadError}</p></div>
        }
        if (!meeting) {
            return <div className="wrapup-empty"><Loader2 size={22} className="spin" /><p>Loading the meeting…</p></div>
        }

        // The transcript needs no model, so it stays readable while anything
        // else is generating or has failed.
        if (tab === 'transcript') return <TranscriptView entries={transcript} live={!!isLive} />

        if (transcript.length === 0) {
            return (
                <div className="wrapup-empty">
                    <span className="empty-state-icon" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-text)' }}><AlertTriangle size={20} /></span>
                    <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Nothing was transcribed</p>
                    <p>
                        There is no transcript for this meeting, so there is nothing to
                        write up. Check that microphone access was granted and that
                        speech-to-text was available during the call.
                    </p>
                </div>
            )
        }

        if (pending[tab]) {
            return (
                <div className="wrapup-empty">
                    <span className="empty-state-icon"><Loader2 size={20} className="spin" /></span>
                    <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Writing the {labelFor(tab)}…</p>
                    <p>
                        Reading {transcript.length} transcript {transcript.length === 1 ? 'entry' : 'entries'}.
                        This takes up to a minute on free models.
                    </p>
                </div>
            )
        }

        if (errors[tab] && !has(tab)) {
            return (
                <div className="wrapup-empty">
                    <span className="empty-state-icon" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-text)' }}><AlertTriangle size={20} /></span>
                    <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Could not write the {labelFor(tab)}</p>
                    <p>{errors[tab]}</p>
                    <button className="btn btn-secondary btn-sm" onClick={() => generate(tab as Generated)}>
                        Try again
                    </button>
                </div>
            )
        }

        if (tab === 'actions') return <ActionList actions={analysis?.next_actions ?? []} />

        const text = tab === 'summary' ? analysis?.summary : analysis?.mom
        if (!text) {
            return (
                <div className="wrapup-empty">
                    <span className="empty-state-icon"><Sparkles size={20} /></span>
                    <p>Nothing here yet.</p>
                    <button className="btn btn-primary btn-sm" onClick={() => generate(tab as Generated)}>
                        <Sparkles size={13} /> Write the {labelFor(tab)}
                    </button>
                </div>
            )
        }
        return <Markdown text={text} />
    }

    return (
        <div className="overlay" onClick={onClose}>
            <div className="wrapup" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Meeting insights">
                <div className="wrapup-header">
                    <div style={{ minWidth: 0 }}>
                        <div className="wrapup-eyebrow">
                            {isLive ? <><Radio size={11} /> Live now</> : 'Meeting insights'}
                        </div>
                        <div className="wrapup-title">{meeting?.title ?? 'Loading…'}</div>
                    </div>
                    <button className="btn btn-ghost btn-icon-sm" onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto' }}>
                        <X size={18} />
                    </button>
                </div>

                <div className="wrapup-tabs" role="tablist">
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            role="tab"
                            aria-selected={tab === t.key}
                            className={`wrapup-tab ${tab === t.key ? 'is-active' : ''}`}
                            onClick={() => setTab(t.key)}
                        >
                            {pending[t.key] ? <Loader2 size={13} className="spin" /> : t.icon}
                            {t.label}
                            {t.key === 'transcript' && transcript.length > 0 && (
                                <span className="wrapup-count">{transcript.length}</span>
                            )}
                            {t.key === 'actions' && (analysis?.next_actions?.length ?? 0) > 0 && (
                                <span className="wrapup-count">{analysis!.next_actions.length}</span>
                            )}
                        </button>
                    ))}
                </div>

                <div className="wrapup-body">{tools()}{body()}</div>

                <div className="wrapup-foot">
                    <span className="wrapup-note">Sections are written on demand, one model call each.</span>
                    <button className="btn btn-ghost" onClick={onClose}>Close</button>
                    <button
                        className="btn btn-primary"
                        onClick={() => navigate(`/meetings/${meetingId}/report`)}
                    >
                        <ExternalLink size={15} /> Full report
                    </button>
                </div>
            </div>
        </div>
    )
}
