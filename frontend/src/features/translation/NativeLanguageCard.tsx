import { useState } from 'react'
import { Check, Languages, Loader2 } from 'lucide-react'
import { authApi, errorMessage } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'
import { LanguageSelect } from './LanguageSelect'
import { useLanguages } from './useLanguages'
import './translation.css'

/**
 * "Your language" card for the settings page. Saves on change: it is a
 * single choice, so there is nothing to batch behind a Save button.
 */
export function NativeLanguageCard() {
    const user = useAuthStore((s) => s.user)
    const setUser = useAuthStore((s) => s.setUser)
    const addToast = useToastStore((s) => s.addToast)
    const { tts } = useLanguages()
    const [saving, setSaving] = useState(false)
    const [savedAt, setSavedAt] = useState<number | null>(null)

    const value = user?.native_language || 'en'

    const change = async (code: string | null) => {
        if (!code || code === value || !user) return
        setSaving(true)
        setSavedAt(null)
        const before = user
        setUser({ ...user, native_language: code })
        try {
            const res = await authApi.updateLanguage(code)
            if (res.data && typeof res.data === 'object' && 'username' in res.data) setUser(res.data)
            setSavedAt(Date.now())
        } catch (err) {
            setUser(before)
            addToast({ type: 'error', title: 'Could not change your language', message: errorMessage(err) })
        } finally {
            setSaving(false)
        }
    }

    return (
        <>
            <div className="section-title"><span>Your language</span></div>
            <div className="card agt-card trl-lang-card" style={{ marginBottom: '1.5rem' }}>
                <p className="agt-help" style={{ margin: 0 }}>
                    <Languages size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--accent-text)' }} />
                    What you speak in meetings. You're transcribed in it, and when someone speaks another
                    language MeetAI can translate them into it for you
                    {tts && !tts.server ? ' (spoken with your browser’s voice)' : ''}.
                </p>
                <div className="trl-lang-row">
                    <div className="trl-field">
                        <label className="trl-field-label" htmlFor="settings-native-language">I speak</label>
                        <LanguageSelect
                            id="settings-native-language"
                            value={value}
                            onChange={(c) => void change(c)}
                            disabled={!user || saving}
                            ariaLabel="Your language"
                        />
                    </div>
                    {saving && (
                        <span className="trl-lang-saved" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={14} className="spin" aria-hidden="true" /> Saving…
                        </span>
                    )}
                    {!saving && savedAt && (
                        <span className="trl-lang-saved" role="status">
                            <Check size={14} aria-hidden="true" /> Saved
                        </span>
                    )}
                </div>
            </div>
        </>
    )
}
