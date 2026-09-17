import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { CalendarCheck, LogOut, Search, Settings2 } from 'lucide-react'
import { Rail, initialsOf, readCollapsed } from './components/common/Rail'
import { ThemeToggle } from './components/common/ThemeToggle'
import { ToastContainer } from './components/common/Toast'
import { usePageTitle } from './components/common/usePageTitle'
import { LandingPage } from './pages/landing/LandingPage'
import { LoginPage, RegisterPage } from './pages/auth/AuthPages'
import { DashboardPage } from './pages/dashboard/DashboardPage'
import { JoinPage } from './pages/join/JoinPage'
import { MeetingRoomPage } from './pages/meeting/MeetingRoomPage'
import { ReportPage } from './pages/report/ReportPage'
import { CalendarPage } from './pages/calendar/CalendarPage'
import { AskPage } from './pages/ask/AskPage'
import { useAuthStore } from './store'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { isAuthenticated } = useAuthStore()
    if (!isAuthenticated) return <Navigate to="/login" replace />
    return <>{children}</>
}

/** Signed-in visitors skip the marketing page. */
function RootRoute() {
    const { isAuthenticated } = useAuthStore()
    if (isAuthenticated) return <Navigate to="/dashboard" replace />
    return <LandingPage />
}

function FallbackRoute() {
    const { isAuthenticated } = useAuthStore()
    return <Navigate to={isAuthenticated ? '/dashboard' : '/'} replace />
}

/**
 * Account menu in the app bar: identity, appearance, sign out.
 * Closes on outside click and Escape; the trigger reports its expanded state.
 */
function UserMenu() {
    const { user, clearAuth } = useAuthStore()
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const name = user?.display_name || user?.username || 'You'

    return (
        <div className="user-menu" ref={ref}>
            <button
                type="button"
                className="user-menu-btn"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Account: ${name}`}
            >
                <span className="avatar" aria-hidden="true">{initialsOf(name)}</span>
            </button>

            {open && (
                <div className="menu" role="menu" aria-label="Account">
                    <div className="menu-head">
                        <span className="avatar avatar-lg" aria-hidden="true">{initialsOf(name)}</span>
                        <div style={{ minWidth: 0 }}>
                            <div className="menu-head-name">{name}</div>
                            <div className="menu-head-sub">{user?.email || user?.username}</div>
                            {user?.role && <span className="badge badge-gray badge-plain" style={{ marginTop: 4 }}>{user.role}</span>}
                        </div>
                    </div>
                    <div className="menu-row">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <Settings2 size={16} aria-hidden="true" /> Appearance
                        </span>
                        <ThemeToggle />
                    </div>
                    <div className="menu-sep" />
                    <button
                        type="button"
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false)
                            clearAuth()
                            navigate('/login')
                        }}
                    >
                        <LogOut size={18} aria-hidden="true" /> Sign out
                    </button>
                </div>
            )}
        </div>
    )
}

/**
 * Top app bar: page title, global meeting search, account menu.
 * Searching from any page lands on the dashboard with the query applied.
 */
function AppBar({ title }: { title?: string }) {
    const navigate = useNavigate()
    const location = useLocation()
    const [term, setTerm] = useState('')

    // Keep the box in step with the dashboard's own query when it is the
    // page being shown, so the two never disagree.
    useEffect(() => {
        if (location.pathname === '/dashboard') {
            setTerm(new URLSearchParams(location.search).get('q') ?? '')
        }
    }, [location.pathname, location.search])

    const submit = (e: FormEvent) => {
        e.preventDefault()
        const q = term.trim()
        navigate(q ? `/dashboard?q=${encodeURIComponent(q)}` : '/dashboard')
    }

    return (
        <header className="appbar">
            <div className="appbar-title">
                <span className="appbar-title-text">{title ?? 'MeetAI'}</span>
            </div>
            <form className="appbar-search" role="search" onSubmit={submit}>
                <Search size={18} aria-hidden="true" />
                <input
                    className="input"
                    type="search"
                    placeholder="Search meetings"
                    aria-label="Search meetings"
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                />
            </form>
            <div className="appbar-actions">
                <UserMenu />
            </div>
        </header>
    )
}

/**
 * Application shell: collapsible left rail, app bar, scrolling content.
 * `title` names the page in the bar and in the browser tab.
 */
function Layout({ children, title }: { children: React.ReactNode; title?: string }) {
    usePageTitle(title)
    return (
        <div className="app-shell" data-rail={readCollapsed() ? 'collapsed' : undefined}>
            <Rail />
            <div className="main">
                <AppBar title={title} />
                <div className="content">{children}</div>
            </div>
        </div>
    )
}

// Full-screen layout (no navbar) for meeting room
function FullscreenLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>
}

function CalendarConnected() {
    return (
        <div className="empty-state" style={{ minHeight: '60vh' }}>
            <span className="empty-state-icon" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-text)' }}>
                <CalendarCheck size={22} />
            </span>
            <div className="empty-title">Google Calendar connected</div>
            <div className="empty-text">Your calendar is linked. Confirmed actions will be scheduled automatically.</div>
            <a className="btn btn-primary" href="/dashboard" style={{ marginTop: '0.5rem' }}>Back to home</a>
        </div>
    )
}

export default function App() {
    return (
        <BrowserRouter>
            <ToastContainer />
            <Routes>
                {/* Public */}
                <Route path="/" element={<RootRoute />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />

                {/* Protected routes */}
                <Route path="/dashboard" element={
                    <ProtectedRoute>
                        <Layout title="Home"><DashboardPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/join" element={
                    <ProtectedRoute>
                        <JoinPage />
                    </ProtectedRoute>
                } />
                <Route path="/join/:code" element={
                    <ProtectedRoute>
                        <JoinPage />
                    </ProtectedRoute>
                } />

                <Route path="/meetings/:meetingId" element={
                    <ProtectedRoute>
                        <FullscreenLayout><MeetingRoomPage /></FullscreenLayout>
                    </ProtectedRoute>
                } />

                <Route path="/meetings/:meetingId/report" element={
                    <ProtectedRoute>
                        <Layout title="Report"><ReportPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/ask" element={
                    <ProtectedRoute>
                        <Layout title="Ask your meetings"><AskPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/calendar" element={
                    <ProtectedRoute>
                        <Layout title="Calendar"><CalendarPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/calendar/success" element={
                    <ProtectedRoute>
                        <Layout title="Calendar"><CalendarConnected /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="*" element={<FallbackRoute />} />
            </Routes>
        </BrowserRouter>
    )
}
