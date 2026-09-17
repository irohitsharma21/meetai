import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { REACTION_EMOJI, REACTION_LABELS } from './utils'
import '../../../styles/panels.css'

interface ReactionBarProps {
    onPick: (emoji: string) => void
    onClose: () => void
}

/**
 * Horizontal emoji strip meant to be rendered as popover content above the
 * Reactions button. Roving tabindex: arrows move, Enter/Space pick, Escape closes.
 */
export function ReactionBar({ onPick, onClose }: ReactionBarProps): JSX.Element {
    const buttons = useRef<(HTMLButtonElement | null)[]>([])
    const [focusIdx, setFocusIdx] = useState(0)
    const count = REACTION_EMOJI.length

    useEffect(() => {
        buttons.current[0]?.focus()
    }, [])

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        let next = focusIdx
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                next = (focusIdx + 1) % count
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                next = (focusIdx - 1 + count) % count
                break
            case 'Home':
                next = 0
                break
            case 'End':
                next = count - 1
                break
            case 'Escape':
                e.preventDefault()
                onClose()
                return
            default:
                return
        }
        e.preventDefault()
        setFocusIdx(next)
        buttons.current[next]?.focus()
    }

    return (
        <div className="rx-bar" role="toolbar" aria-label="Send a reaction" onKeyDown={onKeyDown}>
            {REACTION_EMOJI.map((emoji, i) => (
                <button
                    key={emoji}
                    ref={(el) => {
                        buttons.current[i] = el
                    }}
                    type="button"
                    className="rx-bar-btn"
                    tabIndex={i === focusIdx ? 0 : -1}
                    aria-label={REACTION_LABELS[emoji] ?? emoji}
                    title={REACTION_LABELS[emoji] ?? emoji}
                    onFocus={() => setFocusIdx(i)}
                    onClick={() => {
                        onPick(emoji)
                        onClose()
                    }}
                >
                    {emoji}
                </button>
            ))}
        </div>
    )
}
