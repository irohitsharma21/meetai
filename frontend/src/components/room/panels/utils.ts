import type { ReactNode } from 'react'
import { createElement } from 'react'

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '🎉', '👏', '🙌', '🤔'] as const

export const REACTION_LABELS: Record<string, string> = {
    '👍': 'Thumbs up',
    '❤️': 'Heart',
    '😂': 'Laughing',
    '😮': 'Surprised',
    '🎉': 'Party',
    '👏': 'Clap',
    '🙌': 'Raised hands',
    '🤔': 'Thinking',
}

/** "Ada Lovelace" → "AL", "ada" → "A", "" → "?" */
export function initials(name: string): string {
    const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/*
 * Same cycling palette as TranscriptPanel: the colours are theme-aware custom
 * properties, and the cache keeps one person one colour for the whole call.
 */
const SPEAKER_COLORS = [
    'var(--speaker-1)', 'var(--speaker-2)', 'var(--speaker-3)',
    'var(--speaker-4)', 'var(--speaker-5)', 'var(--speaker-6)',
]
const colorCache = new Map<string, string>()

export function speakerColor(key: string): string {
    let c = colorCache.get(key)
    if (!c) {
        c = SPEAKER_COLORS[colorCache.size % SPEAKER_COLORS.length]
        colorCache.set(key, c)
    }
    return c
}

export function formatClock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const URL_RE = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?])/gi

/** Split text into plain strings and <a> elements for anything that looks like a URL. */
export function linkify(text: string): ReactNode[] {
    const out: ReactNode[] = []
    let last = 0
    let i = 0
    for (const match of text.matchAll(URL_RE)) {
        const start = match.index ?? 0
        const raw = match[0]
        if (start > last) out.push(text.slice(last, start))
        const href = raw.startsWith('www.') ? `https://${raw}` : raw
        out.push(
            createElement(
                'a',
                { key: `l${i++}`, href, target: '_blank', rel: 'noopener noreferrer', className: 'chat-link' },
                raw,
            ),
        )
        last = start + raw.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
}

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch {
        // Older browsers or a non-secure context: fall back to a hidden textarea.
        try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.setAttribute('readonly', '')
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            const ok = document.execCommand('copy')
            document.body.removeChild(ta)
            return ok
        } catch {
            return false
        }
    }
}

export function encodeJson(payload: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(payload))
}

export function decodeJson<T>(payload: Uint8Array): T | null {
    try {
        return JSON.parse(new TextDecoder().decode(payload)) as T
    } catch {
        return null
    }
}
