import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToastStore, type Toast } from '../../store'

const icons = {
    success: <CheckCircle size={18} color="var(--color-success)" />,
    error: <XCircle size={18} color="var(--color-danger)" />,
    info: <Info size={18} color="var(--color-primary)" />,
    warning: <AlertTriangle size={18} color="var(--color-warning)" />,
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
        <div className={`toast toast-${toast.type}`}>
            {icons[toast.type]}
            <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                    {title}
                </div>
                {message && (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        {message}
                    </div>
                )}
            </div>
            <button className="btn-ghost btn-icon-sm" onClick={() => removeToast(toast.id)} style={{ flexShrink: 0 }}>
                <X size={14} />
            </button>
        </div>
    )
}

export function ToastContainer() {
    const { toasts } = useToastStore()

    return (
        <div className="toast-stack">
            {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
        </div>
    )
}
