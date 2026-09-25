import { AnimatePresence, motion } from 'framer-motion'
import { FileText, X } from 'lucide-react'
import type { SidePanelKind } from '../../store'
import { TranscriptPanel } from '../meeting/TranscriptPanel'
import { AssistantDock } from '../meeting/AssistantDock'
import { ChatPanel, ParticipantsPanel } from './panels'
import { BriefingPanel } from '../../features/briefing'
import { AgentPanel } from '../../features/agent'
import { TranslationPanel } from '../../features/translation'

export interface SidePanelProps {
    meetingId: string
    isHost: boolean
    hostIdentity: string
    panel: SidePanelKind | null
    onClose: () => void
    pinned: string | null
    onPin: (identity: string | null) => void
    compact: boolean
    chatDisabled: boolean
}

const PANEL_W = 340

/**
 * The right-hand slot. Exactly one panel at a time; the stage reflows
 * because this is a flex sibling, not an overlay. On a phone it becomes a
 * bottom sheet instead.
 */
export function SidePanel({
    meetingId, isHost, hostIdentity, panel, onClose, pinned, onPin, compact, chatDisabled,
}: SidePanelProps) {
    const variants = compact
        ? {
            initial: { y: '100%', opacity: 0.6 },
            animate: { y: 0, opacity: 1 },
            exit: { y: '100%', opacity: 0.6 },
        }
        : {
            initial: { width: 0, opacity: 0 },
            animate: { width: PANEL_W, opacity: 1 },
            exit: { width: 0, opacity: 0 },
        }

    return (
        <AnimatePresence initial={false}>
            {panel && (
                <motion.aside
                    key={compact ? 'sheet' : 'panel'}
                    className={`room-panel${compact ? ' is-sheet' : ''}`}
                    aria-label="Side panel"
                    initial={variants.initial}
                    animate={variants.animate}
                    exit={variants.exit}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                    <div className="room-panel-inner" key={panel}>
                        {panel === 'chat' && (
                            <ChatPanel onClose={onClose} disabled={chatDisabled} />
                        )}
                        {panel === 'participants' && (
                            <ParticipantsPanel
                                meetingId={meetingId}
                                isHost={isHost}
                                hostIdentity={hostIdentity}
                                onClose={onClose}
                                onPin={onPin}
                                pinned={pinned}
                            />
                        )}
                        {panel === 'transcript' && (
                            <div className="room-panel-col">
                                <div className="room-panel-head">
                                    <FileText size={15} />
                                    <span>Transcript</span>
                                    <button
                                        type="button"
                                        className="room-icon-btn"
                                        onClick={onClose}
                                        aria-label="Close transcript"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                                <div className="room-panel-body">
                                    <TranscriptPanel meetingId={meetingId} compact />
                                </div>
                            </div>
                        )}
                        {panel === 'briefing' && (
                            <div className="room-panel-col">
                                <BriefingPanel meetingId={meetingId} onClose={onClose} />
                            </div>
                        )}
                        {panel === 'agent' && (
                            <div className="room-panel-col">
                                <AgentPanel meetingId={meetingId} onClose={onClose} />
                            </div>
                        )}
                        {panel === 'translation' && (
                            <div className="room-panel-col">
                                <TranslationPanel meetingId={meetingId} onClose={onClose} />
                            </div>
                        )}
                        {panel === 'assistant' && (
                            <div className="room-panel-col room-panel-assistant">
                                <AssistantDock meetingId={meetingId} onClose={onClose} />
                            </div>
                        )}
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
    )
}
