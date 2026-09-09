import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToastStore, type Toast } from '../../store'

const icons = {
    success: <CheckCircle size={18} color="var(--color-success)" />,
    error: <XCircle size={18} color="var(--color-danger)" />,
    info: <Info size={18} color="var(--color-primary)" />,
    warning: <AlertTriangle size={18} color="var(--color-warning)" />,
}

function ToastItem({ toast }: { toast: Toast }) {
    const { removeToast } = useToastStore()

    return (
        <div className={`toast toast-${toast.type}`}>
            {icons[toast.type]}
            <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                    {toast.title}
                </div>
                {toast.message && (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        {toast.message}
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
        <div style={{ position: 'fixed', top: '4.5rem', right: '1.5rem', zIndex: 300, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
        </div>
    )
}
