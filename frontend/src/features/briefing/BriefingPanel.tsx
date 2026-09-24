import { useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
    Check, ChevronDown, CircleAlert, CloudUpload, Copy, EyeOff, History, Info,
    LoaderCircle, NotebookPen, RotateCw, Search, Trash2, X,
} from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import { ACCEPT_ATTR, briefingApi } from './api'
import { useBriefingStore, useBriefingUploader } from './store'
import { CueSourceChip, DocKindIcon, cueClipboardText, cueTriggerLine, useCopy } from './CueOverlay'
import type { BriefingDoc, BriefingSensitivity, Cue, UploadItem } from './types'
import './briefing.css'

export interface BriefingPanelProps {
    meetingId: string
    onClose: () => void
}

const SENSITIVITY: { value: BriefingSensitivity; label: string; hint: string }[] = [
    { value: 'low', label: 'Fewer', hint: 'Only confident matches' },
    { value: 'medium', label: 'Balanced', hint: 'A good default' },
    { value: 'high', label: 'More', hint: 'Looser matches, more cues' },
]

// ── Formatting ─────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`
}

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 KB'
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function docMeta(doc: BriefingDoc): string {
    const parts: string[] = []
    if (doc.pages > 0) {
        if (doc.kind === 'pptx') parts.push(plural(doc.pages, 'slide'))
        else if (doc.kind === 'pdf' || doc.kind === 'docx') parts.push(plural(doc.pages, 'page'))
    }
    parts.push(plural(doc.chunks ?? 0, 'passage'))
    return parts.join(' · ')
}

function timeOf(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// ── Upload zone (drag & drop + click) ──────────────────────────────────

function UploadZone({ meetingId }: { meetingId: string }) {
    const { uploads, upload, dismissUpload, busy } = useBriefingUploader(meetingId)
    const inputRef = useRef<HTMLInputElement>(null)
    const [over, setOver] = useState(false)
    const depth = useRef(0)

    const pick = () => inputRef.current?.click()

    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files)
    }

    return (
        <>
            <div
                className={`brf-drop${over ? ' is-over' : ''}`}
                role="button"
                tabIndex={0}
                aria-label="Upload documents: drop files here or press to browse"
                onClick={pick}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pick()
                    }
                }}
                onDragEnter={(e) => {
                    e.preventDefault()
                    depth.current += 1
                    setOver(true)
                }}
                onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                }}
                onDragLeave={() => {
                    depth.current = Math.max(0, depth.current - 1)
                    if (depth.current === 0) setOver(false)
                }}
                onDrop={onDrop}
            >
                <span className="brf-drop-icon" aria-hidden="true">
                    {busy ? <LoaderCircle size={18} className="spin" /> : <CloudUpload size={18} />}
                </span>
                <span className="brf-drop-title">
                    {over ? 'Drop to upload' : <>Drop files or <u>browse</u></>}
                </span>
                <span className="brf-drop-hint">PDF, PPTX, DOCX, TXT, MD · up to 10 MB</span>
                <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPT_ATTR}
                    multiple
                    hidden
                    onChange={(e) => {
                        if (e.target.files?.length) void upload(e.target.files)
                        e.target.value = ''
                    }}
                />
            </div>
            {uploads.length > 0 && (
                <ul className="brf-uploads">
                    {uploads.map((u) => (
                        <UploadRow key={u.key} item={u} onDismiss={() => dismissUpload(u.key)} />
                    ))}
                </ul>
            )}
        </>
    )
}

