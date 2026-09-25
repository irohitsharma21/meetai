import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
    Video, Eye, EyeOff, Lock, User, Mail, AlertCircle, ChevronDown,
    CalendarCheck, ListChecks, Captions, Loader2,
} from 'lucide-react'
import { authApi } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'
import { usePageTitle } from '../../components/common/usePageTitle'
import { LanguageSelect, guessBrowserLanguage, useLanguages } from '../../features/translation'

/**
 * Split-screen auth layout: brand panel on the left, form card on the right.
 * The panel collapses below 1080px, where the card is all that fits.
 */
function AuthShell({
    title,
    heading,
    sub,
    children,
}: {
    title: string
    heading: string
    sub: string
    children: React.ReactNode
}) {
    usePageTitle(title)
    return (
        <div className="auth-page">
            <aside className="auth-aside">
                <Link to="/" className="auth-brand-row" aria-label="MeetAI home">
                    <span className="rail-mark"><Video size={16} aria-hidden="true" /></span>
                    MeetAI
                </Link>

                <div>
                    <h1 className="auth-headline">Meetings that write their own minutes.</h1>
                    <p className="auth-sub">
                        MeetAI listens while you talk, catches every commitment as it is
                        made, and has the minutes written before anyone leaves the call.
                    </p>
                </div>

                <div className="auth-points">
                    <div className="auth-point">
                        <span className="auth-point-icon"><Captions size={16} aria-hidden="true" /></span>
                        <span><b>Live captions</b>Transcribed as it is spoken, attributed to the speaker.</span>
                    </div>
                    <div className="auth-point">
                        <span className="auth-point-icon"><ListChecks size={16} aria-hidden="true" /></span>
                        <span><b>Action items</b>Commitments and deadlines detected mid-sentence.</span>
                    </div>
                    <div className="auth-point">
                        <span className="auth-point-icon"><CalendarCheck size={16} aria-hidden="true" /></span>
                        <span><b>Calendar</b>Confirmed actions land in Google Calendar automatically.</span>
                    </div>
                </div>
            </aside>

            <main className="auth-main">
                <div className="auth-card">
                    <Link to="/" className="auth-brand-row auth-mobile-brand" aria-label="MeetAI home">
                        <span className="rail-mark"><Video size={16} aria-hidden="true" /></span>
                        MeetAI
                    </Link>
                    <h2>{heading}</h2>
                    <p className="auth-lead">{sub}</p>
                    {children}
                </div>
            </main>
        </div>
    )
}

function FieldError({ id, text }: { id: string; text?: string | null }) {
    if (!text) return null
    return (
        <span id={id} className="field-error" role="alert">
            <AlertCircle size={13} aria-hidden="true" /> {text}
        </span>
    )
}

function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
    return (
        <span className="field-affix">
            <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                onClick={onToggle}
                aria-label={shown ? 'Hide password' : 'Show password'}
                aria-pressed={shown}
            >
                {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
        </span>
    )
}

