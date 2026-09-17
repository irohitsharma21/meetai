import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMeetingRoomStore } from '../../../store'
import type { TranscriptEntry } from '../../../types'
import '../../../styles/panels.css'

const CAPTION_TTL_MS = 6000
const MAX_LINES = 2

interface CaptionsOverlayProps {
    enabled: boolean
}

/**
 * Cinematic subtitles over the stage, fed by the transcript entries the
 * meeting WebSocket already delivers. Arrival time is tracked per entry id so
 * a line leaves ~6 s after it was received, independent of its spoken time.
 * Entries already present when the overlay mounts are treated as old news.
 */
export function CaptionsOverlay({ enabled }: CaptionsOverlayProps): JSX.Element | null {
    const transcript = useMeetingRoomStore((s) => s.transcript)
    const arrivedAt = useRef<Map<string, number>>(new Map())
    const seeded = useRef(false)
    const timer = useRef<number | null>(null)
    const [visible, setVisible] = useState<TranscriptEntry[]>([])

    const recompute = useCallback(() => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current)
            timer.current = null
        }
        const now = Date.now()
        const live: TranscriptEntry[] = []
        let nextExpiry = Infinity
        for (const e of transcript) {
            const t = arrivedAt.current.get(e.id) ?? 0
            const expires = t + CAPTION_TTL_MS
            if (expires > now) {
                live.push(e)
                if (expires < nextExpiry) nextExpiry = expires
            }
        }
        const shown = live.slice(-MAX_LINES)
        setVisible((prev) =>
            prev.length === shown.length && prev.every((p, i) => p.id === shown[i].id) ? prev : shown,
        )
        if (nextExpiry !== Infinity) {
            timer.current = window.setTimeout(recompute, Math.max(50, nextExpiry - now + 20))
        }
    }, [transcript])

    useEffect(() => {
        const now = Date.now()
        if (transcript.length === 0) {
            arrivedAt.current.clear()
        }
        for (const e of transcript) {
            if (!arrivedAt.current.has(e.id)) {
                arrivedAt.current.set(e.id, seeded.current ? now : 0)
            }
        }
        seeded.current = true
        recompute()
        return () => {
            if (timer.current !== null) {
                window.clearTimeout(timer.current)
                timer.current = null
            }
        }
    }, [transcript, recompute])

    if (!enabled) return null

    return (
        <div className="cc-layer" aria-live="polite" aria-atomic="false">
            <AnimatePresence initial={false}>
                {visible.map((e) => (
                    <motion.div
                        key={e.id}
                        className="cc-line"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                    >
                        <span className="cc-speaker">{e.speaker}</span>
                        <span className="cc-text">{e.text}</span>
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    )
}
