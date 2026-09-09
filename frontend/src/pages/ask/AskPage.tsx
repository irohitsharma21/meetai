import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    AlertTriangle, ArrowRight, Database, Loader2, RefreshCw, Search, Sparkles,
} from 'lucide-react'
import { insightApi } from '../../lib/api'
import { useToastStore } from '../../store'

interface Passage {
    meeting_id: string
    meeting_title: string
    text: string
    speakers: string[]
    start_time: string
    score: number
}

interface Answer {
    query: string
    answer: string | null
    passages: Passage[]
    grounded: boolean
    note?: string
}

interface SearchStatus {
    enabled: boolean
    ready?: boolean
    model?: string
    dimensions?: number
    chunks_indexed?: number
    backend?: string
    error?: string
}

const EXAMPLES = [
    'What did we decide about the deadline?',
    'Who owns the migration?',
    'What were the concerns about cost?',
    'What did we agree to do next?',
]

export function AskPage() {
    const [query, setQuery] = useState('')
    const [result, setResult] = useState<Answer | null>(null)
    const [loading, setLoading] = useState(false)
    const [status, setStatus] = useState<SearchStatus | null>(null)
    const [indexing, setIndexing] = useState(false)
    const { addToast } = useToastStore()
    const navigate = useNavigate()
    const inputRef = useRef<HTMLInputElement>(null)

    const loadStatus = () =>
        insightApi.searchStatus().then((r) => setStatus(r.data)).catch(() => {})

    useEffect(() => {
        loadStatus()
        inputRef.current?.focus()
    }, [])

    const run = async (q: string) => {
        const question = q.trim()
        if (!question || loading) return

        setQuery(question)
        setLoading(true)
        setResult(null)
        try {
            const r = await insightApi.ask(question)
            setResult(r.data)
        } catch (err: any) {
            addToast({
                type: 'error',
                title: 'Search failed',
                message: err?.response?.data?.detail ?? 'Could not reach the search service',
            })
        } finally {
            setLoading(false)
        }
    }

    const reindex = async () => {
        setIndexing(true)
        try {
            const r = await insightApi.reindexAll()
            addToast({
                type: 'success',
                title: 'Index rebuilt',
                message: `${r.data.chunks_indexed} passages across ${r.data.meetings_indexed} meetings`,
            })
            loadStatus()
        } catch (err: any) {
            addToast({
                type: 'error',
                title: 'Reindex failed',
                message: err?.response?.data?.detail ?? 'Admin access is required',
            })
        } finally {
            setIndexing(false)
        }
    }

    const empty = useMemo(
        () => status?.enabled && (status.chunks_indexed ?? 0) === 0,
        [status],
    )

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>Ask your meetings</h1>
                    <div className="page-subtitle">
                        Semantic search across every transcript. Answers cite the
                        moment they came from.
                    </div>
                </div>
                <button className="btn btn-secondary" onClick={reindex} disabled={indexing}>
                    {indexing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                    Rebuild index
                </button>
            </div>

            {/* Search box */}
            <form
                onSubmit={(e) => { e.preventDefault(); run(query) }}
                style={{ marginBottom: '1rem' }}
            >
                <div className="search-bar" style={{ maxWidth: 'none' }}>
                    <Search size={16} />
                    <input
                        ref={inputRef}
                        className="input"
                        style={{ paddingRight: '6.5rem', height: 42, fontSize: '0.9375rem' }}
                        placeholder="When did we agree the migration deadline?"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <button
                        type="submit"
                        className="btn btn-primary btn-sm"
                        disabled={loading || !query.trim()}
                        style={{ position: 'absolute', right: 6, top: 6 }}
                    >
                        {loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                        Ask
                    </button>
                </div>
            </form>

            {/* Examples */}
            {!result && !loading && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4375rem', marginBottom: '1.25rem' }}>
                    {EXAMPLES.map((e) => (
                        <button key={e} className="btn btn-sm btn-secondary" onClick={() => run(e)}>
                            {e}
                        </button>
                    ))}
                </div>
            )}

            {/* Index status */}
            {status && (
                <div className="panel" style={{ marginBottom: '1rem' }}>
                    <div className="panel-head">
                        <span className="panel-title"><Database size={12} /> Index</span>
                        <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                            {status.enabled
                                ? `${status.model ?? '—'} · ${status.dimensions ?? '—'}d · ${status.backend ?? ''}`
                                : 'disabled'}
                        </span>
                    </div>
                    <div className="panel-body" style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                        <Stat label="Passages indexed" value={String(status.chunks_indexed ?? 0)} />
                        <Stat label="Embeddings" value={status.enabled ? 'local (no API key)' : 'off'} />
                        <Stat label="Vector store" value={status.backend === 'qdrant-embedded' ? 'Qdrant (embedded)' : status.backend ?? '—'} />
                    </div>
                </div>
            )}

            {empty && (
                <div className="notice-row">
                    <AlertTriangle size={14} color="var(--color-warning)" />
                    <span>
                        Nothing is indexed yet. Hit <strong>Rebuild index</strong> to
                        embed the transcripts you already have.
                    </span>
                </div>
            )}

            {loading && (
                <div className="table-wrap" style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 56 }} />)}
                </div>
            )}

            {/* Answer */}
            {result && !loading && (
                <>
                    {result.answer && (
                        <div className="panel" style={{ marginBottom: '1rem' }}>
                            <div className="panel-head">
                                <span className="panel-title"><Sparkles size={12} /> Answer</span>
                                {result.grounded && (
                                    <span className="badge badge-purple">grounded</span>
                                )}
                            </div>
                            <div className="panel-body">
                                <p style={{ fontSize: '0.9375rem', lineHeight: 1.65 }}>
                                    {result.answer}
                                </p>
                            </div>
                        </div>
                    )}

                    {result.note && (
                        <div className="notice-row" style={{ marginBottom: '1rem' }}>
                            <AlertTriangle size={14} color="var(--color-warning)" />
                            <span>{result.note}</span>
                        </div>
                    )}

                    <div className="panel">
                        <div className="panel-head">
                            <span className="panel-title">
                                Sources · {result.passages.length} passage{result.passages.length === 1 ? '' : 's'}
                            </span>
                        </div>
                        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                            {result.passages.length === 0 && (
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                    No transcript passage matched that closely enough.
                                </div>
                            )}
                            {result.passages.map((p, i) => (
                                <div key={i} className="passage" onClick={() => navigate(`/meetings/${p.meeting_id}/report`)}>
                                    <div className="passage-head">
                                        <span className="passage-title">{p.meeting_title}</span>
                                        <span className="passage-meta">
                                            {p.start_time} · {(p.score * 100).toFixed(0)}% match
                                            <ArrowRight size={12} style={{ marginLeft: 6, verticalAlign: -2 }} />
                                        </span>
                                    </div>
                                    <div className="passage-body">
                                        {p.text.split('\n').map((line, k) => {
                                            const idx = line.indexOf(':')
                                            const who = idx > 0 ? line.slice(0, idx) : ''
                                            const said = idx > 0 ? line.slice(idx + 1) : line
                                            return (
                                                <div key={k} style={{ marginBottom: 3 }}>
                                                    {who && <span className="passage-speaker">{who}</span>}
                                                    <span>{said}</span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </>
    )
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="kpi-label" style={{ marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: '0.875rem', fontWeight: 500 }}>{value}</div>
        </div>
    )
}
