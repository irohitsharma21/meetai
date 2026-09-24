import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
    Check, ChevronDown, Copy, File, FileCode2, FileText, Lightbulb, Pin, PinOff,
    Presentation, X,
} from 'lucide-react'
import { onWsMessage } from '../../lib/wsBus'
import { useBriefingStore } from './store'
import type { BriefingDocKind, Cue } from './types'
import './briefing.css'

/** How long an unpinned cue stays up. Paused while hovered or focused. */
const AUTO_DISMISS_MS = 20_000
const MAX_VISIBLE = 3

// ── Shared bits (also used by BriefingPanel) ───────────────────────────

export function DocKindIcon({ kind, size = 16 }: { kind: BriefingDocKind | string; size?: number }) {
    switch (kind) {
        case 'pptx': return <Presentation size={size} aria-hidden="true" />
        case 'pdf':
        case 'docx': return <FileText size={size} aria-hidden="true" />
        case 'md':
        case 'txt': return <FileCode2 size={size} aria-hidden="true" />
        default: return <File size={size} aria-hidden="true" />
    }
}

function kindFromName(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function CueSourceChip({ cue }: { cue: Cue }) {
    const name = cue.source?.doc_name || 'Your document'
    const loc = cue.source?.locator
    return (
        <span className="brf-source" title={loc ? `${name} · ${loc}` : name}>
            <DocKindIcon kind={kindFromName(name)} size={12} />
            <span className="brf-source-name">{name}</span>
            {loc && <span className="brf-source-loc">· {loc}</span>}
        </span>
    )
}

export function cueTriggerLine(cue: Cue): string {
    if (!cue.trigger) return 'From your docs'
    const who = cue.trigger.speaker?.trim() || 'Someone'
    return `${who} asked`
}

export function cueClipboardText(cue: Cue): string {
    const parts = [cue.headline, cue.detail].filter((p) => p && p.trim())
    const loc = [cue.source?.doc_name, cue.source?.locator].filter(Boolean).join(', ')
    return loc ? `${parts.join(' - ')} (${loc})` : parts.join(' - ')
}

/** Copy with a fallback for insecure origins, where navigator.clipboard is absent. */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
    } catch {
        return false
    }
}

export function useCopy(): [boolean, (text: string) => void] {
    const [copied, setCopied] = useState(false)
    const timer = useRef<number>()
    useEffect(() => () => window.clearTimeout(timer.current), [])
    const copy = useCallback((text: string) => {
        void copyText(text).then((ok) => {
            if (!ok) return
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1600)
        })
    }, [])
    return [copied, copy]
}

function isCue(v: any): v is Cue {
    return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.headline === 'string'
}

// ── Card ───────────────────────────────────────────────────────────────

interface CardState {
    cue: Cue
    pinned: boolean
}

interface CueCardProps {
    item: CardState
    onDismiss: (id: string) => void
    onTogglePin: (id: string) => void
    reduceMotion: boolean
}

