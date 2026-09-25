import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Search } from 'lucide-react'
import { useLanguages } from './useLanguages'
import { languageLabel } from './store'
import type { Language } from './types'
import './translation.css'

export interface LanguageSelectProps {
    value: string | null
    onChange: (code: string | null) => void
    /** Accessible name when there is no visible <label htmlFor>. */
    ariaLabel?: string
    /** Id for the trigger button, so a <label htmlFor> can point at it. */
    id?: string
    /** 'stt': languages that can't be transcribed are shown disabled. */
    require?: 'stt'
    /** Offer an explicit "no value" option at the top (e.g. "Same as my language"). */
    nullLabel?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    /** Visual variant for dark surfaces such as the stage. */
    className?: string
    placeholder?: string
}

type Option = { code: string | null; lang?: Language; disabled: boolean; label: string }

const POPUP_MAX_H = 300
const POPUP_MIN_W = 240

/**
 * Searchable, keyboard-friendly language picker: "தமிழ் · Tamil".
 * The list is portalled to <body> so it is never clipped by a scrolling
 * panel or the stage.
 */
export function LanguageSelect({
    value, onChange, ariaLabel, id, require, nullLabel, disabled, size = 'md', className, placeholder,
}: LanguageSelectProps) {
    const { languages, byCode, loading, error, reload, ready } = useLanguages()
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; above: boolean } | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLUListElement>(null)
    const uid = useId()
    const listId = `${uid}-list`

    const selected = value ? byCode.get(value) : undefined

    const options = useMemo<Option[]>(() => {
        const q = query.trim().toLowerCase()
        const out: Option[] = []
        if (nullLabel && !q) out.push({ code: null, disabled: false, label: nullLabel })
        for (const l of languages) {
            if (q) {
                const hay = `${l.name} ${l.native} ${l.code} ${l.locale}`.toLowerCase()
                if (!hay.includes(q)) continue
            }
            out.push({ code: l.code, lang: l, disabled: require === 'stt' && !l.stt, label: languageLabel(l) })
        }
        return out
    }, [languages, query, nullLabel, require])

    const place = useCallback(() => {
        const t = triggerRef.current
        if (!t) return
        const r = t.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        const below = vh - r.bottom - 8
        const above = r.top - 8
        const openAbove = below < 220 && above > below
        const maxH = Math.max(160, Math.min(POPUP_MAX_H + 52, openAbove ? above : below))
        const width = Math.min(Math.max(r.width, POPUP_MIN_W), vw - 16)
        const left = Math.min(Math.max(8, r.left), vw - width - 8)
        setPos({ left, top: openAbove ? r.top - 4 : r.bottom + 4, width, maxH, above: openAbove })
    }, [])

    const close = useCallback((focusTrigger = true) => {
        setOpen(false)
        setQuery('')
        if (focusTrigger) triggerRef.current?.focus()
    }, [])

    const openList = () => {
        if (disabled) return
        if (!ready && !loading) void reload()
        const idx = options.findIndex((o) => o.code === (value ?? null))
        setActive(idx >= 0 ? idx : 0)
        setOpen(true)
    }

    useLayoutEffect(() => {
        if (!open) return
        place()
        inputRef.current?.focus()
    }, [open, place])

    // Reposition while open; close when clicking elsewhere.
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node
            if (popupRef.current?.contains(t) || triggerRef.current?.contains(t)) return
            close(false)
        }
        const onMove = (e: Event) => {
            if (popupRef.current && e.target instanceof Node && popupRef.current.contains(e.target)) return
            place()
        }
        document.addEventListener('mousedown', onDown)
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
            document.removeEventListener('mousedown', onDown)
            window.removeEventListener('resize', onMove)
            window.removeEventListener('scroll', onMove, true)
        }
    }, [open, place, close])

    // Keep the active option in range and in view.
    useEffect(() => {
        if (!open) return
        if (active >= options.length) setActive(Math.max(0, options.length - 1))
        const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
        el?.scrollIntoView({ block: 'nearest' })
    }, [active, options.length, open])

    const choose = (o: Option | undefined) => {
        if (!o || o.disabled) return
        onChange(o.code)
        close()
    }

    const step = (from: number, dir: 1 | -1): number => {
        const n = options.length
        if (!n) return 0
        let i = from
        for (let k = 0; k < n; k++) {
            i = (i + dir + n) % n
            if (!options[i].disabled) return i
        }
        return from
    }

    const onKey = (e: ReactKeyboardEvent) => {
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); setActive((a) => step(a, 1)); break
            case 'ArrowUp': e.preventDefault(); setActive((a) => step(a, -1)); break
            case 'Home': e.preventDefault(); setActive(step(-1, 1)); break
            case 'End': e.preventDefault(); setActive(step(options.length, -1)); break
            case 'Enter': e.preventDefault(); choose(options[active]); break
            case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break
            case 'Tab': close(false); break
        }
    }

    const triggerText = value === null && nullLabel
        ? nullLabel
        : selected
            ? languageLabel(selected)
            : value
                ? value.toUpperCase()
                : placeholder ?? 'Choose a language'

    return (
        <>
            <button
                ref={triggerRef}
                id={id}
                type="button"
                className={`trl-select is-${size}${className ? ` ${className}` : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={ariaLabel ? `${ariaLabel}: ${triggerText}` : undefined}
                disabled={disabled}
                onClick={() => (open ? close() : openList())}
                onKeyDown={(e) => {
                    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                        e.preventDefault()
                        openList()
                    }
                }}
            >
                <span className={`trl-select-text${!selected && !(value === null && nullLabel) ? ' is-placeholder' : ''}`}>
                    {triggerText}
                </span>
                <ChevronDown size={size === 'sm' ? 14 : 16} className={`trl-select-chev${open ? ' is-open' : ''}`} aria-hidden="true" />
            </button>

            {open && pos && createPortal(
                <div
                    ref={popupRef}
                    className={`trl-pop${pos.above ? ' is-above' : ''}`}
                    style={{
                        left: pos.left,
                        width: pos.width,
                        maxHeight: pos.maxH,
                        ...(pos.above ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
                    }}
                    onKeyDown={onKey}
                >
                    <div className="trl-pop-search">
                        <Search size={14} aria-hidden="true" />
                        <input
                            ref={inputRef}
                            type="text"
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={listId}
                            aria-autocomplete="list"
                            aria-activedescendant={options[active] ? `${uid}-opt-${active}` : undefined}
                            aria-label="Search languages"
                            placeholder="Search languages"
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
                        />
                    </div>
                    <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel ?? 'Languages'} className="trl-pop-list">
                        {loading && !ready && (
                            <li className="trl-pop-empty"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading languages…</li>
                        )}
                        {error && !ready && (
                            <li className="trl-pop-empty">
                                {error}{' '}
                                <button type="button" className="trl-link" onClick={() => void reload()}>Retry</button>
                            </li>
                        )}
                        {ready && options.length === 0 && (
                            <li className="trl-pop-empty">No language matches “{query}”.</li>
                        )}
                        {options.map((o, i) => {
                            const isSel = o.code === (value ?? null)
                            return (
                                <li
                                    key={o.code ?? '__none'}
                                    id={`${uid}-opt-${i}`}
                                    data-idx={i}
                                    role="option"
                                    aria-selected={isSel}
                                    aria-disabled={o.disabled || undefined}
                                    className={`trl-opt${i === active ? ' is-active' : ''}${o.disabled ? ' is-disabled' : ''}${isSel ? ' is-selected' : ''}`}
                                    onMouseEnter={() => !o.disabled && setActive(i)}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => choose(o)}
                                >
                                    <span className="trl-opt-main">
                                        {o.lang ? (
                                            <>
                                                <span className="trl-opt-native">{o.lang.native || o.lang.name}</span>
                                                {o.lang.native && o.lang.native.toLowerCase() !== o.lang.name.toLowerCase() && (
                                                    <span className="trl-opt-name">{o.lang.name}</span>
                                                )}
                                            </>
                                        ) : (
                                            <span className="trl-opt-native">{o.label}</span>
                                        )}
                                        {o.disabled && <span className="trl-opt-hint">can't be transcribed yet</span>}
                                    </span>
                                    {isSel && <Check size={14} className="trl-opt-check" aria-hidden="true" />}
                                </li>
                            )
                        })}
                    </ul>
                </div>,
                document.body,
            )}
        </>
    )
}
