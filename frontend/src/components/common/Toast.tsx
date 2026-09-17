import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToastStore, type Toast } from '../../store'

const icons = {
    success: <CheckCircle2 size={20} color="var(--color-success)" aria-hidden="true" />,
    error: <XCircle size={20} color="var(--color-danger)" aria-hidden="true" />,
    info: <Info size={20} color="var(--color-primary)" aria-hidden="true" />,
    warning: <AlertTriangle size={20} color="var(--color-warning)" aria-hidden="true" />,
}

/**
 * Coerce anything to renderable text.
 *
 * A toast is the last thing that should be able to crash the app: it exists to
 * report a failure, and it is fed straight from API error bodies. React throws
 * on an object child, which unmounts the entire tree - so nothing but a string
 * ever reaches the DOM here.
 */
function renderable(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value)) {
        const parts = value.map(renderable).filter(Boolean)
        return parts.length ? parts.join(' | ') : null
    }
    if (typeof value === 'object') {
        const o = value as Record<string, unknown>
        const msg = o.msg ?? o.message ?? o.detail
        if (typeof msg === 'string') return msg
        try {
            return JSON.stringify(value)
        } catch {
            return null
        }
    }
    return String(value)
}

function ToastItem({ toast }: { toast: Toast }) {
    const { removeToast } = useToastStore()
    const title = renderable(toast.title)
    const message = renderable(toast.message)

    return (
        <div
            className={`toast toast-${toast.type}`}
            role={toast.type === 'error' ? 'alert' : 'status'}
        >
            {icons[toast.type]}
            <div className="toast-body">
                <div className="toast-title">{title}</div>
                {message && <div className="toast-msg">{message}</div>}
            </div>
            <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                onClick={() => removeToast(toast.id)}
                aria-label="Dismiss notification"
                style={{ flexShrink: 0, marginTop: -4, marginRight: -4 }}
            >
                <X size={16} />
            </button>
        </div>
    )
}

/** Bottom-left notification stack. Polite live region; errors are assertive. */
export function ToastContainer() {
    const { toasts } = useToastStore()

    return (
        <div className="toast-stack" aria-live="polite" aria-relevant="additions">
            {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
        </div>
    )
}
