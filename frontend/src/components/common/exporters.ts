import type { Meeting, NextAction, TranscriptEntry } from '../../types'

/** "Q4 roadmap review: Part 2" → "q4-roadmap-review-part-2". */
export function slugify(title: string | undefined | null, fallback = 'meeting'): string {
    const s = (title ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
    return s || fallback
}

/** Trigger a browser download for in-memory text. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Copy text to the clipboard. Resolves false when the Clipboard API is
 * unavailable or refused (insecure origin, permissions), so the caller can
 * fall back to showing the text instead of failing silently.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        /* fall through to the legacy path */
    }
    try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return ok
    } catch {
        return false
    }
}

/** Normalise "MM:SS" / "H:MM:SS" / "HH:MM:SS" to "HH:MM:SS". */
export function normaliseTime(time: string | undefined): string {
    const parts = (time ?? '').split(':').map((p) => p.trim()).filter(Boolean)
    if (!parts.length || parts.some((p) => Number.isNaN(Number(p)))) return time ?? '00:00:00'
    while (parts.length < 3) parts.unshift('0')
    return parts.slice(-3).map((p) => p.padStart(2, '0')).join(':')
}

/** Plain-text transcript: one "[HH:MM:SS] Speaker: text" line per entry. */
export function transcriptToText(entries: TranscriptEntry[], header?: { title?: string; date?: string }): string {
    const lines: string[] = []
    if (header?.title) {
        lines.push(`Meeting: ${header.title}`)
        if (header.date) lines.push(`Date: ${header.date}`)
        lines.push('='.repeat(60), '')
    }
    for (const e of entries) lines.push(`[${normaliseTime(e.time)}] ${e.speaker || 'Unknown'}: ${e.text}`)
    return lines.join('\n')
}

export function transcriptToJson(meetingId: string | undefined, entries: TranscriptEntry[]): string {
    return JSON.stringify({ meeting_id: meetingId ?? null, transcript: entries }, null, 2)
}

function mdEscape(s: string | undefined | null): string {
    return (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** GitHub-flavoured Markdown table of action items. */
export function actionsToMarkdownTable(actions: NextAction[]): string {
    if (!actions.length) return '_No action items were detected._'
    const rows = actions.map((a) => [
        mdEscape(a.task),
        mdEscape(a.assignee || '—'),
        mdEscape(a.deadline || a.date || '—'),
        a.status,
        a.calendar_event_id ? 'Scheduled' : '—',
    ].join(' | '))
    return ['| Task | Owner | Due | Status | Calendar |', '| --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r} |`)].join('\n')
}

export function summaryToMarkdown(meeting: Meeting): string {
    const a = meeting.ai_analysis
    const parts = [`# ${meeting.title} — Summary`, '', a.summary ?? '_No summary yet._']
    if (a.keywords?.length) parts.push('', `**Keywords:** ${a.keywords.join(', ')}`)
    return parts.join('\n') + '\n'
}

export function minutesToMarkdown(meeting: Meeting): string {
    const mom = meeting.ai_analysis.mom ?? '_No minutes yet._'
    return `# ${meeting.title} — Minutes\n\n${mom.trim()}\n`
}

/** One Markdown document with everything the report page shows. */
export function reportToMarkdown(meeting: Meeting, opts?: { dateLabel?: string }): string {
    const a = meeting.ai_analysis
    const participants = meeting.participants
        .map((p) => p.display_name ? `${p.display_name} (${p.username})` : p.username)
    const duration = meeting.duration_seconds
        ? `${Math.floor(meeting.duration_seconds / 60)} min ${meeting.duration_seconds % 60} s`
        : 'n/a'
    const out: string[] = [
        `# ${meeting.title}`,
        '',
        `- **Date:** ${opts?.dateLabel ?? meeting.timestamp}`,
        `- **Duration:** ${duration}`,
        `- **Host:** ${meeting.created_by}`,
        `- **Participants:** ${participants.length ? participants.join(', ') : '—'}`,
        `- **Status:** ${meeting.status}`,
    ]
    if (meeting.join_code) out.push(`- **Code:** ${meeting.join_code}`)
    if (meeting.description) out.push('', meeting.description)

    out.push('', '## Summary', '', a.summary ?? '_No summary yet._')
    if (a.keywords?.length) out.push('', `**Keywords:** ${a.keywords.join(', ')}`)

    out.push('', '## Minutes', '', (a.mom ?? '_No minutes yet._').trim())

    out.push('', `## Action items (${a.next_actions.length})`, '', actionsToMarkdownTable(a.next_actions))

    if (a.sentiment) {
        out.push('', '## Sentiment', '',
            `**${a.sentiment.overall}** (${Math.round(a.sentiment.confidence * 100)}% confidence)`)
        if (a.sentiment.emotional_tone) out.push('', `_${a.sentiment.emotional_tone}_`)
        if (a.sentiment.key_shifts?.length) out.push('', ...a.sentiment.key_shifts.map((s) => `- ${s}`))
    }

    out.push('', `## Transcript (${meeting.transcript.length})`, '')
    if (meeting.transcript.length) {
        out.push('```text', transcriptToText(meeting.transcript), '```')
    } else {
        out.push('_No transcript was recorded._')
    }
    out.push('', `---`, `_Exported from MeetAI on ${new Date().toISOString().slice(0, 10)}._`, '')
    return out.join('\n')
}
