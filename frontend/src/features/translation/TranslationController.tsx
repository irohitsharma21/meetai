import { useEffect, useRef } from 'react'
import { useRemoteParticipants } from '@livekit/components-react'
import { onWsMessage } from '../../lib/wsBus'
import { useAuthStore } from '../../store'
import { findLanguage, useTranslationStore } from './store'
import type { TranslationAudio, TranslationItem } from './types'

/** Wait this long for server audio before speaking with the browser voice. */
const AUDIO_WAIT_MS = 12_000
/** A line older than this (since it arrived) is not worth saying any more. */
const STALE_MS = 25_000

type JobKind = 'audio' | 'speech'

interface Entry {
    id: string
    item?: TranslationItem
    audio?: TranslationAudio
    arrivedAt: number
    /** How this line will be (or was) voiced. undefined = still deciding. */
    claim?: JobKind | 'skip'
    started: boolean
    timer?: number
}

function isItem(v: any): v is TranslationItem {
    return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.text === 'string'
}
function isAudio(v: any): v is TranslationAudio {
    return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.audio === 'string'
}

function base64ToBlob(b64: string, mime: string): Blob {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'audio/mpeg' })
}

function pickVoice(locale: string | undefined, code: string): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
    const voices = window.speechSynthesis.getVoices()
    if (!voices.length) return null
    const norm = (s: string) => s.toLowerCase().replace('_', '-')
    const loc = locale ? norm(locale) : ''
    const prefix = (loc.split('-')[0] || code).toLowerCase()
    return (
        (loc && voices.find((v) => norm(v.lang) === loc)) ||
        voices.find((v) => norm(v.lang).split('-')[0] === prefix) ||
        null
    )
}

export interface TranslationControllerProps {
    meetingId: string
}

/**
 * Headless. Mounted inside <LiveKitRoom> for the whole call: loads prefs,
 * listens for translated lines/audio and speaker languages, voices the
 * translations one at a time, and turns down the original voices of people
 * speaking a language other than the one being translated into.
 */
