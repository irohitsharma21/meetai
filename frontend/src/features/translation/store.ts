import { create } from 'zustand'
import { errorMessage } from '../../lib/api'
import { translationApi } from './api'
import type {
    Language,
    TranslationItem,
    TranslationPrefs,
    TranslationPrefsPatch,
    TranslationSpeaker,
    TtsInfo,
} from './types'

/** Plenty for one meeting; stops a long call's feed growing without bound. */
const FEED_LIMIT = 150

interface TranslationState {
    // ── Language catalogue (global, fetched once) ──
    languages: Language[] | null
    tts: TtsInfo | null
    languagesLoading: boolean
    languagesError: string | null
    loadLanguages: (force?: boolean) => Promise<void>

    // ── Per-meeting state ──
    meetingId: string | null
    prefs: TranslationPrefs | null
    prefsError: string | null
    /** username → spoken language code */
    speakerLangs: Record<string, string>
    /** username → display name, from the speakers endpoint and translated items */
    speakerNames: Record<string, string>
    /** Translated lines, newest first. */
    feed: TranslationItem[]
    /** One-time notice, e.g. the browser has no voice for the target language. */
    voiceHint: string | null

    loadPrefs: (meetingId: string) => Promise<void>
    updatePrefs: (meetingId: string, patch: TranslationPrefsPatch) => Promise<TranslationPrefs | null>
    loadSpeakers: (meetingId: string) => Promise<void>
    setSpeakerLang: (username: string, language: string) => void
    addItem: (item: TranslationItem) => void
    setVoiceHint: (hint: string | null) => void
    resetMeeting: (meetingId: string | null) => void
}

let languagesPromise: Promise<void> | null = null
/** Only the newest prefs write may land; older responses are stale. */
let prefsSeq = 0

export const useTranslationStore = create<TranslationState>((set, get) => ({
    languages: null,
    tts: null,
    languagesLoading: false,
    languagesError: null,

    loadLanguages: (force = false) => {
        if (!force && get().languages) return Promise.resolve()
        if (!force && languagesPromise) return languagesPromise
        set({ languagesLoading: true, languagesError: null })
        languagesPromise = translationApi
            .languages()
            .then((data) => {
                set({
                    languages: Array.isArray(data?.languages) ? data.languages : [],
                    tts: data?.tts ?? { server: false, provider: 'browser' },
                    languagesLoading: false,
                })
            })
            .catch((err) => {
                set({ languagesLoading: false, languagesError: errorMessage(err, 'Could not load languages.') })
            })
            .finally(() => {
                languagesPromise = null
            })
        return languagesPromise
    },

    meetingId: null,
    prefs: null,
    prefsError: null,
    speakerLangs: {},
    speakerNames: {},
    feed: [],
    voiceHint: null,

    resetMeeting: (meetingId) =>
        set({
            meetingId,
            prefs: null,
            prefsError: null,
            speakerLangs: {},
            speakerNames: {},
            feed: [],
            voiceHint: null,
        }),

    loadPrefs: async (meetingId) => {
        const seq = ++prefsSeq
        try {
            const prefs = await translationApi.getPrefs(meetingId)
            if (seq !== prefsSeq || get().meetingId !== meetingId) return
            set({ prefs: normalizePrefs(prefs), prefsError: null })
        } catch (err) {
            if (get().meetingId !== meetingId) return
            set({ prefsError: errorMessage(err, 'Could not load translation settings.') })
        }
    },

    updatePrefs: async (meetingId, patch) => {
        const before = get().prefs
        // Optimistic: the toggle moves the instant it's clicked.
        if (before) set({ prefs: { ...before, ...patch } as TranslationPrefs })
        const seq = ++prefsSeq
        try {
            const next = normalizePrefs(await translationApi.putPrefs(meetingId, patch))
            if (seq === prefsSeq && get().meetingId === meetingId) set({ prefs: next, prefsError: null })
            return next
        } catch (err) {
            if (seq === prefsSeq && get().meetingId === meetingId) set({ prefs: before })
            throw err
        }
    },

    loadSpeakers: async (meetingId) => {
        try {
            const speakers: TranslationSpeaker[] = await translationApi.speakers(meetingId)
            if (get().meetingId !== meetingId) return
            set((s) => {
                const langs = { ...s.speakerLangs }
                const names = { ...s.speakerNames }
                for (const sp of speakers) {
                    if (!sp?.username) continue
                    // A live speaker_language event beats the snapshot.
                    if (sp.language && !(sp.username in s.speakerLangs)) langs[sp.username] = sp.language
                    if (sp.display_name) names[sp.username] = sp.display_name
                }
                return { speakerLangs: langs, speakerNames: names }
            })
        } catch { /* optional: the panel falls back to live events */ }
    },

    setSpeakerLang: (username, language) =>
        set((s) =>
            s.speakerLangs[username] === language
                ? s
                : { speakerLangs: { ...s.speakerLangs, [username]: language } },
        ),

    addItem: (item) =>
        set((s) => {
            if (s.feed.some((f) => f.id === item.id)) return s
            const names = item.speaker && item.speaker_name && s.speakerNames[item.speaker] !== item.speaker_name
                ? { ...s.speakerNames, [item.speaker]: item.speaker_name }
                : s.speakerNames
            return { feed: [item, ...s.feed].slice(0, FEED_LIMIT), speakerNames: names }
        }),

    setVoiceHint: (hint) => set({ voiceHint: hint }),
}))

function normalizePrefs(p: Partial<TranslationPrefs> | null | undefined): TranslationPrefs {
    const native = p?.native_language || 'en'
    const vol = typeof p?.original_volume === 'number' ? p.original_volume : 0.2
    return {
        spoken_language: p?.spoken_language ?? null,
        enabled: !!p?.enabled,
        target_language: p?.target_language || native,
        voice: p?.voice !== false,
        original_volume: Math.min(1, Math.max(0, vol)),
        declined: Array.isArray(p?.declined) ? p!.declined : [],
        native_language: native,
        effective_spoken_language: p?.effective_spoken_language || p?.spoken_language || native,
    }
}

/** Selector helper: code → Language. */
export function findLanguage(languages: Language[] | null, code: string | null | undefined): Language | undefined {
    if (!languages || !code) return undefined
    return languages.find((l) => l.code === code)
}

/** "தமிழ் · Tamil", or just the name when native and English are the same. */
export function languageLabel(lang: Language | undefined, fallbackCode?: string | null): string {
    if (!lang) return fallbackCode ? fallbackCode.toUpperCase() : ''
    if (!lang.native || lang.native.toLowerCase() === lang.name.toLowerCase()) return lang.name
    return `${lang.native} · ${lang.name}`
}
