import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
    Calendar, LayoutDashboard, LogOut, Sparkles, Video,
} from 'lucide-react'
import { useAuthStore } from '../../store'

/**
 * Persistent left navigation rail.
 *
 * Replaces the previous top navbar. A rail gives the product a fixed spine —
 * navigation, identity and account live in one column and never move — which
 * is what separates an application from a set of pages. On narrow viewports
 * it collapses into a horizontal strip (see the 900px breakpoint in index.css).
 */
export function Rail() {
    const { user, clearAuth } = useAuthStore()
    const navigate = useNavigate()
    const { pathname } = useLocation()

    const initial = (user?.display_name || user?.username || 'U')[0].toUpperCase()

    const items = [
        { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
        { to: '/calendar', label: 'Calendar', icon: Calendar },
    ]

    return (
        <nav className="rail" aria-label="Primary">
            <Link to="/dashboard" className="rail-brand">
                <span className="rail-mark"><Video size={15} /></span>
                MeetAI
            </Link>

            <div className="rail-label">Workspace</div>
            {items.map(({ to, label, icon: Icon }) => (
                <Link
                    key={to}
                    to={to}
                    className="nav-item"
                    aria-current={pathname.startsWith(to) ? 'page' : undefined}
                >
                    <Icon size={15} />
                    {label}
                </Link>
            ))}

            <div className="rail-label">Insights</div>
            <Link
                to="/ask"
                className="nav-item"
                aria-current={pathname.startsWith('/ask') ? 'page' : undefined}
            >
                <Sparkles size={15} />
                Ask your meetings
            </Link>

            <div className="rail-footer">
                <button
                    className="user-chip"
                    onClick={() => {
                        clearAuth()
                        navigate('/login')
                    }}
                    title="Sign out"
                >
                    <span className="avatar">{initial}</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="user-name" style={{ display: 'block' }}>
                            {user?.display_name || user?.username}
                        </span>
                        <span className="user-role">{user?.role}</span>
                    </span>
                    <LogOut size={14} color="var(--text-muted)" />
                </button>
            </div>
        </nav>
    )
}
