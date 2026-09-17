import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowDown, MessageSquare, MessageSquareOff, Send, X } from 'lucide-react'
import { useChat, useLocalParticipant } from '@livekit/components-react'
import { usePanelsStore } from './panelsStore'
import type { ChatEntry } from './panelsStore'
import { formatClock, initials, linkify, speakerColor } from './utils'
import '../../../styles/panels.css'

interface ChatPanelProps {
    onClose: () => void
    disabled?: boolean
}

interface MessageGroup {
    key: string
    identity: string
    name: string
    isLocal: boolean
    start: number
    items: ChatEntry[]
}

const GROUP_WINDOW_MS = 5 * 60 * 1000
const QUICK_REPLIES = ['👍', '❤️', '😂', '🎉'] as const

function groupMessages(list: ChatEntry[]): MessageGroup[] {
    const groups: MessageGroup[] = []
    for (const m of list) {
        const last = groups[groups.length - 1]
        if (last && last.identity === m.identity && m.timestamp - last.items[last.items.length - 1].timestamp < GROUP_WINDOW_MS) {
            last.items.push(m)
        } else {
            groups.push({ key: m.id, identity: m.identity, name: m.name, isLocal: m.isLocal, start: m.timestamp, items: [m] })
        }
    }
    return groups
}

export function ChatPanel({ onClose, disabled = false }: ChatPanelProps): JSX.Element {
    const { chatMessages, send, isSending } = useChat()
    const { localParticipant } = useLocalParticipant()
    const chat = usePanelsStore((s) => s.chat)
    const ingestChat = usePanelsStore((s) => s.ingestChat)
    const setChatOpen = usePanelsStore((s) => s.setChatOpen)

    // Feed the shared store from this subscription too, so the panel works
    // even when nothing else in the tree calls useChatUnread.
    useEffect(() => {
        ingestChat(chatMessages, localParticipant.identity)
    }, [chatMessages, localParticipant.identity, ingestChat])

    useEffect(() => {
        setChatOpen(true)
        return () => setChatOpen(false)
    }, [setChatOpen])

    const groups = useMemo(() => groupMessages(chat), [chat])

    // ── Scroll management ─────────────────────────────────────────────
    const bodyRef = useRef<HTMLDivElement>(null)
    const atBottomRef = useRef(true)
    const lastCountRef = useRef(0)
    const [pendingNew, setPendingNew] = useState(0)

    const scrollToBottom = useCallback((smooth: boolean) => {
        const el = bodyRef.current
        if (!el) return
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
        atBottomRef.current = true
        setPendingNew(0)
    }, [])

    const onScroll = () => {
        const el = bodyRef.current
        if (!el) return
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        atBottomRef.current = distance < 48
        if (atBottomRef.current) setPendingNew(0)
    }

    useLayoutEffect(() => {
        const added = chat.length - lastCountRef.current
        const firstRender = lastCountRef.current === 0
        lastCountRef.current = chat.length
        if (added <= 0) return
        const lastIsLocal = chat[chat.length - 1]?.isLocal === true
        if (firstRender || atBottomRef.current || lastIsLocal) {
            scrollToBottom(!firstRender)
        } else {
            setPendingNew((n) => n + added)
        }
    }, [chat, scrollToBottom])

    // ── Composer ──────────────────────────────────────────────────────
    const [draft, setDraft] = useState('')
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    const autosize = useCallback(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    }, [])

    useEffect(() => {
        if (!disabled) textareaRef.current?.focus()
    }, [disabled])

    const sendText = useCallback(
        async (text: string) => {
            const trimmed = text.trim()
            if (!trimmed || disabled) return
            try {
                const msg = await send(trimmed)
                ingestChat([msg], localParticipant.identity)
            } catch (err) {
                console.warn('[chat] send failed', err)
                setDraft((d) => (d ? d : trimmed))
            }
        },
        [send, disabled, ingestChat, localParticipant.identity],
    )

    const submit = useCallback(async () => {
        if (isSending) return
        const text = draft
        setDraft('')
        requestAnimationFrame(autosize)
        await sendText(text)
    }, [draft, isSending, sendText, autosize])

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
        }
    }

    const canSend = draft.trim().length > 0 && !isSending && !disabled

    return (
        <div className="pnl" role="complementary" aria-label="In-call messages">
            <div className="pnl-header">
                <MessageSquare size={16} color="var(--color-primary)" />
                <span className="pnl-title">In-call messages</span>
                {chat.length > 0 && <span className="pnl-count">{chat.length}</span>}
                <button type="button" className="btn btn-ghost btn-icon-sm" onClick={onClose} aria-label="Close chat">
                    <X size={14} />
                </button>
            </div>

            <div className="pnl-body-wrap">
                <div className="pnl-body" ref={bodyRef} onScroll={onScroll}>
                    {chat.length === 0 ? (
                        <div className="pnl-empty">
                            <span className="pnl-empty-icon">
                                {disabled ? <MessageSquareOff size={20} /> : <MessageSquare size={20} />}
                            </span>
                            {disabled ? (
                                <p>Chat is turned off by the host</p>
                            ) : (
                                <p>Messages can only be seen by people in the call and are deleted when the call ends</p>
                            )}
                        </div>
                    ) : (
                        <div className="chat-list">
                            {groups.map((g) => (
                                <div key={g.key} className={`chat-group${g.isLocal ? ' is-local' : ''}`}>
                                    <div className="chat-group-head">
                                        <span className="chat-avatar" style={{ background: speakerColor(g.identity || g.name) }} aria-hidden="true">
                                            {initials(g.name)}
                                        </span>
                                        <span className={`chat-sender${g.isLocal ? ' is-local' : ''}`}>{g.isLocal ? 'You' : g.name}</span>
                                        <span className="chat-time">{formatClock(g.start)}</span>
                                    </div>
                                    {g.items.map((m) => (
                                        <div key={m.id} className="chat-bubble" title={formatClock(m.timestamp)}>
                                            {linkify(m.text)}
                                            {m.editTimestamp ? <span className="chat-edited">(edited)</span> : null}
                                        </div>
                                    ))}
                                </div>
                            ))}
                            <div className="chat-anchor" />
                        </div>
                    )}
                </div>

                {pendingNew > 0 && (
                    <button type="button" className="chat-newpill" onClick={() => scrollToBottom(true)}>
                        {pendingNew === 1 ? 'New message' : `${pendingNew} new messages`} <ArrowDown size={12} />
                    </button>
                )}
            </div>

            <div className="pnl-footer">
                {disabled ? (
                    <div className="chat-off">
                        <MessageSquareOff size={15} /> Chat is turned off by the host
                    </div>
                ) : (
                    <>
                        <div className="chat-quick" aria-label="Quick replies">
                            {QUICK_REPLIES.map((e) => (
                                <button
                                    key={e}
                                    type="button"
                                    className="chat-quick-btn"
                                    onClick={() => void sendText(e)}
                                    disabled={isSending}
                                    aria-label={`Send ${e}`}
                                >
                                    {e}
                                </button>
                            ))}
                        </div>
                        <div className="chat-composer">
                            <div className="chat-composer-box">
                                <textarea
                                    ref={textareaRef}
                                    className="chat-textarea"
                                    rows={1}
                                    value={draft}
                                    placeholder="Send a message to everyone"
                                    aria-label="Message"
                                    onChange={(e) => {
                                        setDraft(e.target.value)
                                        autosize()
                                    }}
                                    onKeyDown={onKeyDown}
                                />
                                <button
                                    type="button"
                                    className="chat-send"
                                    onClick={() => void submit()}
                                    disabled={!canSend}
                                    aria-label="Send message"
                                >
                                    <Send size={14} />
                                </button>
                            </div>
                            <div className="chat-hint">Enter to send · Shift+Enter for a new line</div>
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