export function LoginPage() {
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [touched, setTouched] = useState<{ username?: boolean; password?: boolean }>({})
    const [formError, setFormError] = useState<string | null>(null)
    const { setAuth } = useAuthStore()
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const usernameError = touched.username && !username.trim() ? 'Enter your username.' : null
    const passwordError = touched.password && !password ? 'Enter your password.' : null

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setTouched({ username: true, password: true })
        setFormError(null)
        if (!username.trim() || !password) return
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
            setFormError(message)
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
        <AuthShell title="Sign in" heading="Sign in" sub="Use your MeetAI account to continue.">
            <form onSubmit={handleLogin} noValidate>
                {formError && (
                    <div className="notice-row" role="alert" style={{ borderColor: 'var(--color-danger-line)', background: 'var(--color-danger-soft)' }}>
                        <AlertCircle size={16} color="var(--color-danger)" aria-hidden="true" />
                        <span>{formError}</span>
                    </div>
                )}

                <div className="form-group">
                    <label className="label" htmlFor="login-username">Username</label>
                    <div className="field">
                        <span className="field-icon"><User size={16} aria-hidden="true" /></span>
                        <input
                            id="login-username"
                            className="input"
                            placeholder="your_username"
                            autoComplete="username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            onBlur={() => setTouched((t) => ({ ...t, username: true }))}
                            aria-invalid={!!usernameError}
                            aria-describedby={usernameError ? 'login-username-error' : undefined}
                            required
                            autoFocus
                        />
                    </div>
                    <FieldError id="login-username-error" text={usernameError} />
                </div>

                <div className="form-group">
                    <label className="label" htmlFor="login-password">Password</label>
                    <div className="field">
                        <span className="field-icon"><Lock size={16} aria-hidden="true" /></span>
                        <input
                            id="login-password"
                            className="input has-affix"
                            type={showPassword ? 'text' : 'password'}
                            placeholder="Your password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                            aria-invalid={!!passwordError}
                            aria-describedby={passwordError ? 'login-password-error' : undefined}
                            required
                        />
                        <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
                    </div>
                    <FieldError id="login-password-error" text={passwordError} />
                </div>

                <button
                    type="submit"
                    className="btn btn-primary btn-lg btn-block"
                    style={{ marginTop: '0.5rem' }}
                    disabled={isLoading}
                >
                    {isLoading ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Signing in…</> : 'Sign in'}
                </button>
            </form>

            <p className="auth-foot">
                New to MeetAI? <Link to="/register">Create an account</Link>
            </p>
        </AuthShell>
    )
}

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/

