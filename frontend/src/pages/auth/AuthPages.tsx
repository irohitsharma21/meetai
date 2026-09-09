import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
    Video, Eye, EyeOff, Lock, User, Mail,
    CalendarCheck, ListChecks, Radio,
} from 'lucide-react'
import { authApi } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'

/**
 * Split-screen auth layout.
 *
 * A lone card centred in an empty viewport says nothing about the product.
 * The left panel carries the value proposition and gives the page a
 * composition; it collapses away below 1080px where the form is all that
 * fits anyway.
 */
function AuthShell({
    heading,
    sub,
    children,
}: {
    heading: string
    sub: string
    children: React.ReactNode
}) {
    return (
        <div className="auth-page">
            <aside className="auth-aside">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5625rem', position: 'relative' }}>
                    <span className="rail-mark"><Video size={15} /></span>
                    <span style={{ fontWeight: 600, letterSpacing: '-0.02em' }}>MeetAI</span>
                </div>

                <div>
                    <h1 className="auth-headline">The meeting is the easy part.</h1>
                    <p className="auth-sub">
                        MeetAI listens while you talk, catches every commitment as it is
                        made, and has the minutes written before anyone leaves the call.
                    </p>
                </div>

                <div className="auth-points">
                    <div className="auth-point">
                        <Radio size={15} />
                        <span>Live transcription with speaker attribution</span>
                    </div>
                    <div className="auth-point">
                        <ListChecks size={15} />
                        <span>Commitments and deadlines detected mid-sentence</span>
                    </div>
                    <div className="auth-point">
                        <CalendarCheck size={15} />
                        <span>Confirmed actions land in Google Calendar automatically</span>
                    </div>
                </div>
            </aside>

            <main className="auth-main">
                <div className="auth-form">
                    <h2 style={{ fontSize: '1.375rem', marginBottom: '0.3125rem' }}>{heading}</h2>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                        {sub}
                    </p>
                    {children}
                </div>
            </main>
        </div>
    )
}

