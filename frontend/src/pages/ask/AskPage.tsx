import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    AlertTriangle, ArrowRight, Database, Loader2, RefreshCw, Search, Sparkles, CornerDownLeft,
} from 'lucide-react'
import { insightApi, errorMessage } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'
import { usePageTitle } from '../../components/common/usePageTitle'
import { initialsOf } from '../../components/common/Rail'

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

interface Turn {
    id: string
    query: string
    result: Answer | null
    error?: string
    loading: boolean
}

const EXAMPLES = [
    'What did we decide about the deadline?',
    'Who owns the migration?',
    'What were the concerns about cost?',
    'What did we agree to do next?',
]

function PassageCard({ p, onOpen }: { p: Passage; onOpen: () => void }) {
    return (
        <div
            className="passage"
            role="link"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
            aria-label={`Open report for ${p.meeting_title}`}
        >
            <div className="passage-head">
                <span className="passage-title">{p.meeting_title}</span>
                <span className="passage-meta">
                    {p.start_time} · {(p.score * 100).toFixed(0)}%
                    <ArrowRight size={12} aria-hidden="true" />
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
    )
}

export function AskPage() {
    usePageTitle('Ask your meetings')
    const { user } = useAuthStore()
    const [query, setQuery] = useState('')
    const [turns, setTurns] = useState<Turn[]>([])
    const [status, setStatus] = useState<SearchStatus | null>(null)
    const [indexing, setIndexing] = useState(false)
    const { addToast } = useToastStore()
    const navigate = useNavigate()
    const inputRef = useRef<HTMLInputElement>(null)
    const endRef = useRef<HTMLDivElement>(null)

    const loading = turns.some((t) => t.loading)

    const loadStatus = () =>
        insightApi.searchStatus().then((r) => setStatus(r.data)).catch(() => {})

    useEffect(() => {
        loadStatus()
        inputRef.current?.focus()
    }, [])

    useEffect(() => {
        if (turns.length) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [turns.length, loading])

    const run = async (q: string) => {
        const question = q.trim()
        if (!question || loading) return

        const id = Math.random().toString(36).slice(2)
        setQuery('')
        setTurns((t) => [...t, { id, query: question, result: null, loading: true }])
        try {
            const r = await insightApi.ask(question)
            setTurns((t) => t.map((x) => (x.id === id ? { ...x, result: r.data, loading: false } : x)))
        } catch (err: any) {
            const message = errorMessage(err, 'Could not reach the search service')
            setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: message, loading: false } : x)))
            addToast({
                type: 'error',
                title: 'Search failed',
                message,
            })
        } finally {
            inputRef.current?.focus()
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
                message: errorMessage(err, 'Admin access is required'),
            })
        } finally {
            setIndexing(false)
        }
    }

    const empty = useMemo(
        () => status?.enabled && (status.chunks_indexed ?? 0) === 0,
        [status],
    )

    const name = user?.display_name || user?.username || 'You'

    return (
        <div className="ask-layout">
            <div className="page-header" style={{ marginBottom: '0.5rem' }}>
                <div>
                    <h1>Ask your meetings</h1>
                    <div className="page-subtitle">
                        Answers cite the exact passage they came from.
                    </div>
                </div>
                <button className="btn" onClick={reindex} disabled={indexing} title="Embed every transcript again">
                    {indexing ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                    Rebuild index
                </button>
            </div>

            {empty && (
                <div className="notice-row" role="status">
                    <AlertTriangle size={16} color="var(--color-warning)" aria-hidden="true" />
                    <span>
                        Nothing is indexed yet. Choose <strong>Rebuild index</strong> to
                        embed the transcripts you already have.
                    </span>
                </div>
            )}

            <div className="ask-thread" aria-live="polite">
                {turns.length === 0 && (
                    <div className="ask-hero">
                        <span className="empty-state-icon" style={{ width: 56, height: 56 }}><Sparkles size={26} aria-hidden="true" /></span>
                        <h2>What would you like to know?</h2>
                        <p>Semantic search across every transcript you have access to. Try one of these, or ask in your own words.</p>
                        <div className="ask-examples">
                            {EXAMPLES.map((e) => (
                                <button key={e} className="chip" onClick={() => run(e)} type="button" style={{ cursor: 'pointer' }}>
                                    {e}
                                </button>
                            ))}
                        </div>
                        {status && (
                            <div className="ask-status">
                                <Database size={12} aria-hidden="true" />
                                {status.enabled
                                    ? `${status.chunks_indexed ?? 0} passages indexed · ${status.model ?? 'local embeddings'}${status.backend ? ` · ${status.backend}` : ''}`
                                    : 'Search is disabled on this server'}
                            </div>
                        )}
                    </div>
                )}

                {turns.map((t) => (
                    <div key={t.id}>
                        <div className="ask-turn">
                            <span className="ask-turn-avatar avatar" aria-hidden="true">{initialsOf(name)}</span>
                            <div className="ask-turn-body">
                                <div className="ask-turn-q">{t.query}</div>
                            </div>
                        </div>

                        <div className="ask-turn" style={{ marginTop: '0.875rem' }}>
                            <span className="ask-turn-avatar" data-who="ai" aria-hidden="true"><Sparkles size={16} /></span>
                            <div className="ask-turn-body">
                                {t.loading && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.375rem' }} aria-busy="true">
                                        <div className="skeleton skeleton-text" style={{ width: '85%' }} />
                                        <div className="skeleton skeleton-text" style={{ width: '70%' }} />
                                        <div className="skeleton skeleton-text" style={{ width: '40%' }} />
                                    </div>
                                )}

                                {t.error && !t.loading && (
                                    <div className="ask-turn-a" style={{ color: 'var(--color-danger-text)' }}>{t.error}</div>
                                )}

                                {t.result && !t.loading && (
                                    <>
                                        <div className="ask-turn-a">
                                            {t.result.answer
                                                ? t.result.answer.split('\n').filter(Boolean).map((line, i) => <p key={i}>{line}</p>)
                                                : <p className="muted">No transcript passage matched that closely enough to answer.</p>}
                                        </div>
                                        <div className="ask-turn-meta">
                                            {t.result.grounded && <span className="badge badge-green" style={{ textTransform: 'none' }}>Grounded in transcripts</span>}
                                            {t.result.note && (
                                                <span className="badge badge-amber badge-plain" title={t.result.note}>
                                                    <AlertTriangle size={12} aria-hidden="true" /> {t.result.note}
                                                </span>
                                            )}
                                        </div>

                                        {t.result.passages.length > 0 && (
                                            <div className="ask-sources">
                                                <div className="ask-sources-label">
                                                    Sources · {t.result.passages.length} passage{t.result.passages.length === 1 ? '' : 's'}
                                                </div>
                                                <div className="ask-cites">
                                                    {t.result.passages.map((p, i) => (
                                                        <PassageCard key={i} p={p} onOpen={() => navigate(`/meetings/${p.meeting_id}/report`)} />
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                <div ref={endRef} />
            </div>

            <form
                className="ask-composer"
                onSubmit={(e) => { e.preventDefault(); run(query) }}
            >
                <Search size={18} aria-hidden="true" />
                <input
                    ref={inputRef}
                    className="input"
                    placeholder="Ask about any meeting…"
                    aria-label="Ask a question about your meetings"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={loading}
                />
                <button
                    type="submit"
                    className="btn btn-primary btn-icon"
                    disabled={loading || !query.trim()}
                    aria-label="Ask"
                    title="Ask (Enter)"
                >
                    {loading ? <Loader2 size={16} className="spin" /> : <CornerDownLeft size={16} />}
                </button>
            </form>
        </div>
    )
}
