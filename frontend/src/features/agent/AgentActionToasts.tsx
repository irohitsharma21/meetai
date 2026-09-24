import { useEffect, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Check, Keyboard, Loader2, Mic, X } from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { onWsMessage } from '../../lib/wsBus'
import { useToastStore } from '../../store'
import { useAgentStore, useMeetingActions } from './store'
import { recipientLine } from './AgentPanel'
import type { AgentAction, AgentNotice } from './types'
import './agent.css'

interface AgentActionToastsProps {
    meetingId: string
    /** True while the AgentPanel is showing; confirm cards are suppressed then. */
    panelOpen: boolean
    onOpenPanel: () => void
}

const MAX_CARDS = 2

/**
 * Always mounted in the room. Listens for delegate-agent socket messages,
 * keeps the agent store current, and surfaces anything that needs the owner:
 *   · pending / needs_input → a floating confirm card (unless the panel is open)
 *   · done / failed of a spoken command → a small toast so the owner knows
 *   · agent_notice (someone's assistant sent you something) → an info toast
 */
export function AgentActionToasts({ meetingId, panelOpen, onOpenPanel }: AgentActionToastsProps): JSX.Element {
    const { addToast } = useToastStore()
    const actions = useMeetingActions(meetingId)
    const dismissed = useAgentStore((s) => s.dismissed)
    const busy = useAgentStore((s) => s.busy)
    const approve = useAgentStore((s) => s.approve)
    const reject = useAgentStore((s) => s.reject)
    const dismiss = useAgentStore((s) => s.dismiss)

    const panelOpenRef = useRef(panelOpen)
    panelOpenRef.current = panelOpen

    // Initial load, so anything left waiting (e.g. after a reload) resurfaces.
    useEffect(() => {
        useAgentStore.getState().load(meetingId).catch(() => { /* the panel shows load errors */ })
    }, [meetingId])

    useEffect(() => {
        const offAction = onWsMessage('agent_action', (msg: { action?: AgentAction }) => {
            const action = msg?.action
            if (!action?.id) return
            const prev = useAgentStore.getState().upsert(action)
            if (action.meeting_id !== meetingId) return
            const changed = !prev || prev.status !== action.status
            if (!changed) return
            const fromVoice = action.source === 'voice'
            if ((action.status === 'done' || action.status === 'failed') && (fromVoice || !panelOpenRef.current)) {
                addToast({
                    type: action.status === 'done' ? 'success' : 'error',
                    title: action.status === 'done' ? 'Assistant: done' : "Assistant couldn't finish",
                    message: action.message || action.summary,
                })
            } else if (action.status === 'blocked' && fromVoice && !panelOpenRef.current) {
                addToast({
                    type: 'warning',
                    title: "Assistant isn't allowed to do that",
                    message: action.message || 'Turn it on in assistant settings.',
                })
            }
        })
        const offNotice = onWsMessage('agent_notice', (msg: { notice?: AgentNotice }) => {
            const n = msg?.notice
            if (!n) return
            addToast({
                type: 'info',
                title: n.from_name ? `From ${n.from_name}'s assistant` : 'From an assistant',
                message: n.message,
            })
        })
        return () => {
            offAction()
            offNotice()
        }
    }, [meetingId, addToast])

    const open = useMemo(
        () => actions.filter((a) => (a.status === 'pending' || a.status === 'needs_input') && !dismissed[a.id]),
        [actions, dismissed],
    )
    const shown = panelOpen ? [] : open.slice(0, MAX_CARDS)
    const extra = panelOpen ? 0 : Math.max(0, open.length - MAX_CARDS)

    const act = async (a: AgentAction, kind: 'approve' | 'reject') => {
        try {
            if (kind === 'approve') await approve(meetingId, a.id)
            else await reject(meetingId, a.id)
            dismiss(a.id)
        } catch (err) {
            addToast({ type: 'error', title: kind === 'approve' ? "Couldn't approve" : "Couldn't cancel", message: errorMessage(err) })
        }
    }

    return (
        <div className="agt-float" aria-live="polite">
            <AnimatePresence initial={false}>
                {shown.map((a) => {
                    const isBusy = !!busy[a.id]
                    const who = recipientLine(a)
                    const SourceIcon = a.source === 'voice' ? Mic : Keyboard
                    return (
                        <motion.div
                            key={a.id}
                            layout
                            className="agt-float-card"
                            role="alertdialog"
                            aria-label="Your assistant needs you"
                            initial={{ opacity: 0, y: -10, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
                            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                        >
                            <div className="agt-float-head">
                                <span className="agt-float-icon" aria-hidden="true"><Bot size={14} /></span>
                                <span className="agt-float-title">
                                    {a.status === 'needs_input' ? 'Your assistant needs details' : 'Approve this?'}
                                </span>
                                <SourceIcon size={12} className="agt-float-src" aria-label={a.source === 'voice' ? 'Spoken' : 'Typed'} />
                                <button type="button" className="agt-float-x" onClick={() => dismiss(a.id)} aria-label="Hide (it stays in the assistant panel)" title="Hide">
                                    <X size={14} />
                                </button>
                            </div>
                            <div className="agt-float-summary">{a.summary || a.command}</div>
                            {a.status === 'needs_input' ? (
                                a.message && <div className="agt-float-sub">{a.message}</div>
                            ) : (
                                who && <div className="agt-float-sub">To {who}</div>
                            )}
                            <div className="agt-float-foot">
                                {a.status === 'needs_input' ? (
                                    <>
                                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(a, 'reject')} disabled={isBusy}>Cancel</button>
                                        <button type="button" className="btn btn-primary btn-sm" onClick={onOpenPanel}>Review</button>
                                    </>
                                ) : (
                                    <>
                                        {a.tool === 'send_email' && (
                                            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPanel} disabled={isBusy}>Edit</button>
                                        )}
                                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(a, 'reject')} disabled={isBusy}>Cancel</button>
                                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void act(a, 'approve')} disabled={isBusy}>
                                            {isBusy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                                            Approve
                                        </button>
                                    </>
                                )}
                            </div>
                        </motion.div>
                    )
                })}
                {extra > 0 && (
                    <motion.button
                        key="more"
                        type="button"
                        className="agt-float-more"
                        onClick={onOpenPanel}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                    >
                        {extra} more waiting — open assistant
                    </motion.button>
                )}
            </AnimatePresence>
        </div>
    )
}