export function UploadRow({ item, onDismiss }: { item: UploadItem; onDismiss: () => void }) {
    const pct = Math.round(item.progress * 100)
    const isError = item.status === 'error'
    // Bytes done does not mean done: the server still extracts and indexes.
    const label = isError
        ? item.error
        : item.status === 'queued'
            ? 'Waiting…'
            : pct >= 100 ? 'Reading document…' : `Uploading · ${pct}%`
    return (
        <li className={`brf-upload${isError ? ' is-error' : ''}`}>
            <span className="brf-upload-icon" aria-hidden="true">
                {isError ? <CircleAlert size={15} /> : <LoaderCircle size={15} className="spin" />}
            </span>
            <div className="brf-upload-main">
                <span className="brf-upload-name" title={item.name}>{item.name}</span>
                <span className="brf-upload-status" role={isError ? 'alert' : undefined}>{label}</span>
                {!isError && (
                    <span className="brf-progress" aria-hidden="true">
                        <span
                            className={`brf-progress-fill${pct >= 100 ? ' is-indeterminate' : ''}`}
                            style={{ width: `${Math.max(4, pct)}%` }}
                        />
                    </span>
                )}
            </div>
            {isError && (
                <button type="button" className="room-icon-btn brf-icon-sm" onClick={onDismiss} aria-label={`Dismiss error for ${item.name}`}>
                    <X size={14} />
                </button>
            )}
        </li>
    )
}

// ── Doc row ────────────────────────────────────────────────────────────

function DocRow({ doc, meetingId }: { doc: BriefingDoc; meetingId: string }) {
    const removeDoc = useBriefingStore((s) => s.removeDoc)
    const addToast = useToastStore((s) => s.addToast)
    const [confirming, setConfirming] = useState(false)
    const [busy, setBusy] = useState(false)

    const remove = async () => {
        setBusy(true)
        try {
            await removeDoc(meetingId, doc.id)
        } catch (err) {
            addToast({ type: 'error', title: 'Could not remove document', message: errorMessage(err) })
            setBusy(false)
            setConfirming(false)
        }
    }

    return (
        <li className="brf-doc">
            <span className={`brf-doc-icon is-${doc.kind}`}><DocKindIcon kind={doc.kind} size={16} /></span>
            {confirming ? (
                <div className="brf-doc-confirm">
                    <span>Remove <strong title={doc.name}>{doc.name}</strong>?</span>
                    <div className="brf-doc-confirm-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={busy} autoFocus>
                            {busy ? <LoaderCircle size={14} className="spin" /> : 'Remove'}
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="brf-doc-main">
                        <span className="brf-doc-name" title={doc.name}>{doc.name}</span>
                        <span className="brf-doc-meta">{docMeta(doc)} · {formatBytes(doc.size)}</span>
                    </div>
                    <button
                        type="button"
                        className="room-icon-btn brf-doc-del"
                        onClick={() => setConfirming(true)}
                        aria-label={`Remove ${doc.name}`}
                        title="Remove"
                    >
                        <Trash2 size={15} />
                    </button>
                </>
            )}
        </li>
    )
}

// ── Cue (inline, compact) ──────────────────────────────────────────────

function CueItem({ cue, defaultOpen = false }: { cue: Cue; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen)
    const [copied, copy] = useCopy()
    const hasQuote = !!cue.quote?.trim()
    return (
        <div className="brf-cue">
            <div className="brf-cue-top">
                <span className="brf-cue-who">
                    {cueTriggerLine(cue)}
                    {cue.trigger?.text && <span className="brf-cue-said" title={cue.trigger.text}> “{cue.trigger.text}”</span>}
                </span>
                <time className="brf-cue-time" dateTime={cue.created_at}>{timeOf(cue.created_at)}</time>
            </div>
            <div className="brf-cue-headline">{cue.headline}</div>
            {cue.detail && cue.detail.trim() !== cue.headline.trim() && (
                <p className="brf-cue-detail">{cue.detail}</p>
            )}
            <div className="brf-card-foot">
                <CueSourceChip cue={cue} />
                <div className="brf-cue-actions">
                    {hasQuote && (
                        <button type="button" className="brf-link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                            {open ? 'Hide quote' : 'Quote'}
                            <ChevronDown size={13} className={`brf-chev${open ? ' is-open' : ''}`} aria-hidden="true" />
                        </button>
                    )}
                    <button
                        type="button"
                        className="brf-mini-btn"
                        onClick={() => copy(cueClipboardText(cue))}
                        aria-label={copied ? 'Copied' : 'Copy cue'}
                        title={copied ? 'Copied' : 'Copy'}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                </div>
            </div>
            {hasQuote && open && <blockquote className="brf-quote">{cue.quote}</blockquote>}
        </div>
    )
}

