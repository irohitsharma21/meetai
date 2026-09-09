import { CalendarCheck } from 'lucide-react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Rail } from './components/common/Rail'
import { ToastContainer } from './components/common/Toast'
import { LoginPage, RegisterPage } from './pages/auth/AuthPages'
import { DashboardPage } from './pages/dashboard/DashboardPage'
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

/**
 * Application shell: fixed left rail, scrolling content column.
 *
 * `crumb` names the current section in the top bar so the page itself does
 * not have to repeat its own title twice.
 */
function Layout({ children, crumb }: { children: React.ReactNode; crumb?: string }) {
    return (
        <div className="app-shell">
            <Rail />
            <div className="main">
                <header className="topbar">
                    <span className="crumb">
                        MeetAI
                        {crumb && (
                            <>
                                <span className="crumb-sep"> / </span>
                                <span className="crumb-current">{crumb}</span>
                            </>
                        )}
                    </span>
                </header>
                <div className="content">{children}</div>
            </div>
        </div>
    )
}

// Full-screen layout (no navbar) for meeting room
function FullscreenLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>
}

export default function App() {
    return (
        <BrowserRouter>
            <ToastContainer />
            <Routes>
                {/* Auth routes */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />

                {/* Protected routes */}
                <Route path="/dashboard" element={
                    <ProtectedRoute>
                        <Layout crumb="Overview"><DashboardPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/meetings/:meetingId" element={
                    <ProtectedRoute>
                        <FullscreenLayout><MeetingRoomPage /></FullscreenLayout>
                    </ProtectedRoute>
                } />

                <Route path="/meetings/:meetingId/report" element={
                    <ProtectedRoute>
                        <Layout crumb="Report"><ReportPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/ask" element={
                    <ProtectedRoute>
                        <Layout crumb="Ask"><AskPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/calendar" element={
                    <ProtectedRoute>
                        <Layout crumb="Calendar"><CalendarPage /></Layout>
                    </ProtectedRoute>
                } />

                <Route path="/calendar/success" element={
                    <ProtectedRoute>
                        <Layout>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
                                <div className="empty-state-icon" style={{
                                    width: 52, height: 52,
                                    color: 'var(--color-success)',
                                    borderColor: 'rgba(63,185,80,0.3)',
                                    background: 'rgba(63,185,80,0.1)',
                                }}>
                                    <CalendarCheck size={24} />
                                </div>
                                <h2>Google Calendar connected</h2>
                                <p>Your calendar is now linked. AI-confirmed actions will be auto-scheduled.</p>
                                <a className="btn btn-primary" href="/dashboard">Back to Dashboard</a>
                            </div>
                        </Layout>
                    </ProtectedRoute>
                } />

                {/* Root redirect */}
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
        </BrowserRouter>
    )
}
