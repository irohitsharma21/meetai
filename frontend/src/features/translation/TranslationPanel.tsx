import { useEffect, useRef, useState } from 'react'
import {
    AlertTriangle, ChevronDown, Info, Languages, RotateCcw, Volume2, VolumeX, X,
} from 'lucide-react'
import { errorMessage } from '../../lib/api'
import { useAuthStore, useToastStore } from '../../store'
import { languageLabel, useTranslationStore } from './store'
import { useLanguages } from './useLanguages'
import { LanguageSelect } from './LanguageSelect'
import type { TranslationItem, TranslationPrefsPatch } from './types'
import './translation.css'

function Switch({ checked, onChange, label, disabled, id }: {
    checked: boolean
    onChange: (v: boolean) => void
    label: string
    disabled?: boolean
    id?: string
}) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className="trl-switch"
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span className="trl-switch-knob" aria-hidden="true" />
        </button>
    )
}

function timeOf(iso: string): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function FeedLine({ item, sourceName }: { item: TranslationItem; sourceName: string }) {
    const [open, setOpen] = useState(false)
    return (
        <li className="trl-feed-item">
            <div className="trl-feed-top">
                <span className="trl-feed-who">{item.speaker_name || item.speaker}</span>
                <span className="trl-feed-time">{timeOf(item.created_at)}</span>
            </div>
            <p className="trl-feed-text">{item.text}</p>
            {item.original && (
                <>
                    <button
                        type="button"
                        className="trl-link"
                        onClick={() => setOpen((v) => !v)}
                        aria-expanded={open}
                    >
                        {open ? 'Hide original' : `Original${sourceName ? ` (${sourceName})` : ''}`}
                        <ChevronDown size={12} className={`trl-chev${open ? ' is-open' : ''}`} aria-hidden="true" />
                    </button>
                    {open && <p className="trl-feed-original" lang={item.source_language}>{item.original}</p>}
                </>
            )}
        </li>
    )
}

export interface TranslationPanelProps {
    meetingId: string
    onClose: () => void
}

