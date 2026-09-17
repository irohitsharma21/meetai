import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, CalendarCheck, CheckCircle2, ExternalLink, RefreshCw, Users, Loader2, FileText } from 'lucide-react'
import { calendarApi, meetingApi } from '../../lib/api'
import { useToastStore } from '../../store'
import { usePageTitle } from '../../components/common/usePageTitle'
import type { Meeting, NextAction } from '../../types'

interface ConfirmedEvent {
    meetingId: string
    meetingTitle: string
    action: NextAction
    /** Best available date: the action's date or deadline, else the confirmation time. */
    when: Date | null
}

/** Parse the free-text dates the model emits; unparseable ones sort last. */
function parseWhen(a: NextAction): Date | null {
    for (const candidate of [a.date, a.deadline, a.confirmed_at]) {
        if (!candidate) continue
        const d = new Date(candidate)
        if (!Number.isNaN(d.getTime())) return d
    }
    return null
}

function EmptyCalendar() {
    return (
        <svg className="empty-illus" viewBox="0 0 160 100" fill="none" aria-hidden="true">
            <rect x="28" y="16" width="104" height="74" rx="10" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
            <rect x="28" y="16" width="104" height="20" rx="10" fill="currentColor" fillOpacity="0.16" />
            <rect x="52" y="8" width="4" height="16" rx="2" fill="currentColor" fillOpacity="0.5" />
            <rect x="104" y="8" width="4" height="16" rx="2" fill="currentColor" fillOpacity="0.5" />
            {[0, 1, 2, 3].map((c) => [0, 1].map((r) => (
                <rect key={`${c}-${r}`} x={40 + c * 22} y={46 + r * 18} width="14" height="10" rx="3" fill="currentColor" fillOpacity={c === 1 && r === 0 ? 0.5 : 0.12} />
            )))}
        </svg>
    )
}

