/*
 * Fan-out for meeting WebSocket messages that belong to a feature module
 * rather than to the room store (document cues, delegate-agent proposals).
 *
 * useMeetingWebSocket owns the one socket and emits every parsed message
 * here; features subscribe by type. This keeps the socket hook from having to
 * import every feature's store, and lets a feature mount and unmount its
 * listener with its own component.
 */

type Handler = (msg: any) => void

const handlers = new Map<string, Set<Handler>>()

export function onWsMessage(type: string, handler: Handler): () => void {
    let set = handlers.get(type)
    if (!set) {
        set = new Set()
        handlers.set(type, set)
    }
    set.add(handler)
    return () => {
        set!.delete(handler)
    }
}

export function emitWsMessage(msg: { type?: string }): void {
    if (!msg?.type) return
    handlers.get(msg.type)?.forEach((h) => {
        try {
            h(msg)
        } catch (e) {
            console.warn(`[wsBus] handler for ${msg.type} failed`, e)
        }
    })
}
