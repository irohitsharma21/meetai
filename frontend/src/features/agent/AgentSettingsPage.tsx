import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    AlertTriangle, Bot, Briefcase, Building2, Check, FileText, Globe, Linkedin, Loader2, Mail, MessageSquareQuote,
    Mic, NotebookPen, Phone, Plus, RotateCcw, Save, Send, Share2, Trash2, User, Contact,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'
import { usePageTitle } from '../../components/common/usePageTitle'
import { agentApi } from './api'
import { NativeLanguageCard } from '../translation'
import { CONTACT_FIELDS } from './types'
import type { AgentCapability, AgentProfile, AgentSnippet, ContactField, PermissionMode } from './types'
import './agent.css'

const MAX_SNIPPETS = 20
const SNIPPET_LABEL_MAX = 60
const SNIPPET_TEXT_MAX = 2000

const FIELD_ICONS: Record<ContactField, LucideIcon> = {
    full_name: User,
    email: Mail,
    phone: Phone,
    company: Building2,
    title: Briefcase,
    linkedin: Linkedin,
    website: Globe,
}

const TOOL_ICONS: Record<string, LucideIcon> = {
    share_contact: Contact,
    share_snippet: MessageSquareQuote,
    send_document: FileText,
    send_email: Send,
    add_note: NotebookPen,
}

const EXAMPLES = [
    'Hey MeetAI, send my contact details to Rohit',
    'Hey MeetAI, share the pricing snippet with everyone',
    'Hey MeetAI, email the deck to Priya',
    'Hey MeetAI, remind me to follow up on the budget',
]

const EMPTY_PROFILE: AgentProfile = {
    contact: { full_name: '', email: '', phone: '', company: '', title: '', linkedin: '', website: '' },
    share_fields: [],
    snippets: [],
    permissions: {},
}

/** Fill anything the server left out so the form is always fully controlled. */
function normalize(p: Partial<AgentProfile> | undefined): AgentProfile {
    return {
        contact: { ...EMPTY_PROFILE.contact, ...(p?.contact ?? {}) },
        share_fields: [...(p?.share_fields ?? [])],
        snippets: (p?.snippets ?? []).map((s) => ({ ...s })),
        permissions: { ...(p?.permissions ?? {}) },
    }
}

/** Comparable form of the editable parts (order-insensitive for share_fields). */
function fingerprint(p: AgentProfile): string {
    return JSON.stringify({
        contact: p.contact,
        share_fields: [...p.share_fields].sort(),
        snippets: p.snippets.map((s) => ({ id: s.id, label: s.label.trim(), text: s.text.trim() })),
        permissions: Object.keys(p.permissions).sort().map((k) => [k, p.permissions[k].enabled, p.permissions[k].mode]),
    })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+()\d\s.-]{6,24}$/
