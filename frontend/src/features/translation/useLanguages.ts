import { useEffect, useMemo } from 'react'
import { useTranslationStore } from './store'
import type { Language } from './types'

/**
 * The language catalogue, fetched once per session and shared by every
 * picker (register, settings, room panel, offer card).
 */
export function useLanguages() {
    const languages = useTranslationStore((s) => s.languages)
    const tts = useTranslationStore((s) => s.tts)
    const loading = useTranslationStore((s) => s.languagesLoading)
    const error = useTranslationStore((s) => s.languagesError)
    const load = useTranslationStore((s) => s.loadLanguages)

    useEffect(() => {
        if (!languages) void load()
    }, [languages, load])

    const byCode = useMemo(() => {
        const m = new Map<string, Language>()
        for (const l of languages ?? []) m.set(l.code, l)
        return m
    }, [languages])

    return {
        languages: languages ?? [],
        ready: !!languages,
        tts,
        loading,
        error,
        byCode,
        reload: () => load(true),
    }
}
