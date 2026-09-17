import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup } from 'framer-motion'
import { Track } from 'livekit-client'
import { useTracks, type TrackReferenceOrPlaceholder } from '@livekit/components-react'
import { Users } from 'lucide-react'
import { Tile, tileKeyOf } from './Tile'

export interface StageProps {
    hostIdentity: string
    /** Host-driven spotlight (identity), from useRoomSignals. */
    spotlight: string | null
    /** Local pin (tile key). Overrides the spotlight until cleared. */
    pinned: string | null
    onPin: (key: string | null) => void
    compact: boolean
    joinCode: string | null
}

const GAP = 6
const MIN_TILE_W = 150

interface GridSpec {
    cols: number
    rows: number
    tileW: number
    tileH: number
}

/**
 * Meet-style auto layout: try every column count and keep the one that gives
 * the largest tiles while preserving aspect ratio inside the container.
 */
function bestGrid(n: number, w: number, h: number, aspect: number): GridSpec {
    // Score every column count first, then prefer the widest layout whose
    // tiles are within 8% of the largest possible. Without the tolerance two
    // people end up stacked vertically on a 16:9 window, because a single
    // column wins the area contest by a few pixels; side by side is what
    // people expect to see.
    const candidates: (GridSpec & { area: number })[] = []
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols)
        const maxW = (w - GAP * (cols - 1)) / cols
        const maxH = (h - GAP * (rows - 1)) / rows
        let tileW = maxW
        let tileH = maxW / aspect
        if (tileH > maxH) {
            tileH = maxH
            tileW = maxH * aspect
        }
        candidates.push({ cols, rows, tileW: Math.floor(tileW), tileH: Math.floor(tileH), area: tileW * tileH })
    }
    const maxArea = Math.max(...candidates.map((c) => c.area))
    let best = candidates[0]
    for (const c of candidates) {
        if (c.area >= maxArea * 0.92) best = c
    }
    const { area: _area, ...spec } = best
    void _area
    return spec
}

function useSize<T extends HTMLElement>() {
    const ref = useRef<T>(null)
    const [size, setSize] = useState({ w: 0, h: 0 })
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        // Content box, not client box: clientWidth includes padding, and a
        // grid sized to the padded width wraps one column early.
        const update = () => {
            const cs = getComputedStyle(el)
            const px = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
            const py = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
            setSize({ w: el.clientWidth - px, h: el.clientHeight - py })
        }
        update()
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
    }, [])
    return { ref, size }
}

/**
 * The video stage. Custom layout rather than LiveKit's VideoConference so
 * pins, spotlight and screen share follow this app's rules:
 *
 *   local pin  >  host spotlight  >  a screen share  >  plain grid
 */
export function Stage({ hostIdentity, spotlight, pinned, onPin, compact, joinCode }: StageProps) {
    const tracks = useTracks(
        [
            { source: Track.Source.Camera, withPlaceholder: true },
            { source: Track.Source.ScreenShare, withPlaceholder: false },
        ],
        { onlySubscribed: false },
    )

    // Stable, sensible order: shares first, then the host, then everyone else
    // in arrival order, with yourself last - the Meet convention.
    const ordered = useMemo(() => {
        const rank = (t: TrackReferenceOrPlaceholder) => {
            if (t.source === Track.Source.ScreenShare) return 0
            if (t.participant.identity === hostIdentity) return 1
            if (t.participant.isLocal) return 3
            return 2
        }
        return [...tracks].sort((a, b) => rank(a) - rank(b))
    }, [tracks, hostIdentity])

    const keys = useMemo(() => new Set(ordered.map(tileKeyOf)), [ordered])

    // A pin on a tile that left the room is meaningless - drop it.
    useEffect(() => {
        if (pinned && !keys.has(pinned)) onPin(null)
    }, [pinned, keys, onPin])

    const focusKey = useMemo(() => {
        if (pinned && keys.has(pinned)) return pinned
        if (spotlight && keys.has(spotlight)) return spotlight
        const share = ordered.find((t) => t.source === Track.Source.ScreenShare)
        return share ? tileKeyOf(share) : null
    }, [pinned, spotlight, keys, ordered])

    const { ref, size } = useSize<HTMLDivElement>()

    const focus = focusKey ? ordered.find((t) => tileKeyOf(t) === focusKey) ?? null : null
    const rest = focus ? ordered.filter((t) => t !== focus) : ordered

    const portrait = size.h > size.w
    const aspect = portrait && ordered.length <= 2 ? 3 / 4 : 16 / 9
    const grid = useMemo(() => {
        if (!size.w || !size.h || !ordered.length) return null
        const spec = bestGrid(ordered.length, size.w, size.h, aspect)
        // Too many people for the space: fall back to a scrolling grid of
        // fixed-minimum tiles rather than postage stamps.
        if (spec.tileW < MIN_TILE_W) {
            const cols = Math.max(1, Math.floor((size.w + GAP) / (MIN_TILE_W + GAP)))
            const tileW = Math.floor((size.w - GAP * (cols - 1)) / cols)
            return { cols, rows: Math.ceil(ordered.length / cols), tileW, tileH: Math.floor(tileW / aspect), scroll: true }
        }
        return { ...spec, scroll: false }
    }, [size.w, size.h, ordered.length, aspect])

    const alone = ordered.length === 1 && ordered[0].participant.isLocal

    return (
        <div className="room-stage" ref={ref}>
            <LayoutGroup id="stage">
                {focus ? (
                    <div className={`room-focus${compact ? ' is-compact' : ''}`}>
                        <div className="room-focus-main">
                            <AnimatePresence initial={false}>
                                <Tile
                                    key={tileKeyOf(focus)}
                                    trackRef={focus}
                                    tileKey={tileKeyOf(focus)}
                                    isHost={focus.participant.identity === hostIdentity}
                                    pinned={pinned === tileKeyOf(focus)}
                                    onPin={onPin}
                                    variant="focus"
                                />
                            </AnimatePresence>
                        </div>
                        {rest.length > 0 && (
                            <div className="room-strip" role="list" aria-label="Other participants">
                                <AnimatePresence initial={false}>
                                    {rest.map((t) => {
                                        const k = tileKeyOf(t)
                                        return (
                                            <Tile
                                                key={k}
                                                trackRef={t}
                                                tileKey={k}
                                                isHost={t.participant.identity === hostIdentity}
                                                pinned={pinned === k}
                                                onPin={onPin}
                                                variant="strip"
                                            />
                                        )
                                    })}
                                </AnimatePresence>
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        className={`room-grid${grid?.scroll ? ' is-scroll' : ''}`}
                        style={{ gap: GAP }}
                    >
                        <AnimatePresence initial={false}>
                            {ordered.map((t) => {
                                const k = tileKeyOf(t)
                                return (
                                    <Tile
                                        key={k}
                                        trackRef={t}
                                        tileKey={k}
                                        isHost={t.participant.identity === hostIdentity}
                                        pinned={false}
                                        onPin={onPin}
                                        variant="grid"
                                        style={grid ? { width: grid.tileW, height: grid.tileH } : undefined}
                                    />
                                )
                            })}
                        </AnimatePresence>
                    </div>
                )}
            </LayoutGroup>

            {alone && (
                <div className="room-stage-hint">
                    <Users size={13} />
                    You're the only one here{joinCode ? ` · share code ${joinCode} to invite others` : ''}
                </div>
            )}
        </div>
    )
}
