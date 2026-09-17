import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

/**
 * Centred modal on a scrim. Closes on Escape or a click on the scrim.
 * Used for device settings, the shortcut sheet, meeting details and the
 * "end for everyone" confirmation.
 */
export function Dialog({
    open,
    onClose,
    title,
    icon,
    children,
    footer,
    width = 440,
}: {
    open: boolean
    onClose: () => void
    title: string
    icon?: ReactNode
    children: ReactNode
    footer?: ReactNode
    width?: number
}) {
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                onClose()
            }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [open, onClose])

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    className="room-scrim"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) onClose()
                    }}
                >
                    <motion.div
                        className="room-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label={title}
                        style={{ width, maxWidth: 'calc(100vw - 2rem)' }}
                        initial={{ opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.98 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                        <div className="room-dialog-head">
                            {icon && <span className="room-dialog-icon">{icon}</span>}
                            <span className="room-dialog-title">{title}</span>
                            <button
                                type="button"
                                className="room-icon-btn"
                                onClick={onClose}
                                aria-label="Close"
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <div className="room-dialog-body">{children}</div>
                        {footer && <div className="room-dialog-foot">{footer}</div>}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}

export function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    body,
    confirmLabel,
    busy,
}: {
    open: boolean
    onClose: () => void
    onConfirm: () => void
    title: string
    body: ReactNode
    confirmLabel: string
    busy?: boolean
}) {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            width={400}
            footer={(
                <>
                    <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
                        {busy ? 'Ending…' : confirmLabel}
                    </button>
                </>
            )}
        >
            <p className="room-dialog-text">{body}</p>
        </Dialog>
    )
}