/** Side panel: turn live translation on, pick languages, see who speaks what. */
export function TranslationPanel({ meetingId, onClose }: TranslationPanelProps) {
    const { byCode, tts } = useLanguages()
    const prefs = useTranslationStore((s) => s.prefs)
    const prefsError = useTranslationStore((s) => s.prefsError)
    const loadPrefs = useTranslationStore((s) => s.loadPrefs)
    const updatePrefs = useTranslationStore((s) => s.updatePrefs)
    const loadSpeakers = useTranslationStore((s) => s.loadSpeakers)
    const speakerLangs = useTranslationStore((s) => s.speakerLangs)
    const speakerNames = useTranslationStore((s) => s.speakerNames)
    const feed = useTranslationStore((s) => s.feed)
    const hint = useTranslationStore((s) => s.voiceHint)
    const me = useAuthStore((s) => s.user?.username)
    const addToast = useToastStore((s) => s.addToast)

    // Refresh the who-speaks-what snapshot whenever the panel opens.
    useEffect(() => { void loadSpeakers(meetingId) }, [meetingId, loadSpeakers])

    const save = async (patch: TranslationPrefsPatch) => {
        try {
            await updatePrefs(meetingId, patch)
        } catch (err) {
            addToast({ type: 'error', title: 'Could not save translation settings', message: errorMessage(err) })
        }
    }

    // Slider: move locally (and duck live), write to the server once it settles.
    const [vol, setVol] = useState<number | null>(null)
    const volTimer = useRef<number>()
    useEffect(() => () => window.clearTimeout(volTimer.current), [])
    const onVolume = (pct: number) => {
        setVol(pct)
        const v = pct / 100
        const cur = useTranslationStore.getState().prefs
        if (cur) useTranslationStore.setState({ prefs: { ...cur, original_volume: v } })
        window.clearTimeout(volTimer.current)
        volTimer.current = window.setTimeout(() => {
            setVol(null)
            void save({ original_volume: v })
        }, 350)
    }

    const volumePct = vol ?? Math.round((prefs?.original_volume ?? 0.2) * 100)
    const target = prefs?.target_language ?? null
    const enabled = !!prefs?.enabled
    const serverTts = tts?.server !== false

    const speakers = Object.keys({ ...speakerLangs })
        .map((u) => ({ username: u, name: speakerNames[u] || u, language: speakerLangs[u] }))
        .sort((a, b) => (a.username === me ? -1 : b.username === me ? 1 : a.name.localeCompare(b.name)))

    return (
        <>
            <div className="room-panel-head">
                <Languages size={16} color="var(--color-primary)" aria-hidden="true" />
                <span>Live translation</span>
                <button type="button" className="room-icon-btn" onClick={onClose} aria-label="Close translation panel">
                    <X size={16} />
                </button>
            </div>

            <div className="room-panel-body trl-panel">
                <div className="trl-panel-scroll">
                    {prefsError && !prefs && (
                        <div className="trl-note is-error" role="alert">
                            <AlertTriangle size={14} aria-hidden="true" />
                            <span>{prefsError}</span>
                            <button type="button" className="trl-link" onClick={() => void loadPrefs(meetingId)}>
                                <RotateCcw size={12} aria-hidden="true" /> Retry
                            </button>
                        </div>
                    )}

                    <section className="trl-section">
                        <div className="trl-setting">
                            <label className="trl-setting-text" htmlFor="trl-enable">
                                <span>Translate for me</span>
                                <span className="trl-setting-hint">
                                    Hear other languages in yours. Only you hear it.
                                </span>
                            </label>
                            <Switch
                                id="trl-enable"
                                checked={enabled}
                                onChange={(v) => void save({ enabled: v })}
                                label="Translate for me"
                                disabled={!prefs}
                            />
                        </div>

                        <div className="trl-field">
                            <label className="trl-field-label" htmlFor="trl-target">Translate into</label>
                            <LanguageSelect
                                id="trl-target"
                                value={target}
                                onChange={(c) => c && void save({ target_language: c })}
                                disabled={!prefs}
                                ariaLabel="Translate into"
                            />
                        </div>

                        <div className="trl-field">
                            <label className="trl-field-label" htmlFor="trl-spoken">I'm speaking</label>
                            <LanguageSelect
                                id="trl-spoken"
                                value={prefs?.spoken_language ?? null}
                                onChange={(c) => void save({ spoken_language: c })}
                                require="stt"
                                nullLabel={prefs
                                    ? `My language (${languageLabel(byCode.get(prefs.native_language), prefs.native_language)})`
                                    : 'My language'}
                                disabled={!prefs}
                                ariaLabel="I'm speaking"
                            />
                            <span className="trl-field-hint">So your words are transcribed in the right language.</span>
                        </div>

                        <div className="trl-setting">
                            <label className="trl-setting-text" htmlFor="trl-voice">
                                <span>Speak translations</span>
                                <span className="trl-setting-hint">Off: captions only.</span>
                            </label>
                            <Switch
                                id="trl-voice"
                                checked={prefs?.voice !== false}
                                onChange={(v) => void save({ voice: v })}
                                label="Speak translations"
                                disabled={!prefs}
                            />
                        </div>

                        <div className="trl-field">
                            <div className="trl-field-label-row">
                                <label className="trl-field-label" htmlFor="trl-vol">Original voice</label>
                                <span className="trl-vol-val">{volumePct}%</span>
                            </div>
                            <div className="trl-vol">
                                <VolumeX size={14} aria-hidden="true" />
                                <input
                                    id="trl-vol"
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={volumePct}
                                    onChange={(e) => onVolume(Number(e.target.value))}
                                    disabled={!prefs}
                                    aria-valuetext={`${volumePct}%`}
                                    style={{ ['--trl-fill' as string]: `${volumePct}%` }}
                                />
                                <Volume2 size={14} aria-hidden="true" />
                            </div>
                            <span className="trl-field-hint">
                                How loud people speaking another language stay while translating.
                            </span>
                        </div>

                        {!serverTts && (
                            <div className="trl-note">
                                <Info size={14} aria-hidden="true" />
                                <span>Using your browser's voice for translations.</span>
                            </div>
                        )}
                        {hint && (
                            <div className="trl-note is-warn">
                                <AlertTriangle size={14} aria-hidden="true" />
                                <span>{hint}</span>
                            </div>
                        )}
                    </section>

                    <section className="trl-section">
                        <h3 className="trl-section-title">Who speaks what</h3>
                        {speakers.length === 0 ? (
                            <p className="trl-empty">Languages show up here as people join and talk.</p>
                        ) : (
                            <ul className="trl-speakers">
                                {speakers.map((s) => {
                                    const lang = byCode.get(s.language)
                                    const translated = enabled && s.username !== me && !!target && s.language !== target
                                    return (
                                        <li key={s.username} className="trl-speaker">
                                            <span className="trl-avatar" aria-hidden="true">
                                                {(s.name.trim()[0] || '?').toUpperCase()}
                                            </span>
                                            <span className="trl-speaker-name">
                                                {s.name}{s.username === me && <span className="trl-you"> (you)</span>}
                                            </span>
                                            <span className={`trl-chip${translated ? ' is-on' : ''}`} title={translated ? 'Translated for you' : undefined}>
                                                {languageLabel(lang, s.language)}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                    </section>

                    <section className="trl-section">
                        <h3 className="trl-section-title">
                            Translated
                            {feed.length > 0 && <span className="trl-count">{feed.length}</span>}
                        </h3>
                        {feed.length === 0 ? (
                            <p className="trl-empty">
                                {enabled
                                    ? 'Translated lines will appear here as people speak.'
                                    : 'Turn on translation to see lines here.'}
                            </p>
                        ) : (
                            <ul className="trl-feed">
                                {feed.map((it) => (
                                    <FeedLine
                                        key={it.id}
                                        item={it}
                                        sourceName={byCode.get(it.source_language)?.name ?? ''}
                                    />
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
            </div>
        </>
    )
}
