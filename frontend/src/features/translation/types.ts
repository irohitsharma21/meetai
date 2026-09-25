/** A language the server can translate into (and, when `stt`, transcribe). */
export interface Language {
    code: string
    /** English name, e.g. "Tamil". */
    name: string
    /** Endonym, e.g. "தமிழ்". */
    native: string
    /** BCP-47 locale for speech voices, e.g. "ta-IN". */
    locale: string
    /** False: can be a translation target but can't be transcribed yet. */
    stt: boolean
}

export interface TtsInfo {
    /** True when the server synthesises translated speech itself. */
    server: boolean
    provider: string
}

export interface LanguagesResponse {
    languages: Language[]
    tts: TtsInfo
}

export interface TranslationPrefs {
    /** What I speak in this meeting; null = use my native language. */
    spoken_language: string | null
    enabled: boolean
    target_language: string
    /** Speak translations aloud (false = captions only). */
    voice: boolean
    /** 0..1: how loud other-language speakers stay while translating. */
    original_volume: number
    /** Languages I said "Not now" to; no more offers for them. */
    declined: string[]
    native_language: string
    effective_spoken_language: string
}

export type TranslationPrefsPatch = Partial<Pick<
    TranslationPrefs,
    'spoken_language' | 'enabled' | 'target_language' | 'voice' | 'original_volume' | 'declined'
>>

export interface TranslationSpeaker {
    username: string
    display_name?: string
    language: string
}

export interface TranslationOfferData {
    speaker: string
    speaker_name: string
    language: string
    language_name: string
    target_language: string
    target_language_name: string
}

export interface TranslationItem {
    id: string
    speaker: string
    speaker_name: string
    source_language: string
    target_language: string
    original: string
    text: string
    created_at: string
}

export interface TranslationAudio {
    id: string
    target_language: string
    /** Base64-encoded clip. */
    audio: string
    mime_type: string
}