export function TranslationController({ meetingId }: TranslationControllerProps) {
    const resetMeeting = useTranslationStore((s) => s.resetMeeting)
    const loadPrefs = useTranslationStore((s) => s.loadPrefs)
    const loadSpeakers = useTranslationStore((s) => s.loadSpeakers)
    const loadLanguages = useTranslationStore((s) => s.loadLanguages)
    const setSpeakerLang = useTranslationStore((s) => s.setSpeakerLang)
    const addItem = useTranslationStore((s) => s.addItem)
    const prefs = useTranslationStore((s) => s.prefs)
    const tts = useTranslationStore((s) => s.tts)
    const speakerLangs = useTranslationStore((s) => s.speakerLangs)
    const me = useAuthStore((s) => s.user?.username)

    // ── Lifecycle ──
    useEffect(() => {
        resetMeeting(meetingId)
        void loadLanguages()
        void loadPrefs(meetingId)
        void loadSpeakers(meetingId)
        return () => resetMeeting(null)
    }, [meetingId, resetMeeting, loadLanguages, loadPrefs, loadSpeakers])

    // Latest settings for the (stable) socket handlers.
    const live = useRef({ prefs, tts, me })
    live.current = { prefs, tts, me }

    // ── Playback engine ──
    const entries = useRef(new Map<string, Entry>())
    const queue = useRef<string[]>([])
    const playing = useRef<{ id: string; stop: () => void } | null>(null)
    const hinted = useRef(new Set<string>())

    const engine = useRef({
        wantVoice(): boolean {
            const p = live.current.prefs
            return !!p && p.enabled && p.voice
        },
        enqueue(id: string) {
            if (!queue.current.includes(id)) queue.current.push(id)
            engine.current.pump()
        },
        stopAll() {
            for (const e of entries.current.values()) window.clearTimeout(e.timer)
            entries.current.clear()
            queue.current = []
            const cur = playing.current
            playing.current = null
            cur?.stop()
            try { window.speechSynthesis?.cancel() } catch { /* unsupported */ }
        },
        /**
         * Voice the oldest line that is ready. Lines still waiting for their
         * server clip keep their place but don't block later ready lines.
         */
        pump() {
            if (playing.current) return
            for (;;) {
                const now = Date.now()
                queue.current = queue.current.filter((id) => {
                    const e = entries.current.get(id)
                    if (!e || e.started || e.claim === 'skip') return false
                    if (now - e.arrivedAt > STALE_MS) {
                        e.claim = 'skip'
                        window.clearTimeout(e.timer)
                        return false
                    }
                    return true
                })
                if (!engine.current.wantVoice()) {
                    queue.current = []
                    return
                }
                const idx = queue.current.findIndex((id) => !!entries.current.get(id)?.claim)
                if (idx < 0) return
                const [id] = queue.current.splice(idx, 1)
                const e = entries.current.get(id)!
                const ok = e.claim === 'audio' && e.audio
                    ? engine.current.playAudio(e)
                    : e.claim === 'speech' && e.item
                        ? engine.current.speak(e)
                        : false
                if (ok) return
                if (!e.started) e.claim = 'skip'
            }
        },
        finish(id: string) {
            if (playing.current?.id !== id) return
            playing.current = null
            const e = entries.current.get(id)
            if (e) {
                // Keep a tombstone so a late clip is recognised and skipped.
                e.audio = undefined
                e.claim = e.claim ?? 'skip'
            }
            engine.current.pump()
        },
        playAudio(e: Entry): boolean {
            let url: string
            try {
                url = URL.createObjectURL(base64ToBlob(e.audio!.audio, e.audio!.mime_type))
            } catch {
                return false
            }
            e.started = true
            const el = new Audio(url)
            el.volume = 1
            const done = () => {
                el.onended = el.onerror = null
                URL.revokeObjectURL(url)
                engine.current.finish(e.id)
            }
            el.onended = done
            el.onerror = done
            playing.current = {
                id: e.id,
                stop: () => {
                    el.onended = el.onerror = null
                    el.pause()
                    URL.revokeObjectURL(url)
                },
            }
            el.play().catch(() => {
                // Autoplay refused or a bad clip: fall back to the browser voice.
                el.onended = el.onerror = null
                URL.revokeObjectURL(url)
                if (playing.current?.id !== e.id) return
                playing.current = null
                if (e.item && engine.current.speak(e)) return
                engine.current.pump()
            })
            return true
        },
        speak(e: Entry): boolean {
            const item = e.item!
            const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
            const lang = findLanguage(useTranslationStore.getState().languages, item.target_language)
            const voice = synth ? pickVoice(lang?.locale, item.target_language) : null
            if (!synth || !voice) {
                e.claim = 'skip'
                const key = item.target_language
                if (!hinted.current.has(key)) {
                    hinted.current.add(key)
                    const name = lang?.name ?? item.target_language.toUpperCase()
                    useTranslationStore.getState().setVoiceHint(
                        synth
                            ? `Your browser has no ${name} voice — showing captions only.`
                            : 'Your browser can’t speak translations — showing captions only.',
                    )
                }
                return false
            }
            e.started = true
            e.claim = 'speech'
            const u = new SpeechSynthesisUtterance(item.text)
            u.voice = voice
            u.lang = voice.lang || lang?.locale || item.target_language
            u.rate = 1.02
            let finished = false
            // Chrome sometimes never fires onend; don't let one line wedge the queue.
            const guard = window.setTimeout(() => done(), 6000 + item.text.length * 140)
            const done = () => {
                if (finished) return
                finished = true
                window.clearTimeout(guard)
                engine.current.finish(e.id)
            }
            u.onend = done
            u.onerror = done
            playing.current = {
                id: e.id,
                stop: () => {
                    finished = true
                    try { synth.cancel() } catch { /* ignore */ }
                },
            }
            try {
                synth.speak(u)
            } catch {
                done()
            }
            return true
        },
        onItem(item: TranslationItem) {
            const p = live.current.prefs
            if (!p || !p.enabled) return
            if (item.target_language && item.target_language !== p.target_language) return
            let e = entries.current.get(item.id)
            if (!e) {
                e = { id: item.id, arrivedAt: Date.now(), started: false }
                entries.current.set(item.id, e)
                engine.current.prune()
            }
            e.item = item
            if (!p.voice || e.claim) {
                // Captions only, or the audio already claimed this line.
                if (!p.voice) e.claim = 'skip'
                return
            }
            const serverTts = live.current.tts?.server !== false
            if (!serverTts) {
                e.claim = 'speech'
                engine.current.enqueue(e.id)
                return
            }
            const entry = e
            entry.timer = window.setTimeout(() => {
                if (entry.claim) return
                entry.claim = 'speech'
                engine.current.enqueue(entry.id)
            }, AUDIO_WAIT_MS)
            // Hold its place in line so lines are voiced in the order spoken.
            if (!queue.current.includes(entry.id)) queue.current.push(entry.id)
        },
        onAudio(audio: TranslationAudio) {
            const p = live.current.prefs
            if (!p || !p.enabled || !p.voice) return
            if (audio.target_language && audio.target_language !== p.target_language) return
            let e = entries.current.get(audio.id)
            if (!e) {
                e = { id: audio.id, arrivedAt: Date.now(), started: false }
                entries.current.set(audio.id, e)
                engine.current.prune()
            }
            // Already voiced (or being voiced) by the browser: never double-speak.
            if (e.started || e.claim === 'skip') return
            window.clearTimeout(e.timer)
            e.audio = audio
            e.claim = 'audio'
            engine.current.enqueue(e.id)
        },
        prune() {
            const cutoff = Date.now() - STALE_MS * 4
            for (const [id, e] of entries.current) {
                if (e.arrivedAt < cutoff && playing.current?.id !== id) {
                    window.clearTimeout(e.timer)
                    entries.current.delete(id)
                }
            }
        },
    })

    // ── Socket subscriptions ──
    useEffect(() => {
        const offLang = onWsMessage('speaker_language', (msg) => {
            if (typeof msg?.username === 'string' && typeof msg?.language === 'string') {
                setSpeakerLang(msg.username, msg.language)
            }
        })
        const offItem = onWsMessage('translation', (msg) => {
            const item = msg?.item
            if (!isItem(item)) return
            addItem(item)
            engine.current.onItem(item)
        })
        const offAudio = onWsMessage('translation_audio', (msg) => {
            const audio = msg?.audio
            if (!isAudio(audio)) return
            engine.current.onAudio(audio)
        })
        return () => {
            offLang()
            offItem()
            offAudio()
        }
    }, [setSpeakerLang, addItem])

    // Turning translation (or its voice) off, or switching target, silences
    // whatever is queued.
    const voiceKey = prefs ? `${prefs.enabled}|${prefs.voice}|${prefs.target_language}` : ''
    useEffect(() => {
        if (!prefs?.enabled || !prefs.voice) engine.current.stopAll()
    }, [voiceKey]) // eslint-disable-line react-hooks/exhaustive-deps
    const targetRef = useRef<string | null>(null)
    useEffect(() => {
        const t = prefs?.target_language ?? null
        if (targetRef.current && t && targetRef.current !== t) {
            engine.current.stopAll()
            hinted.current.clear()
            useTranslationStore.getState().setVoiceHint(null)
        }
        targetRef.current = t
    }, [prefs?.target_language])

    useEffect(() => () => engine.current.stopAll(), [])

    // Some browsers load voices lazily; asking once warms the list.
    useEffect(() => {
        try {
            const synth = window.speechSynthesis
            if (!synth) return
            synth.getVoices()
            const noop = () => { /* voices now available */ }
            synth.addEventListener?.('voiceschanged', noop)
            return () => synth.removeEventListener?.('voiceschanged', noop)
        } catch {
            return undefined
        }
    }, [])

    // ── Ducking: turn other-language speakers down while translating ──
    const participants = useRemoteParticipants()
    const applied = useRef(new Map<string, { p: (typeof participants)[number]; v: number }>())
    useEffect(() => {
        const enabled = !!prefs?.enabled
        const target = prefs?.target_language
        const vol = prefs ? prefs.original_volume : 1
        const seen = new Set<string>()
        for (const p of participants) {
            seen.add(p.identity)
            const lang = speakerLangs[p.identity]
            const duck = enabled && !!lang && !!target && lang !== target
            const v = duck ? vol : 1
            const prev = applied.current.get(p.identity)
            if (!prev || prev.v !== v || prev.p !== p) {
                try { p.setVolume(v) } catch { /* not yet subscribed */ }
                applied.current.set(p.identity, { p, v })
            }
        }
        for (const id of [...applied.current.keys()]) if (!seen.has(id)) applied.current.delete(id)
    }, [participants, speakerLangs, prefs])

    useEffect(() => () => {
        for (const { p, v } of applied.current.values()) {
            if (v !== 1) {
                try { p.setVolume(1) } catch { /* participant gone */ }
            }
        }
        applied.current.clear()
    }, [])

    return null
}
