import { useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'

/**
 * A small anchored surface that opens above a control-bar button.
 *
 * Closes on an outside click or Escape. The anchor is whatever wraps it: the
 * caller renders `<div className="room-anchor">` around the trigger button and
 * this popover, so it positions relative to that.
 */
export function Popover({
    open,
    onClose,
    children,
    align = 'center',
    width,
    label,
}: {
    open: boolean
    onClose: () => void
    children: ReactNode
    align?: 'center' | 'left' | 'right'
    width?: number
    label?: string
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => {
            const el = ref.current
            if (!el) return
            const anchor = el.parentElement
            if (anchor && e.target instanceof Node && anchor.contains(e.target)) return
            onClose()
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open, onClose])

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    ref={ref}
                    className={`room-popover room-popover-${align}`}
                    role={label ? 'menu' : undefined}
                    aria-label={label}
                    style={width ? { width } : undefined}
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    )
}

export interface MenuItemProps {
    icon?: ReactNode
    label: string
    hint?: string
    checked?: boolean
    danger?: boolean
    disabled?: boolean
    onSelect: () => void
}

export function MenuItem({ icon, label, hint, checked, danger, disabled, onSelect }: MenuItemProps) {
    return (
        <button
            type="button"
            role="menuitem"
            className={`room-menu-item${danger ? ' is-danger' : ''}`}
            disabled={disabled}
            onClick={onSelect}
        >
            <span className="room-menu-icon">{icon}</span>
            <span className="room-menu-label">{label}</span>
            {hint && <span className="room-menu-hint">{hint}</span>}
            {checked && <Check size={14} className="room-menu-check" aria-hidden="true" />}
        </button>
    )
}

export function MenuDivider() {
    return <div className="room-menu-divider" role="separator" />
}

export function MenuHeading({ children }: { children: ReactNode }) {
    return <div className="room-menu-heading">{children}</div>
}
