import { Bot, Check, X, Calendar, Clock, User } from 'lucide-react'
import { useMeetingRoomStore, useToastStore } from '../../store'
import { meetingApi, calendarApi } from '../../lib/api'
import type { ActionDetectionResult } from '../../types'

interface ActionPopupProps {
    action: ActionDetectionResult
    index: number
    meetingId: string
}

function ActionPopup({ action, index, meetingId }: ActionPopupProps) {
    const { dismissAction } = useMeetingRoomStore()
    const { addToast } = useToastStore()

    const handleConfirm = async () => {
        try {
            const actionId = action.next_action?.id
            if (!actionId) return

            // First confirm the action in our system
            await meetingApi.confirmAction(meetingId, actionId)

            // Then attempt calendar push
            const now = new Date()
            now.setDate(now.getDate() + 1)  // default to tomorrow
            try {
                await calendarApi.confirmAction({
                    meeting_id: meetingId,
                    action_id: actionId,
                    start_datetime: now.toISOString(),
                })
                addToast({ type: 'success', title: 'Action Confirmed', message: 'Event added to Google Calendar' })
            } catch {
                addToast({ type: 'info', title: 'Action Confirmed', message: 'Saved. Connect Google Calendar to sync events.' })
            }

            dismissAction(index)
        } catch (err) {
            addToast({ type: 'error', title: 'Failed to confirm', message: 'Please try again' })
        }
    }

    const handleReject = async () => {
        const actionId = action.next_action?.id
        if (actionId) {
            try {
                await meetingApi.rejectAction(meetingId, actionId)
            } catch { }
        }
        dismissAction(index)
    }

    const typeIcon = {
        schedule: <Calendar size={16} />,
        deadline: <Clock size={16} />,
        task: <User size={16} />,
        commitment: <Check size={16} />,
    }

    return (
        <div className="action-popup" style={{ bottom: `${2 + index * 0.5}rem`, right: `${2}rem`, opacity: 1 - index * 0.15, transform: `scale(${1 - index * 0.03})`, zIndex: 200 - index }}>
            <div className="action-popup-header">
                <div style={{
                    width: 32, height: 32, borderRadius: '8px',
                    background: 'var(--gradient-brand)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Bot size={16} color="#fff" />
                </div>
                <div>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {typeIcon[action.type as keyof typeof typeIcon] || <Bot size={14} />}
                        AI Detected: {action.type || 'Action'}
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                        Confidence: {Math.round(action.confidence * 100)}%
                    </div>
                </div>
                <button className="btn btn-ghost btn-icon-sm" onClick={() => dismissAction(index)} style={{ marginLeft: 'auto' }}>
                    <X size={14} />
                </button>
            </div>

            <div style={{ padding: '1rem 1.25rem' }}>
                <p style={{
                    fontSize: '0.9375rem',
                    color: 'var(--text-primary)',
                    lineHeight: 1.5,
                    marginBottom: '0.75rem',
                    fontWeight: 500,
                }}>
                    "{action.suggested_action}"
                </p>

                {action.next_action && (
                    <div style={{
                        background: 'var(--color-bg-base)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0.625rem 0.875rem',
                        marginBottom: '1rem',
                        fontSize: '0.8125rem',
                        color: 'var(--text-secondary)',
                        display: 'flex', flexDirection: 'column', gap: '0.25rem',
                    }}>
                        {action.next_action.assignee && (
                            <span>👤 Assignee: <strong style={{ color: 'var(--text-primary)' }}>{action.next_action.assignee}</strong></span>
                        )}
                        {action.next_action.date && (
                            <span>📅 Date: <strong style={{ color: 'var(--text-primary)' }}>{action.next_action.date}</strong></span>
                        )}
                        {action.next_action.deadline && (
                            <span>⏰ Deadline: <strong style={{ color: 'var(--color-warning)' }}>{action.next_action.deadline}</strong></span>
                        )}
                    </div>
                )}

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-primary" style={{ flex: 1, fontSize: '0.875rem' }} onClick={handleConfirm}>
                        <Check size={15} /> Confirm
                    </button>
                    <button className="btn btn-secondary" style={{ flex: 1, fontSize: '0.875rem' }} onClick={handleReject}>
                        <X size={15} /> Dismiss
                    </button>
                </div>
            </div>

            {/* Confidence bar */}
            <div style={{ height: 3, background: 'var(--color-bg-base)' }}>
                <div style={{
                    height: '100%',
                    width: `${action.confidence * 100}%`,
                    background: 'var(--gradient-brand)',
                    transition: 'width 0.5s ease',
                }} />
            </div>
        </div>
    )
}

export function ActionPopupSystem({ meetingId }: { meetingId: string }) {
    const { pendingActions } = useMeetingRoomStore()

    // Show only latest 3 actions stacked
    const visible = pendingActions.slice(-3).reverse()

    return (
        <>
            {visible.map((action, i) => (
                <ActionPopup
                    key={`${action.next_action?.id || i}`}
                    action={action}
                    index={i}
                    meetingId={meetingId}
                />
            ))}
        </>
    )
}
