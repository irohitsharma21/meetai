import { useEffect, useState } from 'react'
import { AlertTriangle, BarChart2, Loader2, MessageSquare, Scale, Tag } from 'lucide-react'
import { insightApi, errorMessage } from '../../lib/api'

interface SpeakerRow {
    speaker: string
    words: number
    turns: number
    questions: number
    fillers: number
    talk_seconds: number
    share: number
    words_per_turn: number
    longest_turn_words: number
}

interface Analytics {
    timing_reliable: boolean
    total_words: number
    total_entries: number
    estimated_speech_seconds: number
    balance_index: number
    dominant_speaker: string | null
    question_count: number
    interruption_count: number
    speakers: SpeakerRow[]
    keywords: { term: string; count: number }[]
}

const minutes = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`)

/** Describes the balance index in words, since 0.87 means nothing on its own. */
function balanceLabel(index: number, speakers: number): string {
    if (speakers < 2) return 'single speaker'
    if (index >= 0.9) return 'evenly shared'
    if (index >= 0.75) return 'mostly balanced'
    if (index >= 0.5) return 'somewhat one-sided'
    return 'dominated by one voice'
}

export function AnalyticsPanel({ meetingId }: { meetingId: string }) {
    const [data, setData] = useState<Analytics | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        insightApi
            .analytics(meetingId)
            .then((r) => { if (!cancelled) setData(r.data) })
            .catch((e) => {
                if (!cancelled) {
                    setError(errorMessage(e, 'Could not load analytics'))
                }
            })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [meetingId])

    if (loading) {
        return (
            <div className="panel">
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)}
                </div>
            </div>
        )
    }

    if (error || !data) {
        return (
            <div className="empty-state">
                <span className="empty-state-icon"><BarChart2 size={20} /></span>
                <div className="empty-title">No analytics available</div>
                <div className="empty-text">{error ?? 'This meeting has no transcript yet.'}</div>
            </div>
        )
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Headline numbers */}
            <div className="kpi-row">
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><MessageSquare size={15} /></span> Words</div>
                    <div className="kpi-value">{data.total_words.toLocaleString()}</div>
                    <div className="kpi-hint">{data.total_entries} utterances</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><BarChart2 size={15} /></span> Speech time</div>
                    <div className="kpi-value">{minutes(data.estimated_speech_seconds)}</div>
                    <div className="kpi-hint">estimated from word count</div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><Scale size={15} /></span> Balance</div>
                    <div className="kpi-value">{data.balance_index.toFixed(2)}</div>
                    <div className="kpi-hint">
                        {balanceLabel(data.balance_index, data.speakers.length)}
                    </div>
                </div>
                <div className="kpi">
                    <div className="kpi-label"><span className="kpi-icon"><MessageSquare size={15} /></span> Questions</div>
                    <div className="kpi-value">{data.question_count}</div>
                    <div className="kpi-hint">
                        {data.timing_reliable
                            ? `${data.interruption_count} interruptions`
                            : 'interruptions n/a'}
                    </div>
                </div>
            </div>

            {/* Share of voice */}
            <div className="panel">
                <div className="panel-head">
                    <span className="panel-title">Share of voice</span>
                    {data.dominant_speaker && (
                        <span className="text-xs muted">
                            Most active: {data.dominant_speaker}
                        </span>
                    )}
                </div>
                <div className="panel-body">
                    {data.speakers.map((s) => (
                        <div className="share-row" key={s.speaker}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.speaker}
                            </span>
                            <span className="share-track">
                                {/* Absolute share, not share-relative-to-the-loudest:
                                    normalising by the max made 53% and 47% render
                                    as near-identical bars. */}
                                <span
                                    className="share-fill"
                                    style={{ width: `${Math.max(s.share * 100, 1.5)}%` }}
                                />
                            </span>
                            <span className="share-pct">{(s.share * 100).toFixed(0)}%</span>
                        </div>
                    ))}

                    <div className="divider" style={{ margin: '0.875rem 0 0.625rem' }} />

                    <div className="table-scroll">
                        <table className="table" style={{ fontSize: '0.8125rem' }}>
                            <thead>
                                <tr>
                                    <th>Speaker</th>
                                    <th>Words</th>
                                    <th>Turns</th>
                                    <th>Words / turn</th>
                                    <th>Questions</th>
                                    <th>Fillers</th>
                                    <th>Longest turn</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.speakers.map((s) => (
                                    <tr key={s.speaker} style={{ cursor: 'default' }}>
                                        <td className="cell-title">{s.speaker}</td>
                                        <td className="cell-dim">{s.words}</td>
                                        <td className="cell-dim">{s.turns}</td>
                                        <td className="cell-dim">{s.words_per_turn}</td>
                                        <td className="cell-dim">{s.questions}</td>
                                        <td className="cell-dim">{s.fillers}</td>
                                        <td className="cell-dim">{s.longest_turn_words}w</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Topics */}
            {data.keywords.length > 0 && (
                <div className="panel">
                    <div className="panel-head">
                        <span className="panel-title"><Tag size={12} /> What was discussed</span>
                    </div>
                    <div className="panel-body">
                        <div className="chip-row">
                            {data.keywords.map((k) => (
                                <span className="chip" key={k.term}>
                                    {k.term}
                                    <span className="chip-count">{k.count}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {!data.timing_reliable && (
                <div className="notice-row" style={{ marginBottom: 0 }}>
                    <AlertTriangle size={14} color="var(--color-warning)" />
                    <span>
                        Interruption counts are suppressed for this meeting: the
                        transcript entries share near-identical timestamps, so a
                        speaker change cannot be distinguished from an overlap.
                    </span>
                </div>
            )}
        </div>
    )
}

export function AnalyticsLoading() {
    return <Loader2 size={14} className="spin" />
}
