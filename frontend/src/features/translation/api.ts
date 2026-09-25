import api from '../../lib/api'
import type {
    LanguagesResponse,
    TranslationPrefs,
    TranslationPrefsPatch,
    TranslationSpeaker,
} from './types'

const base = (meetingId: string) => `/translation/${encodeURIComponent(meetingId)}`

export const translationApi = {
    /** Works without a meeting (used on the register and settings pages). */
    languages: () =>
        api.get<LanguagesResponse>('/translation/languages').then((r) => r.data),

    getPrefs: (meetingId: string) =>
        api.get<TranslationPrefs>(`${base(meetingId)}/prefs`).then((r) => r.data),

    putPrefs: (meetingId: string, patch: TranslationPrefsPatch) =>
        api.put<TranslationPrefs>(`${base(meetingId)}/prefs`, patch).then((r) => r.data),

    speakers: (meetingId: string) =>
        api
            .get<{ speakers: TranslationSpeaker[] }>(`${base(meetingId)}/speakers`)
            .then((r) => r.data?.speakers ?? []),
}

/** Best guess at the user's language from the browser, e.g. 'ta-IN' → 'ta'. */
export function guessBrowserLanguage(available?: { code: string }[], fallback = 'en'): string {
    const candidates: string[] = []
    try {
        const list = navigator.languages?.length ? navigator.languages : [navigator.language]
        for (const l of list) if (l) candidates.push(l)
    } catch { /* no navigator */ }
    for (const tag of candidates) {
        const lower = tag.toLowerCase()
        const prefix = lower.split('-')[0]
        if (!available || available.length === 0) return prefix || fallback
        const exact = available.find((a) => a.code.toLowerCase() === lower)
        if (exact) return exact.code
        const byPrefix = available.find((a) => a.code.toLowerCase() === prefix)
        if (byPrefix) return byPrefix.code
    }
    return fallback
}
