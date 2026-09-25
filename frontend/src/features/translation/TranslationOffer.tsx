import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Languages, Loader2, X } from 'lucide-react'
import { onWsMessage } from '../../lib/wsBus'
import { errorMessage } from '../../lib/api'
import { useToastStore } from '../../store'
import { useTranslationStore } from './store'
import { LanguageSelect } from './LanguageSelect'
import type { TranslationOfferData } from './types'
import './translation.css'

function isOffer(v: any): v is TranslationOfferData {
    return !!v && typeof v === 'object' && typeof v.speaker === 'string' && typeof v.language === 'string'
}

export interface TranslationOfferProps {
    meetingId: string
}

/**
 * "Rohit is speaking Tamil — translate to Hindi?" Top-left of the stage,
 * clear of the host lobby banner (top-centre) and the agent cards
 * (top-right). One card at a time; further offers queue behind it.
 */
export function TranslationOffer({ meetingId }: TranslationOfferProps) {
    const prefs = useTranslationStore((s) => s.prefs)
    const updatePrefs = useTranslationStore((s) => s.updatePrefs)
    const addToast = useToastStore((s) => s.addToast)
    const reduceMotion = !!useReducedMotion()

    const [queue, setQueue] = useState<TranslationOfferData[]>([])
    const [target, setTarget] = useState<string | null>(null)
    const [busy, setBusy] = useState<'allow' | 'decline' | null>(null)

    useEffect(() => {
        setQueue([])
        return onWsMessage('translation_offer', (msg) => {
            const offer = msg?.offer
            if (!isOffer(offer)) return
            setQueue((q) =>
                q.some((o) => o.speaker === offer.speaker && o.language === offer.language) ? q : [...q, offer],
            )
        })
    }, [meetingId])

    // Offers that no longer apply fall away: translation got turned on, or the
    // language was declined (possibly from another offer or the panel).
    const visible = queue.filter((o) =>
        !(prefs?.enabled) && !(prefs?.declined ?? []).includes(o.language),
    )
    const current = visible[0]

    useEffect(() => {
        if (current) setTarget(current.target_language || prefs?.target_language || prefs?.native_language || null)
    }, [current?.speaker, current?.language]) // eslint-disable-line react-hooks/exhaustive-deps

    const drop = (o: TranslationOfferData) =>
        setQueue((q) => q.filter((x) => !(x.speaker === o.speaker && x.language === o.language)))

    const allow = async () => {
        if (!current || !target) return
        setBusy('allow')
        try {
            await updatePrefs(meetingId, { enabled: true, target_language: target })
            drop(current)
        } catch (err) {
            addToast({ type: 'error', title: 'Could not turn on translation', message: errorMessage(err) })
        } finally {
            setBusy(null)
        }
    }

    const decline = async () => {
        if (!current) return
        const lang = current.language
        setBusy('decline')
        drop(current)
        try {
            const prev = useTranslationStore.getState().prefs?.declined ?? []
            if (!prev.includes(lang)) await updatePrefs(meetingId, { declined: [...prev, lang] })
        } catch { /* the offer is gone either way; it may come back later */ } finally {
            setBusy(null)
        }
    }

    const more = visible.length - 1

    return (
        <div className="trl-offer-layer" role="region" aria-label="Translation offers" aria-live="polite">
            <AnimatePresence initial={false} mode="wait">
                {current && (
                    <motion.div
                        key={`${current.speaker}:${current.language}`}
                        className="trl-offer"
                        role="alertdialog"
                        aria-labelledby="trl-offer-title"
                        onKeyDown={(e) => {
                            if (e.key === 'Escape' && !e.defaultPrevented) {
                                e.stopPropagation()
                                void decline()
                            }
                        }}
                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -14, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10, transition: { duration: 0.16 } }}
                        transition={{ duration: reduceMotion ? 0.12 : 0.26, ease: [0.16, 1, 0.3, 1] }}
                    >
                        <div className="trl-offer-top">
                            <span className="trl-offer-glyph" aria-hidden="true"><Languages size={14} /></span>
                            <div className="trl-offer-title" id="trl-offer-title">
                                <b>{current.speaker_name || current.speaker}</b> is speaking{' '}
                                <b>{current.language_name || current.language.toUpperCase()}</b>
                            </div>
                            {more > 0 && <span className="trl-offer-more" title={`${more} more waiting`}>+{more}</span>}
                            <button
                                type="button"
                                className="trl-mini-btn"
                                onClick={() => void decline()}
                                aria-label="Not now"
                                title="Not now"
                                disabled={!!busy}
                            >
                                <X size={14} />
                            </button>
                        </div>

                        <div className="trl-offer-row">
                            <label className="trl-offer-label" htmlFor="trl-offer-target">Translate to</label>
                            <LanguageSelect
                                id="trl-offer-target"
                                value={target}
                                onChange={(c) => c && setTarget(c)}
                                size="sm"
                                ariaLabel="Translate to"
                            />
                        </div>

                        <p className="trl-offer-sub">
                            You'll hear them in your language, with their own voice turned down. Only you hear it.
                        </p>

                        <div className="trl-offer-actions">
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void decline()} disabled={!!busy}>
                                Not now
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => void allow()}
                                disabled={!!busy || !target}

                            >
                                {busy === 'allow' && <Loader2 size={14} className="spin" aria-hidden="true" />}
                                Allow
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
