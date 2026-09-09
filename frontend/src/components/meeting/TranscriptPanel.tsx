import { useEffect, useRef } from 'react'
import { MessageSquare, Download, Users, AlertTriangle } from 'lucide-react'
import { useMeetingRoomStore } from '../../store'
import type { TranscriptEntry } from '../../types'

// Speaker color palette (cycling)
const SPEAKER_COLORS = [
    '#60a5fa', '#34d399', '#f472b6', '#fb923c', '#a78bfa', '#facc15', '#38bdf8'
]
const speakerColorCache: Record<string, string> = {}
let colorIdx = 0

function getSpeakerColor(speaker: string): string {
    if (!speakerColorCache[speaker]) {
        speakerColorCache[speaker] = SPEAKER_COLORS[colorIdx % SPEAKER_COLORS.length]
        colorIdx++
    }
    return speakerColorCache[speaker]
}

function TranscriptEntryItem({ entry }: { entry: TranscriptEntry }) {
    const color = getSpeakerColor(entry.speaker)
    return (
        <div className="transcript-entry">
            <div className="transcript-speaker" style={{ color }}>
                {entry.speaker}
            </div>
            <div className="transcript-text">{entry.text}</div>
            <div className="transcript-time">{entry.time}</div>
        </div>
    )
}

interface TranscriptPanelProps {
    meetingId?: string
    entries?: TranscriptEntry[]
    compact?: boolean
}

export function TranscriptPanel({ meetingId, entries: externalEntries, compact }: TranscriptPanelProps) {
    const { transcript: storeTranscript, transcriptionStatus } = useMeetingRoomStore()
    const bottomRef = useRef<HTMLDivElement>(null)

    const entries = externalEntries || storeTranscript

    // Auto-scroll to bottom on new entry
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [entries.length])

    const handleExport = () => {
        if (!entries.length) return
        const lines = entries.map((e) => `[${e.time}] ${e.speaker}: ${e.text}`)
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `transcript-${meetingId || 'export'}.txt`
        a.click()
        URL.revokeObjectURL(url)
    }

    // Unique participants
    const participants = [...new Set(entries.map((e) => e.speaker))]

    // Only meaningful in a live room; a saved transcript passed in via props
    // has no live status attached.
    const sttBlocked = !externalEntries && transcriptionStatus?.available === false

    return (
        <div className="sidebar" style={compact ? { width: '100%', borderLeft: 'none', borderTop: '1px solid var(--color-border)' } : {}}>
            {/* Header */}
            <div style={{
                padding: '0.875rem 1rem',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--color-bg-elevated)',
                flexShrink: 0,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <MessageSquare size={16} color="var(--color-accent)" />
                    <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>Live Transcript</span>
                    <span style={{
                        fontSize: '0.6875rem', fontWeight: 600,
                        background: 'rgba(59,130,246,0.15)',
                        color: '#93c5fd',
                        padding: '0.1rem 0.5rem',
                        borderRadius: '999px',
                    }}>
                        {entries.length}
                    </span>
                </div>
                <button className="btn btn-ghost btn-icon-sm" onClick={handleExport} title="Export transcript">
                    <Download size={14} />
                </button>
            </div>

            {/* Speaker pills */}
            {participants.length > 0 && (
                <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--color-border)', display: 'flex', flexWrap: 'wrap', gap: '0.375rem', flexShrink: 0 }}>
                    {participants.map((p) => (
                        <span key={p} style={{
                            fontSize: '0.6875rem', fontWeight: 600,
                            background: `${getSpeakerColor(p)}18`,
                            color: getSpeakerColor(p),
                            border: `1px solid ${getSpeakerColor(p)}35`,
                            padding: '0.15rem 0.5rem',
                            borderRadius: '999px',
                            display: 'flex', alignItems: 'center', gap: '0.25rem',
                        }}>
                            <Users size={10} /> {p}
                        </span>
                    ))}
                </div>
            )}

            {/* Transcript entries */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {entries.length === 0 ? (
                    /*
                     * An empty panel has two very different causes: nobody has
                     * spoken yet, or speech-to-text cannot run at all. Only the
                     * server knows which, so it says, and the difference is shown
                     * here rather than left for the user to guess.
                     */
                    sttBlocked ? (
                        <div className="empty-state">
                            <AlertTriangle size={32} color="var(--color-warning)" style={{ opacity: 0.8 }} />
                            <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                Transcription is unavailable
                            </p>
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', maxWidth: '20rem' }}>
                                {transcriptionStatus?.reason}
                            </p>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '20rem' }}>
                                Video, chat and the meeting record are unaffected.
                            </p>
                        </div>
                    ) : (
                        <div className="empty-state">
                            <MessageSquare size={32} style={{ opacity: 0.3 }} />
                            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                Transcript will appear here as participants speak
                            </p>
                        </div>
                    )
                ) : (
                    entries.map((entry) => (
                        <TranscriptEntryItem key={entry.id} entry={entry} />
                    ))
                )}
                <div ref={bottomRef} />
            </div>
        </div>
    )
}