export function LoginPage() {
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const { setAuth } = useAuthStore()
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        try {
            setIsLoading(true)
            const res = await authApi.login(username, password)
            const { access_token, refresh_token } = res.data

            // Store token FIRST so the interceptor can attach it to /auth/me
            localStorage.setItem('access_token', access_token)
            localStorage.setItem('refresh_token', refresh_token)

            // Now fetch user profile (interceptor will attach token)
            const meRes = await authApi.me()
            setAuth(meRes.data, access_token, refresh_token)
            addToast({ type: 'success', title: `Welcome back, ${meRes.data.display_name || username}!` })
            navigate('/dashboard')
        } catch (err: any) {
            localStorage.removeItem('access_token')
            localStorage.removeItem('refresh_token')
            const detail = err.response?.data?.detail
            const message = Array.isArray(detail)
                ? detail.map((d: any) => d.msg).join(', ')
                : (detail || 'Invalid credentials')
            addToast({
                type: 'error',
                title: 'Login failed',
                message,
            })
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <AuthShell heading="Welcome back" sub="Sign in to your MeetAI workspace.">
            <>
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div className="form-group">
                            <label className="label">Username</label>
                            <div style={{ position: 'relative' }}>
                                <User size={15} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                <input
                                    id="login-username"
                                    className="input"
                                    style={{ paddingLeft: '2.5rem' }}
                                    placeholder="your_username"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    required
                                    autoFocus
                                />
                            </div>
                        </div>

                        <div className="form-group">
                            <label className="label">Password</label>
                            <div style={{ position: 'relative' }}>
                                <Lock size={15} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                <input
                                    id="login-password"
                                    className="input"
                                    style={{ paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                                    type={showPassword ? 'text' : 'password'}
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                />
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-icon-sm"
                                    style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)' }}
                                    onClick={() => setShowPassword(!showPassword)}
                                >
                                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            </div>
                        </div>

                        <button
                            type="submit"
                            className="btn btn-primary btn-lg"
                            style={{ width: '100%', marginTop: '0.5rem' }}
                            disabled={isLoading}
                        >
                            {isLoading ? 'Signing in…' : 'Sign in'}
                        </button>
                    </form>

                    <div className="divider" style={{ marginTop: '1.25rem' }} />
                    <p style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                        Don't have an account?{' '}
                        <Link to="/register" style={{ color: 'var(--text-accent)', fontWeight: 500 }}>
                            Create one
                        </Link>
                    </p>
            </>
        </AuthShell>
    )
}

export function RegisterPage() {
    const [form, setForm] = useState({
        username: '', email: '', password: '', display_name: '', role: 'host'
    })
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault()
        try {
            setIsLoading(true)
            await authApi.register(form)
            addToast({ type: 'success', title: 'Account created!', message: 'Signing you in…' })
            // Auto-login after registration
            const loginRes = await authApi.login(form.username, form.password)
            const { access_token, refresh_token } = loginRes.data
            localStorage.setItem('access_token', access_token)
            localStorage.setItem('refresh_token', refresh_token)
            const meRes = await authApi.me()
            const { setAuth } = useAuthStore.getState()
            setAuth(meRes.data, access_token, refresh_token)
            navigate('/dashboard')
        } catch (err: any) {
            // FastAPI validation errors return detail as an array
            const detail = err.response?.data?.detail
            const message = Array.isArray(detail)
                ? detail.map((d: any) => `${d.loc?.slice(-1)[0]}: ${d.msg}`).join(', ')
                : (detail || 'Please try again')
            addToast({
                type: 'error',
                title: 'Registration failed',
                message,
            })
        } finally {
            setIsLoading(false)
        }
    }

    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setForm((f) => ({ ...f, [k]: e.target.value }))

    return (
        <AuthShell heading="Create your account" sub="Start your first AI-assisted meeting in under a minute.">
            <>
                <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                            <div className="form-group">
                                <label className="label">Username *</label>
                                <input id="reg-username" className="input" placeholder="johndoe" value={form.username}
                                    onChange={set('username')} required minLength={3}
                                    // The hyphen must be escaped: browsers compile `pattern`
                                    // with the `v` flag, under which a trailing `-` in a
                                    // character class is a syntax error and the whole
                                    // attribute is discarded, silently disabling validation.
                                    pattern="[a-zA-Z0-9_\-]+" />
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                    Letters, numbers, _ and - only (no spaces or @)
                                </span>
                            </div>
                            <div className="form-group">
                                <label className="label">Display Name</label>
                                <input id="reg-displayname" className="input" placeholder="John Doe" value={form.display_name} onChange={set('display_name')} />
                            </div>
                        </div>
                        <div className="form-group">
                            <label className="label">Email *</label>
                            <div style={{ position: 'relative' }}>
                                <Mail size={15} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                <input id="reg-email" className="input" style={{ paddingLeft: '2.5rem' }} type="email" placeholder="john@example.com"
                                    value={form.email} onChange={set('email')} required />
                            </div>
                        </div>
                        <div className="form-group">
                            <label className="label">Password *</label>
                            <div style={{ position: 'relative' }}>
                                <Lock size={15} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                <input id="reg-password" className="input" style={{ paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                                    type={showPassword ? 'text' : 'password'} placeholder="Min 8 characters"
                                    value={form.password} onChange={set('password')} required minLength={8} />
                                <button type="button" className="btn btn-ghost btn-icon-sm"
                                    style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)' }}
                                    onClick={() => setShowPassword(!showPassword)}>
                                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            </div>
                        </div>
                        <div className="form-group">
                            <label className="label">Role</label>
                            <select id="reg-role" className="input" value={form.role} onChange={set('role')}>
                                <option value="host">Host (can create meetings)</option>
                                <option value="participant">Participant</option>
                            </select>
                        </div>

                        <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: '0.5rem' }} disabled={isLoading}>
                            {isLoading ? 'Creating account…' : 'Create account'}
                        </button>
                    </form>

                    <div className="divider" style={{ marginTop: '1.25rem' }} />
                    <p style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                        Already have an account?{' '}
                        <Link to="/login" style={{ color: 'var(--text-accent)', fontWeight: 500 }}>Sign in</Link>
                    </p>
            </>
        </AuthShell>
    )
}
