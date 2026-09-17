import { useEffect, useRef } from 'react'
import { MessageSquare, Download, AlertTriangle } from 'lucide-react'
import { useMeetingRoomStore } from '../../store'
import type { TranscriptEntry } from '../../types'

/*
 * Speaker colours are CSS variables rather than literals so they can differ
 * per theme. The pastels that read well on a dark panel are close to
 * illegible on a white one, so index.css defines a darker set for light mode
 * under the same names.
 */
const SPEAKER_COLORS = [
    'var(--speaker-1)', 'var(--speaker-2)', 'var(--speaker-3)',
    'var(--speaker-4)', 'var(--speaker-5)', 'var(--speaker-6)',
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
            <span className="transcript-avatar" style={{ background: color }} aria-hidden="true">
                {entry.speaker[0]?.toUpperCase()}
            </span>
            <div className="transcript-line-head">
                <span className="transcript-speaker" style={{ color }}>{entry.speaker}</span>
                <span className="transcript-time">{entry.time}</span>
            </div>
            <div className="transcript-text">{entry.text}</div>
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
    const live = !externalEntries

    return (
        <div className="sidebar" style={compact ? { width: '100%', borderLeft: 'none', minHeight: 0 } : {}}>
            <div className="transcript-head">
                <div className="transcript-head-title">
                    <MessageSquare size={16} color="var(--accent-text)" aria-hidden="true" />
                    <span>{live ? 'Live transcript' : 'Transcript'}</span>
                    <span className="transcript-count" aria-label={`${entries.length} entries`}>{entries.length}</span>
                </div>
                <button
                    className="btn btn-ghost btn-icon-sm"
                    onClick={handleExport}
                    title="Export transcript"
                    aria-label="Export transcript as text"
                    disabled={!entries.length}
                >
                    <Download size={16} />
                </button>
            </div>

            {participants.length > 0 && (
                <div className="transcript-speakers" aria-label="Speakers">
                    {participants.map((p) => (
                        <span key={p} className="speaker-pill">
                            <i style={{ background: getSpeakerColor(p) }} aria-hidden="true" /> {p}
                        </span>
                    ))}
                </div>
            )}

            <div className="transcript-list">
                {entries.length === 0 ? (
                    /*
                     * An empty panel has two very different causes: nobody has
                     * spoken yet, or speech-to-text cannot run at all. Only the
                     * server knows which, so it says, and the difference is shown
                     * here rather than left for the user to guess.
                     */
                    sttBlocked ? (
                        <div className="empty-state">
                            <span className="empty-state-icon" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-text)' }}>
                                <AlertTriangle size={20} />
                            </span>
                            <div className="empty-title">Transcription is unavailable</div>
                            <div className="empty-text">{transcriptionStatus?.reason}</div>
                            <div className="text-xs muted">Video, chat and the meeting record are unaffected.</div>
                        </div>
                    ) : (
                        <div className="empty-state">
                            <span className="empty-state-icon"><MessageSquare size={20} /></span>
                            <div className="empty-title">{live ? 'Listening' : 'No transcript'}</div>
                            <div className="empty-text">
                                {live ? 'Captions appear here as people speak.' : 'Nothing was transcribed for this meeting.'}
                            </div>
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
