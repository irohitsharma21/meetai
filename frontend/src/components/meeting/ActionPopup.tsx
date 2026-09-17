import { Check, X, Calendar, Clock, User, Sparkles, ListChecks } from 'lucide-react'
import { useMeetingRoomStore, useToastStore } from '../../store'
import { meetingApi, calendarApi } from '../../lib/api'
import type { ActionDetectionResult } from '../../types'

interface ActionPopupProps {
    action: ActionDetectionResult
    index: number
    meetingId: string
}

/**
 * A detected commitment, shown as a Meet-style card in the bottom-right of
 * the room. Newest on top; older cards tuck behind it.
 */
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
                addToast({ type: 'success', title: 'Action confirmed', message: 'Event added to Google Calendar' })
            } catch {
                addToast({ type: 'info', title: 'Action confirmed', message: 'Saved. Connect Google Calendar to sync events.' })
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

    const typeIcon: Record<string, JSX.Element> = {
        schedule: <Calendar size={16} />,
        deadline: <Clock size={16} />,
        task: <ListChecks size={16} />,
        commitment: <Check size={16} />,
    }
    const kind = action.type || 'action'
    const confidence = Math.round(action.confidence * 100)

    return (
        <div
            className="action-toast"
            role="dialog"
            aria-label={`Detected ${kind}`}
            style={{
                transform: `translateY(${-index * 10}px) scale(${1 - index * 0.03})`,
                opacity: 1 - index * 0.18,
                zIndex: 200 - index,
                pointerEvents: index === 0 ? 'auto' : 'none',
            }}
        >
            <div className="action-toast-head">
                <span className="action-toast-icon">{typeIcon[kind] ?? <Sparkles size={16} />}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="action-toast-kind">{kind} detected</div>
                    <div className="action-toast-sub">{confidence}% confidence · from the transcript</div>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    onClick={() => dismissAction(index)}
                    aria-label="Close"
                >
                    <X size={16} />
                </button>
            </div>

            <div className="action-toast-body">
                {action.suggested_action && (
                    <p className="action-toast-quote">{action.suggested_action}</p>
                )}

                {action.next_action && (
                    <div className="action-toast-facts">
                        {action.next_action.assignee && (
                            <span className="badge badge-gray badge-plain"><User size={12} aria-hidden="true" /> {action.next_action.assignee}</span>
                        )}
                        {action.next_action.date && (
                            <span className="badge badge-blue badge-plain"><Calendar size={12} aria-hidden="true" /> {action.next_action.date}</span>
                        )}
                        {action.next_action.deadline && (
                            <span className="badge badge-amber badge-plain"><Clock size={12} aria-hidden="true" /> Due {action.next_action.deadline}</span>
                        )}
                    </div>
                )}
            </div>

            <div className="action-toast-foot">
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleReject}>
                    Dismiss
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirm}>
                    <Check size={15} aria-hidden="true" /> Confirm
                </button>
            </div>

            <div className="action-toast-track" aria-hidden="true">
                <div className="action-toast-fill" style={{ width: `${confidence}%` }} />
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
