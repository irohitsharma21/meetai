import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, Download, Loader2 } from 'lucide-react'
import { useToastStore } from '../../store'
import { copyText, downloadText } from './exporters'

export interface DownloadOption {
    /** Menu label, e.g. "Download .txt". */
    label: string
    filename: string
    mime?: string
    /** Produces the file body; may be async (e.g. fetch from the server). */
    getText: () => string | Promise<string>
}

/**
 * Small Copy / Download toolbar for a text section.
 *
 * Copy shows a brief tick; when the clipboard is unavailable the text is
 * surfaced in a toast so nothing is silently lost. One download option
 * renders as a plain button; several render as a menu.
 */
export function SectionTools({
    label,
    getText,
    downloads,
    size = 'sm',
    className,
}: {
    /** What is being copied, for aria-labels and toasts (e.g. "summary"). */
    label: string
    /** Text for the clipboard; null/empty disables Copy. */
    getText: () => string | null | undefined
    downloads: DownloadOption[]
    size?: 'sm' | 'md'
    className?: string
}) {
    const { addToast } = useToastStore()
    const [copied, setCopied] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!copied) return
        const t = window.setTimeout(() => setCopied(false), 1600)
        return () => window.clearTimeout(t)
    }, [copied])

    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const text = getText()
    const canCopy = !!(text && text.trim())
    const btn = `btn btn-ghost ${size === 'sm' ? 'btn-sm' : ''}`

    const onCopy = async () => {
        if (!text) return
        const ok = await copyText(text)
        if (ok) {
            setCopied(true)
        } else {
            addToast({
                type: 'warning',
                title: 'Clipboard unavailable',
                message: `Your browser blocked copying. Use Download to save the ${label} instead.`,
            })
        }
    }

    const onDownload = async (opt: DownloadOption) => {
        setOpen(false)
        setBusy(opt.filename)
        try {
            const body = await opt.getText()
            downloadText(opt.filename, body, opt.mime ?? (opt.filename.endsWith('.json') ? 'application/json' : opt.filename.endsWith('.md') ? 'text/markdown' : 'text/plain'))
        } catch {
            addToast({ type: 'error', title: 'Download failed', message: `Could not prepare the ${label}.` })
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className={className ? `section-tools ${className}` : 'section-tools'} role="group" aria-label={`${label} tools`}>
            <button
                type="button"
                className={btn}
                onClick={onCopy}
                disabled={!canCopy}
                aria-label={copied ? `${label} copied` : `Copy ${label}`}
                title={`Copy ${label}`}
                data-copied={copied || undefined}
            >
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
            </button>

            {downloads.length === 1 ? (
                <button
                    type="button"
                    className={btn}
                    onClick={() => onDownload(downloads[0])}
                    disabled={!!busy}
                    aria-label={`Download ${label} (${downloads[0].filename})`}
                    title={downloads[0].filename}
                >
                    {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                    Download
                </button>
            ) : downloads.length > 1 ? (
                <div className="user-menu" ref={menuRef}>
                    <button
                        type="button"
                        className={btn}
                        onClick={() => setOpen((v) => !v)}
                        disabled={!!busy}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        aria-label={`Download ${label}`}
                    >
                        {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                        Download <ChevronDown size={13} aria-hidden="true" />
                    </button>
                    {open && (
                        <div className="menu menu-compact" role="menu" aria-label={`Download ${label} as`}>
                            {downloads.map((opt) => (
                                <button key={opt.filename} type="button" className="menu-item" role="menuitem" onClick={() => onDownload(opt)}>
                                    <Download size={16} aria-hidden="true" />
                                    <span style={{ flex: 1 }}>{opt.label}</span>
                                    <span className="text-xs muted">{opt.filename.slice(opt.filename.lastIndexOf('.'))}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    )
}