export function CalendarPage() {
    usePageTitle('Calendar')
    const { addToast } = useToastStore()
    const [isConnected, setIsConnected] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [events, setEvents] = useState<ConfirmedEvent[] | null>(null)

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

    /**
     * Confirmed events are derived from meeting action items: there is no
     * events-list endpoint, so the most recent completed meetings are read and
     * their confirmed actions collected. Capped so the page stays cheap.
     */
    const loadEvents = async () => {
        try {
            const list = await meetingApi.list({ limit: 40 })
            const done = (list.data.meetings ?? [])
                .filter((m: { status: string }) => m.status === 'ended' || m.status === 'processed')
                .slice(0, 12)
            const details = await Promise.allSettled(done.map((m: { meeting_id: string }) => meetingApi.get(m.meeting_id)))
            const found: ConfirmedEvent[] = []
            details.forEach((d) => {
                if (d.status !== 'fulfilled') return
                const meeting: Meeting = d.value.data
                meeting.ai_analysis?.next_actions?.forEach((a) => {
                    if (a.status === 'confirmed' || a.calendar_event_id) {
                        found.push({ meetingId: meeting.meeting_id, meetingTitle: meeting.title, action: a, when: parseWhen(a) })
                    }
                })
            })
            found.sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0))
            setEvents(found)
        } catch {
            setEvents([])
        }
    }

    useEffect(() => { checkStatus(); loadEvents() }, [])

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
        <div className="content-narrow">
            <div className="page-header">
                <div>
                    <h1>Calendar</h1>
                    <div className="page-subtitle">Confirmed follow-ups are scheduled in Google Calendar automatically.</div>
                </div>
            </div>

            <div className="cal-status">
                <span className="cal-status-icon" data-on={isConnected ? 'true' : 'false'}>
                    {isLoading ? <Loader2 size={22} className="spin" /> : isConnected ? <CheckCircle2 size={24} /> : <Calendar size={24} />}
                </span>
                <div className="cal-status-text">
                    <div className="cal-status-title">
                        {isLoading ? 'Checking connection…' : isConnected ? 'Google Calendar connected' : 'Google Calendar not connected'}
                    </div>
                    <div className="cal-status-sub">
                        {isConnected
                            ? 'Confirmed action items are added as events with the meeting linked.'
                            : 'Link your Google account to schedule confirmed actions automatically.'}
                    </div>
                </div>
                {!isConnected && !isLoading && (
                    <button className="btn btn-primary" onClick={handleConnect}>
                        <ExternalLink size={16} aria-hidden="true" /> Connect Google Calendar
                    </button>
                )}
                {isConnected && (
                    <button className="btn" onClick={checkStatus}>
                        <RefreshCw size={16} aria-hidden="true" /> Refresh
                    </button>
                )}
            </div>

            <div className="section-title" style={{ marginTop: '1.5rem' }}>
                <span>Confirmed events</span>
                {events && events.length > 0 && <span className="text-sm muted">{events.length}</span>}
            </div>
            <div className="panel">
                {events === null ? (
                    <div style={{ padding: '0.5rem 0' }} aria-busy="true">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="skeleton-row" style={{ gridTemplateColumns: '56px 1fr 80px' }}>
                                <div className="skeleton" style={{ height: 56, borderRadius: 8 }} />
                                <div className="skeleton skeleton-text" style={{ width: '70%' }} />
                                <div className="skeleton skeleton-text" style={{ width: 60 }} />
                            </div>
                        ))}
                    </div>
                ) : events.length === 0 ? (
                    <div className="empty-state">
                        <EmptyCalendar />
                        <div className="empty-title">No confirmed events yet</div>
                        <div className="empty-text">
                            When you confirm an action item during a meeting, it appears here
                            {isConnected ? ' and in your Google Calendar' : ''}.
                        </div>
                        <Link to="/dashboard" className="btn" style={{ marginTop: '0.5rem' }}>Go to meetings</Link>
                    </div>
                ) : (
                    <div className="cal-events">
                        {events.map(({ meetingId, meetingTitle, action, when }) => (
                            <div className="cal-event" key={`${meetingId}-${action.id}`}>
                                <div className="cal-date" aria-hidden="true">
                                    <b>{when ? when.getDate() : '—'}</b>
                                    <small>{when ? when.toLocaleString(undefined, { month: 'short' }) : 'TBD'}</small>
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <div className="cal-event-title">{action.task}</div>
                                    <div className="cal-event-sub">
                                        <span><FileText size={13} aria-hidden="true" /> <Link to={`/meetings/${meetingId}/report`} className="text-link">{meetingTitle}</Link></span>
                                        {action.assignee && <span><Users size={13} aria-hidden="true" /> {action.assignee}</span>}
                                        {(action.deadline || action.date) && <span><Calendar size={13} aria-hidden="true" /> {action.deadline || action.date}</span>}
                                    </div>
                                </div>
                                <span className={`badge ${action.calendar_event_id ? 'badge-green' : 'badge-blue'}`}>
                                    {action.calendar_event_id ? 'On calendar' : 'Confirmed'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="section-title" style={{ marginTop: '1.5rem' }}><span>How it works</span></div>
            <div className="card">
                <div className="steps">
                    {[
                        ['Detect', 'During a meeting, the assistant listens for commitments, dates and deadlines.'],
                        ['Confirm', 'A card appears in the room asking you to confirm or dismiss the detected action.'],
                        ['Schedule', 'Confirmed actions are created in your Google Calendar with the meeting linked.'],
                        ['Record', 'The meeting report is updated with the confirmed event.'],
                    ].map(([title, text], i) => (
                        <div className="step" key={title}>
                            <span className="step-num" aria-hidden="true">{i + 1}</span>
                            <div>
                                <div className="step-title">{title}</div>
                                <div className="step-text">{text}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Success page target */}
            <div id="calendar-success" />
            <span className="sr-only"><CalendarCheck size={1} /></span>
        </div>
    )
}
