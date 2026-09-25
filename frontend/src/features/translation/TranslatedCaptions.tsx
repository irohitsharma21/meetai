import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Languages } from 'lucide-react'
import { useMeetingRoomStore } from '../../store'
import { useTranslationStore } from './store'
import type { TranslationItem } from './types'
import './translation.css'

const TTL_MS = 9000
const MAX_LINES = 2
/** Matches `.cc-layer { bottom: 96px }` in panels.css (84px on phones). */
const CC_BOTTOM = 96
const CC_BOTTOM_COMPACT = 84
const GAP = 8

/**
 * Translated subtitles, bottom-centre of the stage. When the ordinary
 * captions are on as well, this layer measures them and sits just above,
 * so the two never overlap.
 */
export function TranslatedCaptions() {
    const enabled = useTranslationStore((s) => !!s.prefs?.enabled)
    const feed = useTranslationStore((s) => s.feed)
    const hint = useTranslationStore((s) => s.voiceHint)
    const setHint = useTranslationStore((s) => s.setVoiceHint)
    const captionsOn = useMeetingRoomStore((s) => s.captionsOn)

    const [showOriginal, setShowOriginal] = useState(false)
    const [visible, setVisible] = useState<TranslationItem[]>([])
    const arrived = useRef(new Map<string, number>())
    const seeded = useRef(false)
    const layerRef = useRef<HTMLDivElement>(null)
    const [ccHeight, setCcHeight] = useState(0)

    // Arrival-time TTL, as in CaptionsOverlay; the feed is newest-first.
    useEffect(() => {
        const now = Date.now()
        for (const it of feed) {
            if (!arrived.current.has(it.id)) arrived.current.set(it.id, seeded.current ? now : 0)
        }
        seeded.current = true
        let timer: number | undefined
        const recompute = () => {
            const t = Date.now()
            const live = feed.filter((it) => (arrived.current.get(it.id) ?? 0) + TTL_MS > t)
            const shown = live.slice(0, MAX_LINES).reverse()
            setVisible((prev) =>
                prev.length === shown.length && prev.every((p, i) => p.id === shown[i].id) ? prev : shown,
            )
            if (live.length) {
                const next = Math.min(...live.map((it) => (arrived.current.get(it.id) ?? 0) + TTL_MS))
                timer = window.setTimeout(recompute, Math.max(50, next - t + 20))
            }
        }
        recompute()
        return () => window.clearTimeout(timer)
    }, [feed])

    // Sit above the ordinary captions when they are showing.
    useLayoutEffect(() => {
        setCcHeight(0)
        if (!captionsOn) return
        const cc = layerRef.current?.parentElement?.querySelector<HTMLElement>('.cc-layer')
        if (!cc || typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(() => setCcHeight(cc.offsetHeight))
        ro.observe(cc)
        setCcHeight(cc.offsetHeight)
        return () => ro.disconnect()
    }, [captionsOn])

    // Hints auto-clear after a while so they don't linger all call.
    useEffect(() => {
        if (!hint) return
        const t = window.setTimeout(() => setHint(null), 9000)
        return () => window.clearTimeout(t)
    }, [hint, setHint])

    if (!enabled) return null

    const compact = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches
    const base = compact ? CC_BOTTOM_COMPACT : CC_BOTTOM
    const bottom = captionsOn && ccHeight > 0 ? base + ccHeight + GAP : base

    return (
        <div
            ref={layerRef}
            className="trl-cc-layer"
            style={{ bottom }}
            aria-live="polite"
            aria-atomic="false"
            aria-label="Translated captions"
        >
            <AnimatePresence initial={false}>
                {hint && (
                    <motion.div
                        key="hint"
                        className="trl-cc-hint"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        role="status"
                    >
                        {hint}
                    </motion.div>
                )}
                {visible.map((it) => (
                    <motion.div
                        key={it.id}
                        layout="position"
                        className="trl-cc-line"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                    >
                        <span className="trl-cc-badge" aria-hidden="true"><Languages size={12} /></span>
                        <span className="trl-cc-body">
                            <span className="trl-cc-text">
                                <span className="trl-cc-speaker">{it.speaker_name || it.speaker}:</span> {it.text}
                            </span>
                            {showOriginal && it.original && (
                                <span className="trl-cc-original" lang={it.source_language}>{it.original}</span>
                            )}
                        </span>
                    </motion.div>
                ))}
            </AnimatePresence>
            {visible.length > 0 && (
                <button
                    type="button"
                    className={`trl-cc-toggle${showOriginal ? ' is-on' : ''}`}
                    onClick={() => setShowOriginal((v) => !v)}
                    aria-pressed={showOriginal}
                >
                    {showOriginal ? 'Hide original' : 'Original'}
                </button>
            )}
        </div>
    )
}
