import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, CheckCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { calendarApi } from '../../lib/api'
import { useToastStore } from '../../store'

export function CalendarPage() {
    const { addToast } = useToastStore()
    const [isConnected, setIsConnected] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    const checkStatus = async () => {
        try {
            setIsLoading(true)
            const res = await calendarApi.status()
            setIsConnected(res.data.connected)
        } catch {
            setIsConnected(false)
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => { checkStatus() }, [])

    const handleConnect = async () => {
        try {
            const res = await calendarApi.connect()
            window.open(res.data.auth_url, '_blank')
            addToast({ type: 'info', title: 'Google Auth opened', message: 'Complete authorization in the new tab, then refresh.' })
        } catch {
            addToast({ type: 'error', title: 'Failed to get authorization URL' })
        }
    }

    return (
        <div className="page">
            <div className="container" style={{ maxWidth: 640 }}>
                <h1 style={{ marginBottom: '0.5rem' }}>Google Calendar</h1>
                <p style={{ marginBottom: '2rem' }}>Connect your Google Calendar to automatically schedule confirmed actions from meetings.</p>

                <div className="card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                        <div style={{
                            width: 48, height: 48, borderRadius: '12px',
                            background: isConnected ? 'rgba(16,185,129,0.15)' : 'var(--color-bg-elevated)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: `1px solid ${isConnected ? 'rgba(16,185,129,0.3)' : 'var(--color-border)'}`,
                        }}>
                            {isConnected ? <CheckCircle size={24} color="var(--color-success)" /> : <Calendar size={24} color="var(--text-muted)" />}
                        </div>
                        <div>
                            <h3 style={{ fontSize: '1rem' }}>
                                {isLoading ? 'Checking connection…' : isConnected ? 'Connected' : 'Not Connected'}
                            </h3>
                            <p style={{ fontSize: '0.8125rem', marginTop: '0.125rem' }}>
                                {isConnected
                                    ? 'Your Google Calendar is linked. Confirmed actions will be auto-scheduled.'
                                    : 'Link your Google Calendar to enable automatic event creation.'}
                            </p>
                        </div>
                    </div>

                    {!isConnected && !isLoading && (
                        <button className="btn btn-primary" onClick={handleConnect} style={{ width: '100%' }}>
                            <ExternalLink size={15} /> Connect Google Calendar
                        </button>
                    )}
                    {isConnected && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn btn-secondary btn-sm" onClick={checkStatus}>
                                <RefreshCw size={14} /> Refresh Status
                            </button>
                            <Link to="/dashboard" className="btn btn-primary btn-sm">
                                Back to Dashboard
                            </Link>
                        </div>
                    )}
                </div>

                {/* How it works */}
                <div className="card" style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ marginBottom: '1rem', fontSize: '0.9375rem' }}>How it works</h3>
                    {[
                        { step: '1', text: 'During a meeting, AI detects scheduling commitments in real-time' },
                        { step: '2', text: 'A popup appears asking you to confirm or dismiss the detected action' },
                        { step: '3', text: 'When confirmed, the event is automatically created in your Google Calendar' },
                        { step: '4', text: 'The meeting record is updated with the confirmed calendar link' },
                    ].map(({ step, text }) => (
                        <div key={step} style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                            <div style={{
                                width: 28, height: 28, borderRadius: '50%',
                                background: 'var(--gradient-brand)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '0.75rem', fontWeight: 700, color: '#fff', flexShrink: 0,
                            }}>{step}</div>
                            <p style={{ fontSize: '0.875rem', paddingTop: '0.25rem' }}>{text}</p>
                        </div>
                    ))}
                </div>

                {/* Success page target */}
                <div id="calendar-success" />
            </div>
        </div>
    )
}
