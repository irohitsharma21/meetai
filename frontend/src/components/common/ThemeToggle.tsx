import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

/**
 * Appearance control.
 *
 * Three states — light, dark and system — rather than a binary flip, because
 * "follow the OS" is a real preference and a two-way toggle silently discards
 * it. The choice is persisted per app in localStorage under {@link STORAGE_KEY}.
 *
 * How the theme actually lands on the page:
 *
 *   · `light` / `dark`  → `data-theme` is stamped on <html>, and the matching
 *     token block in index.css wins.
 *   · `system`          → the attribute is *removed*, which hands the decision
 *     to `@media (prefers-color-scheme: dark)`. CSS then tracks the OS live,
 *     with no repaint work from React at all.
 *
 * The same decision is duplicated as a tiny inline script in index.html so the
 * attribute exists before first paint and there is no flash of the wrong theme.
 * If you change the storage key or the default here, change it there too.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

export const STORAGE_KEY = 'meetai.theme'
const DEFAULT_CHOICE: ThemeChoice = 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Colours for the browser UI (address bar on mobile, title bar on desktop). */
const META_THEME_COLOR: Record<'light' | 'dark', string> = {
    light: '#ffffff',
    dark: '#202124',
}

function prefersDark(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(DARK_QUERY).matches
}

export function readStoredChoice(): ThemeChoice {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
    } catch {
        /* private mode, blocked storage — fall through to the default */
    }
    return DEFAULT_CHOICE
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
    if (choice === 'system') return prefersDark() ? 'dark' : 'light'
    return choice
}

/**
 * Push a choice onto <html>. `system` deliberately clears the attribute so the
 * media query in index.css takes over.
 */
export function applyTheme(choice: ThemeChoice): void {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) meta.content = META_THEME_COLOR[resolveTheme(choice)]
}

/**
 * Owns the persisted choice and keeps the document in step with it.
 *
 * The matchMedia listener exists for the `system` case: CSS already re-resolves
 * itself, but the browser-chrome colour and any React consumer of `resolved`
 * would otherwise go stale when the OS flips theme mid-session.
 */
export function useTheme() {
    const [choice, setChoice] = useState<ThemeChoice>(readStoredChoice)
    const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(readStoredChoice()))
    const mounted = useRef(false)

    useEffect(() => {
        // Cross-fade the switch, but never the very first paint — and never
        // when the user has asked for reduced motion, since the blanket
        // transition rule in index.css carries !important.
        const animate = mounted.current
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        mounted.current = true

        let timer: number | undefined
        if (animate) {
            document.documentElement.classList.add('theme-transition')
            timer = window.setTimeout(
                () => document.documentElement.classList.remove('theme-transition'),
                240,
            )
        }

        applyTheme(choice)
        setResolved(resolveTheme(choice))
        try {
            localStorage.setItem(STORAGE_KEY, choice)
        } catch {
            /* nothing we can do; the session still themes correctly */
        }

        return () => {
            if (timer === undefined) return
            window.clearTimeout(timer)
            document.documentElement.classList.remove('theme-transition')
        }
    }, [choice])

    useEffect(() => {
        if (choice !== 'system') return
        const mql = window.matchMedia(DARK_QUERY)
        const onChange = () => {
            applyTheme('system')
            setResolved(mql.matches ? 'dark' : 'light')
        }
        mql.addEventListener('change', onChange)
        return () => mql.removeEventListener('change', onChange)
    }, [choice])

    return { choice, resolved, setChoice }
}

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'Match system', Icon: Monitor },
]

/**
 * Compact segmented control. Rendered as a radiogroup with roving arrow keys —
 * three separate tab stops for one setting is noise in the tab order.
 */
export function ThemeToggle({ className }: { className?: string }) {
    const { choice, resolved, setChoice } = useTheme()
    const index = OPTIONS.findIndex((o) => o.value === choice)

    const onKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
                    : 0
            if (!delta) return
            event.preventDefault()
            const next = OPTIONS[(index + delta + OPTIONS.length) % OPTIONS.length]
            setChoice(next.value)
            // Keep focus on the control that now owns the tab stop.
            const group = event.currentTarget
            requestAnimationFrame(() => {
                group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
            })
        },
        [index, setChoice],
    )

    return (
        <div
            className={className ? `theme-switch ${className}` : 'theme-switch'}
            role="radiogroup"
            aria-label="Appearance"
            onKeyDown={onKeyDown}
            style={{ '--theme-index': Math.max(index, 0) } as CSSProperties}
        >
            {OPTIONS.map(({ value, label, Icon }) => {
                const active = value === choice
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={
                            value === 'system' ? `Match system appearance (currently ${resolved})` : label
                        }
                        title={value === 'system' ? `Match system (${resolved})` : label}
                        tabIndex={active || (index === -1 && value === 'dark') ? 0 : -1}
                        className="theme-switch-btn"
                        onClick={() => setChoice(value)}
                    >
                        <Icon size={13} strokeWidth={2.1} aria-hidden="true" />
                    </button>
                )
            })}
        </div>
    )
}
