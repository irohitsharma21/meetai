import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
    Calendar, LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen,
    Search, Video, KeyRound,
} from 'lucide-react'
import { useAuthStore } from '../../store'
import { ThemeToggle } from './ThemeToggle'

const RAIL_KEY = 'meetai.rail'

/** Read the persisted collapse state; defaults to expanded. */
export function readCollapsed(): boolean {
    try {
        return localStorage.getItem(RAIL_KEY) === 'collapsed'
    } catch {
        return false
    }
}

/**
 * Owns the rail's collapsed/expanded state and mirrors it onto the nearest
 * `.app-shell` (as `data-rail`) so the grid column and toast offset follow.
 */
export function useRailState() {
    const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)

    useEffect(() => {
        try {
            localStorage.setItem(RAIL_KEY, collapsed ? 'collapsed' : 'expanded')
        } catch {
            /* storage blocked; the session still works */
        }
        const shell = document.querySelector<HTMLElement>('.app-shell')
        if (shell) {
            if (collapsed) shell.setAttribute('data-rail', 'collapsed')
            else shell.removeAttribute('data-rail')
        }
    }, [collapsed])

    const toggle = useCallback(() => setCollapsed((c) => !c), [])
    return { collapsed, toggle }
}

/** Initials for an avatar: "Priya Sharma" → "PS", "arjun" → "A". */
export function initialsOf(name?: string | null): string {
    const parts = (name ?? '').trim().split(/[\s._-]+/).filter(Boolean)
    if (!parts.length) return 'U'
    if (parts.length === 1) return parts[0][0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Persistent left navigation rail.
 *
 * Icons with labels, collapsible to icons only. The choice is remembered per
 * browser. On narrow viewports it becomes a horizontal strip (see the 900px
 * breakpoint in index.css).
 */
export function Rail() {
    const { user, clearAuth } = useAuthStore()
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const { collapsed, toggle } = useRailState()

    const name = user?.display_name || user?.username || 'You'
    const initials = initialsOf(name)

    const items = [
        { to: '/dashboard', label: 'Home', icon: LayoutDashboard },
        { to: '/join', label: 'Join with a code', icon: KeyRound },
        { to: '/calendar', label: 'Calendar', icon: Calendar },
    ]

    const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`)

    return (
        <nav className="rail" aria-label="Primary" data-collapsed={collapsed ? 'true' : 'false'}>
            <div className="rail-head">
                <Link to="/dashboard" className="rail-brand" aria-label="MeetAI home">
                    <span className="rail-mark"><Video size={16} aria-hidden="true" /></span>
                    <span className="rail-brand-text">MeetAI</span>
                </Link>
                <button
                    type="button"
                    className="rail-toggle"
                    onClick={toggle}
                    aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Expand' : 'Collapse'}
                >
                    {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
                </button>
            </div>

            <div className="rail-nav">
                <div className="rail-label">Workspace</div>
                {items.map(({ to, label, icon: Icon }) => (
                    <Link
                        key={to}
                        to={to}
                        className="nav-item"
                        aria-current={isActive(to) ? 'page' : undefined}
                        title={collapsed ? label : undefined}
                    >
                        <Icon size={20} aria-hidden="true" />
                        <span className="nav-item-label">{label}</span>
                    </Link>
                ))}

                <div className="rail-label">Insights</div>
                <Link
                    to="/ask"
                    className="nav-item"
                    aria-current={isActive('/ask') ? 'page' : undefined}
                    title={collapsed ? 'Ask your meetings' : undefined}
                >
                    <Search size={20} aria-hidden="true" />
                    <span className="nav-item-label">Ask your meetings</span>
                </Link>
            </div>

            <div className="rail-footer">
                <div className="rail-appearance">
                    <span className="rail-appearance-label">Appearance</span>
                    <ThemeToggle />
                </div>

                <button
                    type="button"
                    className="user-chip"
                    onClick={() => {
                        clearAuth()
                        navigate('/login')
                    }}
                    title="Sign out"
                    aria-label={`Sign out ${name}`}
                >
                    <span className="avatar" aria-hidden="true">{initials}</span>
                    <span className="user-text">
                        <span className="user-name">{name}</span>
                        <span className="user-role">{user?.role}</span>
                    </span>
                    <LogOut size={16} color="var(--text-muted)" aria-hidden="true" />
                </button>
            </div>
        </nav>
    )
}