const URLISH_RE = /^(https?:\/\/)?[^\s/$.?#]+\.[^\s]+$/i

type Errors = Partial<Record<string, string>>

function validate(p: AgentProfile): Errors {
    const e: Errors = {}
    const c = p.contact
    if (c.email.trim() && !EMAIL_RE.test(c.email.trim())) e.email = 'Enter a valid email address.'
    if (c.phone.trim() && !PHONE_RE.test(c.phone.trim())) e.phone = 'Use digits, spaces and + ( ) - only.'
    if (c.linkedin.trim() && !URLISH_RE.test(c.linkedin.trim())) e.linkedin = 'Enter a link, e.g. linkedin.com/in/you.'
    if (c.website.trim() && !URLISH_RE.test(c.website.trim())) e.website = 'Enter a link, e.g. yourcompany.com.'
    if (c.full_name.length > 120) e.full_name = 'Keep it under 120 characters.'
    p.snippets.forEach((s) => {
        if (!s.label.trim()) e[`snippet:${s.id}:label`] = 'Give the snippet a name.'
        else if (s.label.length > SNIPPET_LABEL_MAX) e[`snippet:${s.id}:label`] = `Keep it under ${SNIPPET_LABEL_MAX} characters.`
        if (!s.text.trim()) e[`snippet:${s.id}:text`] = 'Add the text to share.'
        else if (s.text.length > SNIPPET_TEXT_MAX) e[`snippet:${s.id}:text`] = `Keep it under ${SNIPPET_TEXT_MAX} characters.`
    })
    const labels = new Map<string, string>()
    p.snippets.forEach((s) => {
        const k = s.label.trim().toLowerCase()
        if (!k) return
        if (labels.has(k)) e[`snippet:${s.id}:label`] = 'Another snippet already uses this name.'
        else labels.set(k, s.id)
    })
    return e
}

function newId(): string {
    try {
        return crypto.randomUUID().slice(0, 12)
    } catch {
        return Math.random().toString(36).slice(2, 14)
    }
}

function Switch({ checked, onChange, label, disabled }: {
    checked: boolean
    onChange: (v: boolean) => void
    label: string
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className="agt-switch"
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span className="agt-switch-knob" aria-hidden="true" />
        </button>
    )
}

export function AgentSettingsPage() {
    usePageTitle('Assistant')
    const { addToast } = useToastStore()
    const user = useAuthStore((s) => s.user)

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [capabilities, setCapabilities] = useState<AgentCapability[]>([])
    const [emailAvailable, setEmailAvailable] = useState(true)
    const [llmAvailable, setLlmAvailable] = useState(true)
    const [saved, setSaved] = useState<AgentProfile>(EMPTY_PROFILE)
    const [draft, setDraft] = useState<AgentProfile>(EMPTY_PROFILE)
    const [updatedAt, setUpdatedAt] = useState<string | undefined>()
    const [saving, setSaving] = useState(false)
    const [showErrors, setShowErrors] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
            const data = await agentApi.getProfile()
            const p = normalize(data.profile)
            // Pre-fill the obvious fields for a first-time setup; still needs a save.
            if (!data.profile?.updated_at && user) {
                if (!p.contact.full_name) p.contact.full_name = user.display_name || ''
                if (!p.contact.email) p.contact.email = user.email || ''
            }
            setSaved(normalize(data.profile))
            setDraft(p)
            setUpdatedAt(data.profile?.updated_at)
            setCapabilities(data.capabilities ?? [])
            setEmailAvailable(data.email_available !== false)
            setLlmAvailable(data.llm_available !== false)
        } catch (err) {
            setLoadError(errorMessage(err, 'Could not load your assistant settings.'))
        } finally {
            setLoading(false)
        }
    }, [user])

    useEffect(() => { void load() }, [load])

    const dirty = useMemo(() => fingerprint(draft) !== fingerprint(saved), [draft, saved])
    const errors = useMemo(() => validate(draft), [draft])
    const errorCount = Object.keys(errors).length
    const visibleErrors: Errors = showErrors ? errors : {}

    // Warn before leaving with unsaved edits.
    useEffect(() => {
        if (!dirty) return
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault()
            e.returnValue = ''
        }
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => window.removeEventListener('beforeunload', onBeforeUnload)
    }, [dirty])

    const setContact = (key: ContactField, value: string) =>
        setDraft((d) => ({ ...d, contact: { ...d.contact, [key]: value } }))

    const toggleShare = (key: ContactField, on: boolean) =>
        setDraft((d) => ({
            ...d,
            share_fields: on ? [...new Set([...d.share_fields, key])] : d.share_fields.filter((f) => f !== key),
        }))

    const updateSnippet = (id: string, patch: Partial<AgentSnippet>) =>
        setDraft((d) => ({ ...d, snippets: d.snippets.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))

    const addSnippet = () =>
        setDraft((d) =>
            d.snippets.length >= MAX_SNIPPETS ? d : { ...d, snippets: [...d.snippets, { id: newId(), label: '', text: '' }] },
        )

    const removeSnippet = (id: string) =>
        setDraft((d) => ({ ...d, snippets: d.snippets.filter((s) => s.id !== id) }))

    const permissionOf = (tool: string) => {
        const p = draft.permissions[tool] ?? { enabled: false, mode: 'confirm' as PermissionMode }
        return tool === 'send_email' ? { ...p, mode: 'confirm' as PermissionMode } : p
    }

    const setPermission = (tool: string, patch: Partial<{ enabled: boolean; mode: PermissionMode }>) =>
        setDraft((d) => {
            const cur = d.permissions[tool] ?? { enabled: false, mode: 'confirm' as PermissionMode }
            const next = { ...cur, ...patch }
            if (tool === 'send_email') next.mode = 'confirm'
            return { ...d, permissions: { ...d.permissions, [tool]: next } }
        })

    const discard = () => {
        setDraft(normalize(saved))
        setShowErrors(false)
    }

    const save = async () => {
        if (errorCount > 0) {
            setShowErrors(true)
            addToast({ type: 'warning', title: 'Check the highlighted fields', message: `${errorCount} ${errorCount === 1 ? 'thing needs' : 'things need'} fixing before saving.` })
            return
        }
        setSaving(true)
        try {
            const body: Omit<AgentProfile, 'updated_at'> = {
                contact: Object.fromEntries(
                    Object.entries(draft.contact).map(([k, v]) => [k, v.trim()]),
                ) as AgentProfile['contact'],
                share_fields: CONTACT_FIELDS.map((f) => f.key).filter((k) => draft.share_fields.includes(k)),
                snippets: draft.snippets.map((s) => ({ id: s.id, label: s.label.trim(), text: s.text.trim() })),
                permissions: Object.fromEntries(
                    capabilities.map((c) => [c.tool, permissionOf(c.tool)]),
                ),
            }
            // Keep permissions for tools the server knows about but didn't list.
            for (const [k, v] of Object.entries(draft.permissions)) if (!(k in body.permissions)) body.permissions[k] = v
            const profile = await agentApi.saveProfile(body)
            const next = normalize(profile ?? body)
            setSaved(next)
            setDraft(normalize(next))
            setUpdatedAt(profile?.updated_at ?? new Date().toISOString())
            setShowErrors(false)
            addToast({ type: 'success', title: 'Assistant settings saved' })
        } catch (err) {
            addToast({ type: 'error', title: 'Could not save', message: errorMessage(err) })
        } finally {
            setSaving(false)
        }
    }

    // Ctrl/Cmd+S saves.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                if (dirty && !saving) void save()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    const shared = CONTACT_FIELDS.filter((f) => draft.share_fields.includes(f.key) && draft.contact[f.key].trim())
    const sharedButEmpty = CONTACT_FIELDS.filter((f) => draft.share_fields.includes(f.key) && !draft.contact[f.key].trim())
    const enabledCount = capabilities.filter((c) => permissionOf(c.tool).enabled).length

    if (loading) {
        return (
            <div className="content-narrow agt-page" aria-busy="true">
                <div className="page-header">
                    <div>
                        <h1>Your assistant</h1>
                        <div className="page-subtitle">Loading your settings…</div>
                    </div>
                </div>
                {[0, 1, 2].map((i) => (
                    <div key={i} className="card agt-card" style={{ marginBottom: '1rem' }}>
                        <div className="skeleton skeleton-text" style={{ width: '30%', marginBottom: 16 }} />
                        <div className="skeleton" style={{ height: 96, borderRadius: 8 }} />
                    </div>
                ))}
            </div>
        )
    }

    if (loadError) {
        return (
            <div className="content-narrow agt-page">
                <div className="empty-state" style={{ minHeight: '50vh' }}>
                    <span className="empty-state-icon" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-text)' }}>
                        <AlertTriangle size={22} />
                    </span>
                    <div className="empty-title">Couldn't load your assistant</div>
                    <div className="empty-text">{loadError}</div>
                    <button className="btn btn-primary" onClick={() => void load()} style={{ marginTop: '0.5rem' }}>
                        <RotateCcw size={16} aria-hidden="true" /> Try again
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="content-narrow agt-page">
            <div className="page-header">
                <div>
                    <h1>Your assistant</h1>
                    <div className="page-subtitle">
                        It sits in your meetings and does only what you allow here — sharing your details, snippets and notes on request.
                    </div>
                </div>
                <div className="page-actions">
                    {updatedAt && !dirty && (
                        <span className="text-sm muted agt-saved-at">
                            <Check size={14} aria-hidden="true" /> Saved {new Date(updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                    )}
                    <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
                        {saving ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
                        {saving ? 'Saving…' : 'Save changes'}
                    </button>
                </div>
            </div>

            {!llmAvailable && (
                <div className="agt-banner" role="status">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>The language model isn't configured on the server, so the assistant may only understand simple, direct phrasing.</span>
                </div>
            )}

            {/* ── Your language (live translation) ─────────────────── */}
            <NativeLanguageCard />

            {/* ── Contact card ─────────────────────────────────────── */}
            <div className="section-title"><span>Your contact card</span></div>
            <div className="agt-contact-grid">
                <div className="card agt-card">
                    <p className="agt-help">
                        Fill in what you'd hand someone at the end of a call. Only fields marked <b>Shareable</b> are ever sent.
                    </p>
                    <div className="agt-fields">
                        {CONTACT_FIELDS.map((f) => {
                            const Icon = FIELD_ICONS[f.key]
                            const err = visibleErrors[f.key]
                            const on = draft.share_fields.includes(f.key)
                            const id = `agt-field-${f.key}`
                            return (
                                <div className="agt-field-row" key={f.key}>
                                    <div className="agt-field-main">
                                        <label className="label" htmlFor={id}>{f.label}</label>
                                        <div className="field">
                                            <span className="field-icon"><Icon size={16} aria-hidden="true" /></span>
                                            <input
                                                id={id}
                                                className="input"
                                                type={f.type === 'url' ? 'text' : f.type ?? 'text'}
                                                inputMode={f.type === 'url' ? 'url' : undefined}
                                                autoComplete={f.key === 'full_name' ? 'name' : f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : f.key === 'company' ? 'organization' : f.key === 'title' ? 'organization-title' : 'url'}
                                                placeholder={f.placeholder}
                                                value={draft.contact[f.key]}
                                                aria-invalid={err ? 'true' : undefined}
                                                aria-describedby={err ? `${id}-err` : undefined}
                                                onChange={(e) => setContact(f.key, e.target.value)}
                                            />
                                        </div>
                                        {err && <div className="field-error" id={`${id}-err`}><AlertTriangle size={12} aria-hidden="true" /> {err}</div>}
                                    </div>
                                    <label className="agt-share-toggle" title={on ? 'Your assistant may send this' : 'Never sent'}>
                                        <Switch checked={on} onChange={(v) => toggleShare(f.key, v)} label={`Share ${f.label}`} />
                                        <span>Shareable</span>
                                    </label>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <aside className="agt-preview-wrap" aria-label="What a recipient receives">
                    <div className="agt-preview-label"><Share2 size={14} aria-hidden="true" /> What they'll receive</div>
                    <div className="agt-preview">
                        {shared.length === 0 ? (
                            <div className="agt-preview-empty">
                                Nothing is shareable yet. Turn on <b>Shareable</b> for the fields you're happy to send.
                            </div>
                        ) : (
                            <>
                                <div className="agt-preview-head">
                                    <span className="agt-preview-avatar" aria-hidden="true">
                                        {(draft.contact.full_name.trim() && draft.share_fields.includes('full_name')
                                            ? draft.contact.full_name.trim()[0]
                                            : '?').toUpperCase()}
                                    </span>
                                    <div style={{ minWidth: 0 }}>
                                        <div className="agt-preview-name">
                                            {draft.share_fields.includes('full_name') && draft.contact.full_name.trim()
                                                ? draft.contact.full_name.trim()
                                                : 'Contact details'}
                                        </div>
                                        {(['title', 'company'] as ContactField[]).some((k) => draft.share_fields.includes(k) && draft.contact[k].trim()) && (
                                            <div className="agt-preview-sub">
                                                {(['title', 'company'] as ContactField[])
                                                    .filter((k) => draft.share_fields.includes(k) && draft.contact[k].trim())
                                                    .map((k) => draft.contact[k].trim())
                                                    .join(' · ')}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <ul className="agt-preview-list">
                                    {shared
                                        .filter((f) => !['full_name', 'title', 'company'].includes(f.key))
                                        .map((f) => {
                                            const Icon = FIELD_ICONS[f.key]
                                            return (
                                                <li key={f.key}>
                                                    <Icon size={14} aria-hidden="true" />
                                                    <span className="agt-preview-k">{f.label}</span>
                                                    <span className="agt-preview-v">{draft.contact[f.key].trim()}</span>
                                                </li>
                                            )
                                        })}
                                </ul>
                                <div className="agt-preview-foot">Sent by email from MeetAI on your behalf</div>
                            </>
                        )}
                    </div>
                    {sharedButEmpty.length > 0 && (
                        <div className="agt-hint-line">
                            {sharedButEmpty.map((f) => f.label).join(', ')} {sharedButEmpty.length === 1 ? 'is' : 'are'} marked shareable but empty, so {sharedButEmpty.length === 1 ? 'it' : 'they'} won't be sent.
                        </div>
                    )}
                </aside>
            </div>

            {/* ── Snippets ─────────────────────────────────────────── */}
            <div className="section-title" style={{ marginTop: '1.75rem' }}>
                <span>Snippets</span>
                <span className="text-sm muted">{draft.snippets.length} / {MAX_SNIPPETS}</span>
            </div>
            <div className="card agt-card">
                <p className="agt-help">
                    Short bits of text your assistant can share by name — a pricing link, your Calendly, a one-line bio.
                </p>
                {draft.snippets.length === 0 ? (
                    <div className="agt-snip-empty">
                        <MessageSquareQuote size={20} aria-hidden="true" />
                        <span>No snippets yet.</span>
                        <div className="agt-snip-suggest">
                            {[['Pricing link', 'https://'], ['Calendly', 'https://calendly.com/']].map(([label, text]) => (
                                <button
                                    key={label}
                                    type="button"
                                    className="chip agt-chip-btn"
                                    onClick={() => setDraft((d) => ({ ...d, snippets: [...d.snippets, { id: newId(), label, text }] }))}
                                >
                                    <Plus size={14} aria-hidden="true" /> {label}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="agt-snips">
                        {draft.snippets.map((s, i) => {
                            const le = visibleErrors[`snippet:${s.id}:label`]
                            const te = visibleErrors[`snippet:${s.id}:text`]
                            return (
                                <div className="agt-snip" key={s.id}>
                                    <div className="agt-snip-fields">
                                        <input
                                            className="input agt-snip-label"
                                            placeholder="Name, e.g. Pricing link"
                                            aria-label={`Snippet ${i + 1} name`}
                                            value={s.label}
                                            maxLength={SNIPPET_LABEL_MAX + 20}
                                            aria-invalid={le ? 'true' : undefined}
                                            onChange={(e) => updateSnippet(s.id, { label: e.target.value })}
                                        />
                                        {le && <div className="field-error"><AlertTriangle size={12} aria-hidden="true" /> {le}</div>}
                                        <textarea
                                            className="input agt-textarea"
                                            placeholder="What gets shared"
                                            aria-label={`Snippet ${i + 1} text`}
                                            rows={2}
                                            value={s.text}
                                            aria-invalid={te ? 'true' : undefined}
                                            onChange={(e) => updateSnippet(s.id, { text: e.target.value })}
                                        />
                                        {te && <div className="field-error"><AlertTriangle size={12} aria-hidden="true" /> {te}</div>}
                                    </div>
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-icon-sm"
                                        onClick={() => removeSnippet(s.id)}
                                        aria-label={`Remove snippet ${s.label || i + 1}`}
                                        title="Remove"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            )
                        })}
                    </div>
                )}
                <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={addSnippet}
                    disabled={draft.snippets.length >= MAX_SNIPPETS}
                    style={{ marginTop: '0.75rem' }}
                >
                    <Plus size={16} aria-hidden="true" /> Add snippet
                </button>
                {draft.snippets.length >= MAX_SNIPPETS && (
                    <span className="field-hint" style={{ marginLeft: '0.75rem' }}>You've reached the limit of {MAX_SNIPPETS}.</span>
                )}
            </div>

            {/* ── Permissions ──────────────────────────────────────── */}
            <div className="section-title" style={{ marginTop: '1.75rem' }}>
                <span>What your assistant may do</span>
                <span className="text-sm muted">{enabledCount} of {capabilities.length} on</span>
            </div>
            <div className="panel agt-caps">
                {capabilities.length === 0 && (
                    <div className="agt-help" style={{ padding: '1rem' }}>The server didn't report any capabilities.</div>
                )}
                {capabilities.map((c) => {
                    const perm = permissionOf(c.tool)
                    const Icon = TOOL_ICONS[c.tool] ?? Bot
                    const locked = c.tool === 'send_email'
                    const emailMissing = c.sends_email && !emailAvailable
                    return (
                        <div className="agt-cap" key={c.tool} data-on={perm.enabled ? 'true' : 'false'}>
                            <span className="agt-cap-icon" aria-hidden="true"><Icon size={18} /></span>
                            <div className="agt-cap-text">
                                <div className="agt-cap-title">
                                    {c.label}
                                    {emailMissing && (
                                        <span className="agt-warn-chip" title="Ask the server admin to configure SMTP">
                                            <AlertTriangle size={12} aria-hidden="true" /> Email isn't configured on the server
                                        </span>
                                    )}
                                </div>
                                <div className="agt-cap-desc">{c.description}</div>
                                {perm.enabled && (
                                    <div className="agt-cap-mode">
                                        <div className="segmented agt-seg" role="group" aria-label={`${c.label}: when to act`}>
                                            <button
                                                type="button"
                                                className="segment"
                                                aria-pressed={perm.mode === 'confirm'}
                                                onClick={() => setPermission(c.tool, { mode: 'confirm' })}
                                                disabled={locked}
                                            >
                                                Ask me first
                                            </button>
                                            <button
                                                type="button"
                                                className="segment"
                                                aria-pressed={perm.mode === 'auto'}
                                                onClick={() => setPermission(c.tool, { mode: 'auto' })}
                                                disabled={locked}
                                            >
                                                Just do it
                                            </button>
                                        </div>
                                        {locked ? (
                                            <span className="field-hint">Emails the assistant writes always wait for your approval.</span>
                                        ) : perm.mode === 'auto' ? (
                                            <span className="field-hint">Runs as soon as you ask — no confirmation.</span>
                                        ) : (
                                            <span className="field-hint">You'll approve each one in the call.</span>
                                        )}
                                    </div>
                                )}
                            </div>
                            <Switch
                                checked={perm.enabled}
                                onChange={(v) => setPermission(c.tool, { enabled: v })}
                                label={`Allow: ${c.label}`}
                            />
                        </div>
                    )
                })}
            </div>

            {/* ── How to use ───────────────────────────────────────── */}
            <div className="section-title" style={{ marginTop: '1.75rem' }}><span>How to use it</span></div>
            <div className="card agt-card">
                <p className="agt-help">
                    In a meeting, say <b>“Hey MeetAI”</b> followed by what you need, or type it in the <b>Assistant</b> panel.
                    Only you can direct your assistant, and only in meetings you're in.
                </p>
                <ul className="agt-examples">
                    {EXAMPLES.map((e) => (
                        <li key={e}><Mic size={14} aria-hidden="true" /> “{e}”</li>
                    ))}
                </ul>
            </div>

            {/* ── Sticky save bar ──────────────────────────────────── */}
            {dirty && (
                <div className="agt-savebar" role="region" aria-label="Unsaved changes">
                    <span className="agt-savebar-text">
                        {showErrors && errorCount > 0
                            ? `${errorCount} ${errorCount === 1 ? 'field needs' : 'fields need'} attention`
                            : 'You have unsaved changes'}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>Discard</button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
                        {saving ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                        Save
                    </button>
                </div>
            )}
        </div>
    )
}
