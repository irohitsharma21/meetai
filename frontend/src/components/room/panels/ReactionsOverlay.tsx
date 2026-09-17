import { useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useDataChannel } from '@livekit/components-react'
import { usePanelsStore } from './panelsStore'
import type { DataMessage, ReactionMessage } from './useRoomSignals'
import { decodeJson } from './utils'
import '../../../styles/panels.css'

const FLOAT_SECONDS = 2.5

/**
 * Full-stage layer of floating emoji. Remote reactions arrive on the "reaction"
 * data topic; local ones are pushed straight into the store by
 * `useRoomSignals().sendReaction` because LiveKit does not echo a
 * participant's own data messages back to them.
 */
export function ReactionsOverlay(): JSX.Element {
    const reactions = usePanelsStore((s) => s.reactions)
    const pushReaction = usePanelsStore((s) => s.pushReaction)
    const removeReaction = usePanelsStore((s) => s.removeReaction)

    const onMessage = useCallback(
        (msg: DataMessage) => {
            const data = decodeJson<Partial<ReactionMessage>>(msg.payload)
            if (!data || data.kind !== 'reaction' || typeof data.emoji !== 'string' || !data.emoji) return
            const name =
                (typeof data.name === 'string' && data.name.trim()) ||
                msg.from?.name?.trim() ||
                msg.from?.identity ||
                (typeof data.from === 'string' ? data.from : '') ||
                'Someone'
            pushReaction({ emoji: data.emoji, name, ts: typeof data.ts === 'number' ? data.ts : undefined })
        },
        [pushReaction],
    )
    useDataChannel('reaction', onMessage)

    return (
        <div className="rx-layer" aria-hidden="true">
            <AnimatePresence>
                {reactions.map((r) => (
                    <motion.div
                        key={r.id}
                        className="rx-item"
                        style={{ left: `${r.x}%` }}
                        initial={{ opacity: 0, y: 24, scale: 0.4 }}
                        animate={{
                            opacity: [0, 1, 1, 0],
                            y: [24, -110, -260, -380],
                            x: [0, r.drift * 0.6, r.drift * 0.2, r.drift],
                            scale: [0.4, 1.25, 1, 0.85],
                        }}
                        exit={{ opacity: 0, transition: { duration: 0.15 } }}
                        transition={{ duration: FLOAT_SECONDS, ease: 'easeOut', times: [0, 0.14, 0.72, 1] }}
                        onAnimationComplete={() => removeReaction(r.id)}
                    >
                        <span className="rx-emoji">{r.emoji}</span>
                        <span className="rx-name">{r.name}</span>
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    )
}