function CueCard({ item, onDismiss, onTogglePin, reduceMotion }: CueCardProps) {
    const { cue, pinned } = item
    const [expanded, setExpanded] = useState(false)
    const [copied, copy] = useCopy()
    const hasQuote = !!cue.quote?.trim()

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.stopPropagation()
            onDismiss(cue.id)
        }
    }

    return (
        <motion.div
            layout={!reduceMotion}
            className={`brf-card${pinned ? ' is-pinned' : ''}`}
            role="group"
            aria-label={`Cue: ${cue.headline}`}
            onKeyDown={onKeyDown}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16, transition: { duration: 0.16 } }}
            transition={{ duration: reduceMotion ? 0.12 : 0.26, ease: [0.16, 1, 0.3, 1] }}
        >
            <div className="brf-card-top">
                <span className="brf-card-glyph" aria-hidden="true"><Lightbulb size={13} /></span>
                <div className="brf-card-trigger">
                    <span className="brf-card-who">{cueTriggerLine(cue)}</span>
                    {cue.trigger?.text && (
                        <span className="brf-card-said" title={cue.trigger.text}>
                            “{cue.trigger.text}”
                        </span>
                    )}
                </div>
                <div className="brf-card-actions">
                    <button
                        type="button"
                        className={`brf-mini-btn${pinned ? ' is-on' : ''}`}
                        onClick={() => onTogglePin(cue.id)}
                        aria-pressed={pinned}
                        aria-label={pinned ? 'Unpin cue' : 'Pin cue'}
                        title={pinned ? 'Unpin (auto-hide again)' : 'Pin (keep on screen)'}
                    >
                        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    </button>
                    <button
                        type="button"
                        className="brf-mini-btn"
                        onClick={() => copy(cueClipboardText(cue))}
                        aria-label={copied ? 'Copied' : 'Copy cue'}
                        title={copied ? 'Copied' : 'Copy'}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <button
                        type="button"
                        className="brf-mini-btn"
                        onClick={() => onDismiss(cue.id)}
                        aria-label="Dismiss cue"
                        title="Dismiss"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            <div className="brf-card-headline">{cue.headline}</div>
            {cue.detail && cue.detail.trim() && cue.detail.trim() !== cue.headline.trim() && (
                <p className="brf-card-detail">{cue.detail}</p>
            )}

            <div className="brf-card-foot">
                <CueSourceChip cue={cue} />
                {hasQuote && (
                    <button
                        type="button"
                        className="brf-link-btn"
                        onClick={() => setExpanded((v) => !v)}
                        aria-expanded={expanded}
                    >
                        {expanded ? 'Hide quote' : 'Quote'}
                        <ChevronDown size={13} className={`brf-chev${expanded ? ' is-open' : ''}`} aria-hidden="true" />
                    </button>
                )}
            </div>

            {hasQuote && expanded && (
                <blockquote className="brf-quote">{cue.quote}</blockquote>
            )}

            {!pinned && (
                <div className="brf-card-timer" aria-hidden="true">
                    <span
                        className="brf-card-timer-fill"
                        style={{ animationDuration: `${AUTO_DISMISS_MS}ms` }}
                        // The countdown is this CSS animation: it pauses on
                        // hover/focus in CSS, and when it ends the card goes.
                        onAnimationEnd={() => onDismiss(cue.id)}
                    />
                </div>
            )}
        </motion.div>
    )
}

// ── Overlay ────────────────────────────────────────────────────────────

export interface CueOverlayProps {
    meetingId: string
}

/**
 * Private cue cards, bottom-left of the stage. Mount inside the
 * position:relative stage container; it positions itself absolutely.
 */
export function CueOverlay({ meetingId }: CueOverlayProps) {
    const load = useBriefingStore((s) => s.load)
    const addCue = useBriefingStore((s) => s.addCue)
    const [cards, setCards] = useState<CardState[]>([])
    const reduceMotion = !!useReducedMotion()

    useEffect(() => {
        void load(meetingId)
    }, [load, meetingId])

    useEffect(() => {
        setCards([])
        return onWsMessage('cue', (msg) => {
            const cue = msg?.cue
            if (!isCue(cue)) return
            if (cue.meeting_id && cue.meeting_id !== meetingId) return
            addCue(cue)
            setCards((prev) => {
                if (prev.some((c) => c.cue.id === cue.id)) return prev
                const next = [{ cue, pinned: false }, ...prev]
                if (next.length <= MAX_VISIBLE) return next
                // Over the limit: drop the oldest unpinned card (it stays in history).
                const dropAt = next.map((c) => c.pinned).lastIndexOf(false)
                const idx = dropAt > 0 ? dropAt : next.length - 1
                return next.filter((_, i) => i !== idx)
            })
        })
    }, [meetingId, addCue])

    const dismiss = useCallback((id: string) => {
        setCards((prev) => prev.filter((c) => c.cue.id !== id))
    }, [])
    const togglePin = useCallback((id: string) => {
        setCards((prev) => prev.map((c) => (c.cue.id === id ? { ...c, pinned: !c.pinned } : c)))
    }, [])

    return (
        <div className="brf-overlay" role="region" aria-label="Briefing cues" aria-live="polite">
            <AnimatePresence initial={false}>
                {cards.map((item) => (
                    <CueCard
                        key={item.cue.id}
                        item={item}
                        onDismiss={dismiss}
                        onTogglePin={togglePin}
                        reduceMotion={reduceMotion}
                    />
                ))}
            </AnimatePresence>
        </div>
    )
}
