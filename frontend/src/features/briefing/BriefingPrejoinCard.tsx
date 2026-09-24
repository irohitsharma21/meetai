import { useEffect, useRef, useState } from 'react'
import { CircleCheck, LoaderCircle, NotebookPen, Upload } from 'lucide-react'
import { ACCEPT_ATTR } from './api'
import { useBriefingStore, useBriefingUploader } from './store'
import { UploadRow } from './BriefingPanel'
import './briefing.css'

export interface BriefingPrejoinCardProps {
    meetingId: string
}

/**
 * Compact "bring notes" card for the pre-join screen. Same upload flow and
 * store as the in-call Briefing panel, so documents added here are already
 * listed once the user joins.
 */
export function BriefingPrejoinCard({ meetingId }: BriefingPrejoinCardProps) {
    const load = useBriefingStore((s) => s.load)
    const loaded = useBriefingStore((s) => s.meetingId === meetingId && s.loaded)
    const { uploads, upload, dismissUpload, busy, docCount } = useBriefingUploader(meetingId)
    const inputRef = useRef<HTMLInputElement>(null)
    const [over, setOver] = useState(false)

    useEffect(() => {
        void load(meetingId)
    }, [load, meetingId])

    return (
        <div
            className={`brf-prejoin${over ? ' is-over' : ''}`}
            onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                if (!over) setOver(true)
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
            }}
            onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files)
            }}
        >
            <div className="brf-prejoin-row">
                <span className="brf-prejoin-icon" aria-hidden="true"><NotebookPen size={16} /></span>
                <div className="brf-prejoin-text">
                    <span className="brf-prejoin-title">Bring notes</span>
                    <span className="brf-prejoin-sub">
                        Upload a deck or doc and MeetAI will prompt you with answers during the call. Only you see them.
                    </span>
                </div>
            </div>
            <div className="brf-prejoin-row brf-prejoin-actions">
                <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => inputRef.current?.click()}
                >
                    {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
                    {docCount > 0 ? 'Add more' : 'Upload'}
                </button>
                <span className="brf-prejoin-count" aria-live="polite">
                    {docCount > 0 ? (
                        <><CircleCheck size={13} aria-hidden="true" /> {docCount} {docCount === 1 ? 'document' : 'documents'} ready</>
                    ) : loaded ? 'PDF, PPTX, DOCX, TXT, MD' : ''}
                </span>
                <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPT_ATTR}
                    multiple
                    hidden
                    onChange={(e) => {
                        if (e.target.files?.length) void upload(e.target.files)
                        e.target.value = ''
                    }}
                />
            </div>
            {uploads.length > 0 && (
                <ul className="brf-uploads brf-uploads-tight">
                    {uploads.map((u) => (
                        <UploadRow key={u.key} item={u} onDismiss={() => dismissUpload(u.key)} />
                    ))}
                </ul>
            )}
        </div>
    )
}
