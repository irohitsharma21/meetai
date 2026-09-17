import { useEffect } from 'react'
import { useChat, useLocalParticipant } from '@livekit/components-react'
import { usePanelsStore } from './panelsStore'

/**
 * Unread-message counter for the chat button badge.
 *
 * This hook is meant to live in the always-mounted control bar. It keeps its
 * own `useChat()` subscription so messages that arrive while ChatPanel is
 * unmounted still land in the shared store; ChatPanel renders from that store,
 * which is what lets a late-opened panel show the full call history.
 */
export function useChatUnread(isOpen: boolean): { unread: number } {
    const { chatMessages } = useChat()
    const { localParticipant } = useLocalParticipant()
    const ingestChat = usePanelsStore((s) => s.ingestChat)
    const setChatOpen = usePanelsStore((s) => s.setChatOpen)
    const unread = usePanelsStore((s) => s.unread)

    useEffect(() => {
        setChatOpen(isOpen)
    }, [isOpen, setChatOpen])

    useEffect(() => {
        ingestChat(chatMessages, localParticipant.identity)
    }, [chatMessages, localParticipant.identity, ingestChat])

    return { unread }
}