// ── Ask your docs ──────────────────────────────────────────────────────

function AskBox({ meetingId, disabled }: { meetingId: string; disabled: boolean }) {
    const [q, setQ] = useState('')
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState<{ cue: Cue | null; reason: string | null; error?: string } | null>(null)

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        const question = q.trim()
        if (!question || busy) return
        setBusy(true)
        setResult(null)
        try {
            const res = await briefingApi.ask(meetingId, question)
            setResult({ cue: res?.cue ?? null, reason: res?.reason ?? null })
        } catch (err) {
            setResult({ cue: null, reason: null, error: errorMessage(err, 'Could not search your documents.') })
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="brf-ask">
            <form className="brf-ask-box" onSubmit={submit}>
                <Search size={15} className="brf-ask-glyph" aria-hidden="true" />
                <input
                    className="brf-ask-input"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={disabled ? 'Upload a document first' : 'e.g. What is the TTS latency?'}
                    aria-label="Ask your documents"
                    disabled={disabled}
                    maxLength={500}
                />
                <button type="submit" className="btn btn-primary btn-sm brf-ask-go" disabled={disabled || busy || !q.trim()}>
                    {busy ? <LoaderCircle size={14} className="spin" /> : 'Ask'}
                </button>
            </form>
            <div aria-live="polite">
                {result?.cue && <CueItem cue={result.cue} defaultOpen />}
                {result && !result.cue && (
                    <p className={`brf-ask-miss${result.error ? ' is-error' : ''}`}>
                        {result.error ? <CircleAlert size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
                        <span>{result.error || result.reason || 'Nothing in your documents answers that.'}</span>
                    </p>
                )}
            </div>
        </div>
    )
}

// ── Panel ──────────────────────────────────────────────────────────────

/**
 * Side-panel content for Briefing. Renders its own head and body; mount it
 * inside `<div className="room-panel-col">`.
 */
export function BriefingPanel({ meetingId, onClose }: BriefingPanelProps) {
    const load = useBriefingStore((s) => s.load)
    const mine = useBriefingStore((s) => s.meetingId === meetingId)
    const docs = useBriefingStore((s) => s.docs)
    const settings = useBriefingStore((s) => s.settings)
    const available = useBriefingStore((s) => s.available)
    const loaded = useBriefingStore((s) => s.loaded)
    const loading = useBriefingStore((s) => s.loading)
    const loadError = useBriefingStore((s) => s.loadError)
    const history = useBriefingStore((s) => s.history)
    const updateSettings = useBriefingStore((s) => s.updateSettings)
    const addToast = useToastStore((s) => s.addToast)

    useEffect(() => {
        void load(meetingId)
    }, [load, meetingId])

    const setSetting = (partial: Parameters<typeof updateSettings>[1]) => {
        updateSettings(meetingId, partial).catch((err) =>
            addToast({ type: 'error', title: 'Could not save setting', message: errorMessage(err) }),
        )
    }

    const ready = mine && loaded
    const hasDocs = ready && docs.length > 0

    return (
        <div className="room-panel-col brf-panel">
            <div className="room-panel-head">
                <NotebookPen size={15} />
                <span>Briefing</span>
                <button type="button" className="room-icon-btn" onClick={onClose} aria-label="Close briefing">
                    <X size={16} />
                </button>
            </div>

            <div className="brf-body">
                <p className="brf-explainer">
                    <EyeOff size={14} aria-hidden="true" />
                    <span>
                        Upload your notes or deck. When someone asks something they answer,
                        you get a cue with the fact to say. <strong>Only you see these cues.</strong>
                    </span>
                </p>

                {ready && !available.llm && (
                    <p className="brf-note">
                        <Info size={14} aria-hidden="true" />
                        <span>Cues will quote your document directly (no AI configured).</span>
                    </p>
                )}

                {mine && loadError && (
                    <p className="brf-note is-error">
                        <CircleAlert size={14} aria-hidden="true" />
                        <span>{loadError}</span>
                        <button type="button" className="brf-link-btn" onClick={() => void load(meetingId, true)}>
                            <RotateCw size={12} aria-hidden="true" /> Retry
                        </button>
                    </p>
                )}

                {/* Documents */}
                <section className="brf-section" aria-labelledby="brf-docs-h">
                    <h3 className="brf-section-title" id="brf-docs-h">
                        Your documents
                        {hasDocs && <span className="brf-count">{docs.length}</span>}
                    </h3>
                    <UploadZone meetingId={meetingId} />
                    {loading && !loaded && (
                        <div className="brf-skeleton" aria-hidden="true"><span /><span /></div>
                    )}
                    {hasDocs && (
                        <ul className="brf-docs">
                            {docs.map((d) => <DocRow key={d.id} doc={d} meetingId={meetingId} />)}
                        </ul>
                    )}
                </section>

                {/* Settings */}
                <section className="brf-section" aria-labelledby="brf-live-h">
                    <h3 className="brf-section-title" id="brf-live-h">Live cues</h3>
                    <label className="brf-setting">
                        <span className="brf-setting-text">
                            <span>Prompt me during the call</span>
                            <span className="brf-setting-hint">
                                {settings.enabled ? 'Listening for questions your docs can answer' : 'Paused. You can still ask below.'}
                            </span>
                        </span>
                        <span className="pnl-switch">
                            <input
                                type="checkbox"
                                checked={settings.enabled}
                                disabled={!ready}
                                onChange={(e) => setSetting({ enabled: e.target.checked })}
                            />
                            <span className="pnl-switch-track" aria-hidden="true" />
                        </span>
                    </label>
                    <div className="brf-setting brf-setting-col">
                        <span className="brf-setting-text" id="brf-sens-l">
                            <span>How often</span>
                            <span className="brf-setting-hint">
                                {SENSITIVITY.find((s) => s.value === settings.sensitivity)?.hint}
                            </span>
                        </span>
                        <div className="segmented brf-segmented" role="group" aria-labelledby="brf-sens-l">
                            {SENSITIVITY.map((s) => (
                                <button
                                    key={s.value}
                                    type="button"
                                    className="segment"
                                    aria-pressed={settings.sensitivity === s.value}
                                    disabled={!ready || !settings.enabled}
                                    onClick={() => settings.sensitivity !== s.value && setSetting({ sensitivity: s.value })}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </section>

                {/* Ask */}
                <section className="brf-section" aria-labelledby="brf-ask-h">
                    <h3 className="brf-section-title" id="brf-ask-h">Ask your docs</h3>
                    <AskBox meetingId={meetingId} disabled={!hasDocs} />
                </section>

                {/* History */}
                <section className="brf-section" aria-labelledby="brf-hist-h">
                    <h3 className="brf-section-title" id="brf-hist-h">
                        <History size={12} aria-hidden="true" /> Cues this meeting
                        {mine && history.length > 0 && <span className="brf-count">{history.length}</span>}
                    </h3>
                    {mine && history.length > 0 ? (
                        <div className="brf-history">
                            {history.map((c) => <CueItem key={c.id} cue={c} />)}
                        </div>
                    ) : (
                        <p className="brf-empty">
                            {hasDocs
                                ? 'No cues yet. They appear here too, so a dismissed one is never lost.'
                                : 'Cues you receive will be listed here.'}
                        </p>
                    )}
                </section>
            </div>
        </div>
    )
}