export function RegisterPage() {
    const [form, setForm] = useState({
        username: '', email: '', password: '', display_name: '', role: 'host',
        native_language: guessBrowserLanguage(),
    })
    const { languages } = useLanguages()
    // Once the catalogue arrives, snap the browser guess to a supported code
    // (unless the user has already picked one).
    const [langTouched, setLangTouched] = useState(false)
    useEffect(() => {
        if (langTouched || languages.length === 0) return
        const guess = guessBrowserLanguage(languages)
        setForm((f) => (f.native_language === guess ? f : { ...f, native_language: guess }))
    }, [languages, langTouched])
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [touched, setTouched] = useState<Partial<Record<keyof typeof form, boolean>>>({})
    const [formError, setFormError] = useState<string | null>(null)
    const { addToast } = useToastStore()
    const navigate = useNavigate()

    const errors = {
        username: !form.username.trim()
            ? 'Choose a username.'
            : form.username.length < 3
                ? 'At least 3 characters.'
                : !USERNAME_RE.test(form.username)
                    ? 'Letters, numbers, _ and - only.'
                    : null,
        email: !form.email.trim()
            ? 'Enter your email address.'
            : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
                ? 'That does not look like an email address.'
                : null,
        password: !form.password
            ? 'Choose a password.'
            : form.password.length < 8
                ? 'At least 8 characters.'
                : null,
    }
    const shown = (k: keyof typeof errors) => (touched[k] ? errors[k] : null)
    const valid = !errors.username && !errors.email && !errors.password

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault()
        setTouched({ username: true, email: true, password: true })
        setFormError(null)
        if (!valid) return
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
            setFormError(message)
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
    const blur = (k: keyof typeof form) => () => setTouched((t) => ({ ...t, [k]: true }))

    const passwordStrength = form.password.length >= 12 ? 3 : form.password.length >= 8 ? 2 : form.password.length > 0 ? 1 : 0

    return (
        <AuthShell title="Create account" heading="Create your account" sub="Start your first AI-assisted meeting in under a minute.">
            <form onSubmit={handleRegister} noValidate>
                {formError && (
                    <div className="notice-row" role="alert" style={{ borderColor: 'var(--color-danger-line)', background: 'var(--color-danger-soft)' }}>
                        <AlertCircle size={16} color="var(--color-danger)" aria-hidden="true" />
                        <span>{formError}</span>
                    </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1rem' }}>
                    <div className="form-group">
                        <label className="label" htmlFor="reg-username">Username</label>
                        <input
                            id="reg-username" className="input" placeholder="priya_s"
                            autoComplete="username"
                            value={form.username}
                            onChange={set('username')} onBlur={blur('username')}
                            aria-invalid={!!shown('username')}
                            aria-describedby={shown('username') ? 'reg-username-error' : 'reg-username-hint'}
                            required minLength={3}
                            // The hyphen must be escaped: browsers compile `pattern`
                            // with the `v` flag, under which a trailing `-` in a
                            // character class is a syntax error and the whole
                            // attribute is discarded, silently disabling validation.
                            pattern="[a-zA-Z0-9_\-]+"
                        />
                        {shown('username')
                            ? <FieldError id="reg-username-error" text={shown('username')} />
                            : <span id="reg-username-hint" className="field-hint">Letters, numbers, _ and -</span>}
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="reg-displayname">Display name</label>
                        <input
                            id="reg-displayname" className="input" placeholder="Priya Sharma"
                            autoComplete="name"
                            value={form.display_name} onChange={set('display_name')}
                        />
                        <span className="field-hint">Shown to other participants</span>
                    </div>
                </div>

                <div className="form-group">
                    <label className="label" htmlFor="reg-email">Email</label>
                    <div className="field">
                        <span className="field-icon"><Mail size={16} aria-hidden="true" /></span>
                        <input
                            id="reg-email" className="input" type="email" placeholder="priya@example.com"
                            autoComplete="email"
                            value={form.email} onChange={set('email')} onBlur={blur('email')}
                            aria-invalid={!!shown('email')}
                            aria-describedby={shown('email') ? 'reg-email-error' : undefined}
                            required
                        />
                    </div>
                    <FieldError id="reg-email-error" text={shown('email')} />
                </div>

                <div className="form-group">
                    <label className="label" htmlFor="reg-password">Password</label>
                    <div className="field">
                        <span className="field-icon"><Lock size={16} aria-hidden="true" /></span>
                        <input
                            id="reg-password" className="input has-affix"
                            type={showPassword ? 'text' : 'password'} placeholder="At least 8 characters"
                            autoComplete="new-password"
                            value={form.password} onChange={set('password')} onBlur={blur('password')}
                            aria-invalid={!!shown('password')}
                            aria-describedby={shown('password') ? 'reg-password-error' : 'reg-password-hint'}
                            required minLength={8}
                        />
                        <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
                    </div>
                    {shown('password')
                        ? <FieldError id="reg-password-error" text={shown('password')} />
                        : (
                            <span id="reg-password-hint" className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ display: 'inline-flex', gap: 3 }} aria-hidden="true">
                                    {[1, 2, 3].map((i) => (
                                        <i key={i} style={{
                                            width: 22, height: 4, borderRadius: 2,
                                            background: passwordStrength >= i
                                                ? (passwordStrength === 3 ? 'var(--color-success)' : passwordStrength === 2 ? 'var(--color-primary)' : 'var(--color-warning)')
                                                : 'var(--track-bg)',
                                        }} />
                                    ))}
                                </span>
                                {passwordStrength === 0 ? 'Use 8 or more characters' : passwordStrength === 1 ? 'Too short' : passwordStrength === 2 ? 'Good' : 'Strong'}
                            </span>
                        )}
                </div>

                <div className="form-group">
                    <label className="label" htmlFor="reg-language">Your language</label>
                    <LanguageSelect
                        id="reg-language"
                        value={form.native_language}
                        onChange={(c) => {
                            if (!c) return
                            setLangTouched(true)
                            setForm((f) => ({ ...f, native_language: c }))
                        }}
                        ariaLabel="Your language"
                    />
                    <span className="field-hint">
                        What you speak in meetings. Others who speak something else can hear you translated.
                    </span>
                </div>

                <div className="form-group">
                    <label className="label" htmlFor="reg-role">Role</label>
                    <div className="select-wrap">
                        <select id="reg-role" className="input" value={form.role} onChange={set('role')}>
                            <option value="host">Host — can create meetings</option>
                            <option value="participant">Participant — joins with a code</option>
                        </select>
                        <ChevronDown size={16} aria-hidden="true" />
                    </div>
                </div>

                <button type="submit" className="btn btn-primary btn-lg btn-block" style={{ marginTop: '0.5rem' }} disabled={isLoading}>
                    {isLoading ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Creating account…</> : 'Create account'}
                </button>
            </form>

            <p className="auth-foot">
                Already have an account? <Link to="/login">Sign in</Link>
            </p>
        </AuthShell>
    )
}
