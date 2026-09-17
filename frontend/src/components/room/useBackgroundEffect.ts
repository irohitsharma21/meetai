import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LocalVideoTrack } from 'livekit-client'
import { useLocalParticipant } from '@livekit/components-react'
import {
    BackgroundProcessor,
    supportsBackgroundProcessors,
    type BackgroundProcessorWrapper,
} from '@livekit/track-processors'
import { useToastStore } from '../../store'
import { BLUR_RADIUS, type BackgroundEffect } from './deviceChoices'

/**
 * Owns one background processor for one video track at a time.
 *
 * Calls are queued: the user can click "light" then "strong" then "none"
 * faster than the segmenter model loads, and `setProcessor` on a track that
 * is mid-`stopProcessor` throws. Serialising them keeps the track in a known
 * state and means the last click always wins.
 */
export class EffectController {
    private processor: BackgroundProcessorWrapper | null = null
    private track: LocalVideoTrack | null = null
    private queue: Promise<void> = Promise.resolve()

    static get supported(): boolean {
        try {
            return supportsBackgroundProcessors()
        } catch {
            return false
        }
    }

    apply(track: LocalVideoTrack, effect: BackgroundEffect): Promise<void> {
        const run = async () => {
            // A different track than last time: whatever processor the old one
            // had is its own business; start clean.
            if (this.track && this.track !== track) {
                this.processor = null
            }
            this.track = track

            if (effect === 'none') {
                if (track.getProcessor()) await track.stopProcessor()
                this.processor = null
                return
            }

            const blurRadius = BLUR_RADIUS[effect]
            if (this.processor && track.getProcessor() === this.processor) {
                await this.processor.switchTo({ mode: 'background-blur', blurRadius })
                return
            }
            const processor = BackgroundProcessor({ mode: 'background-blur', blurRadius })
            await track.setProcessor(processor)
            this.processor = processor
        }
        this.queue = this.queue.then(run, run)
        return this.queue
    }

    /** Stop whatever is attached. Safe to call on a stopped or gone track. */
    release(): Promise<void> {
        const run = async () => {
            const track = this.track
            this.track = null
            this.processor = null
            if (!track) return
            try {
                if (track.getProcessor()) await track.stopProcessor()
            } catch {
                /* the track is already torn down - nothing left to stop */
            }
        }
        this.queue = this.queue.then(run, run)
        return this.queue
    }
}

/**
 * Background blur for the camera LiveKit is publishing.
 *
 * Applies `effect` whenever the local camera track appears or changes, so a
 * choice made on the pre-join screen lands on the real published track the
 * moment it exists, and a camera swapped in device settings picks the effect
 * up again. Unsupported browsers get a toast and stay on "none".
 */
export function useBackgroundEffect(
    initial: BackgroundEffect,
    onChange?: (effect: BackgroundEffect) => void,
) {
    const { cameraTrack } = useLocalParticipant()
    const [effect, setEffectState] = useState<BackgroundEffect>(initial)
    const controller = useMemo(() => new EffectController(), [])
    const supported = useMemo(() => EffectController.supported, [])
    const addToast = useToastStore((s) => s.addToast)
    const failedRef = useRef(false)

    const track = cameraTrack?.track instanceof LocalVideoTrack ? cameraTrack.track : null

    useEffect(() => {
        if (!track) return
        if (effect !== 'none' && !supported) return
        controller.apply(track, effect).catch((err: unknown) => {
            // Report once per session; a broken segmenter would otherwise
            // toast on every camera restart.
            if (failedRef.current) return
            failedRef.current = true
            console.warn('Background effect failed:', err)
            addToast({
                type: 'warning',
                title: 'Background effect unavailable',
                message: 'Your browser could not run the background segmenter. Continuing without it.',
            })
            setEffectState('none')
        })
    }, [track, effect, supported, controller, addToast])

    useEffect(() => () => {
        void controller.release()
    }, [controller])

    const setEffect = useCallback((next: BackgroundEffect) => {
        if (next !== 'none' && !supported) {
            addToast({
                type: 'info',
                title: 'Background effects not supported',
                message: 'This browser cannot process video in real time. Try Chrome or Edge.',
            })
            return
        }
        setEffectState(next)
        onChange?.(next)
    }, [supported, addToast, onChange])

    /** Stop processing before the track is torn down (leave / end). */
    const release = useCallback(() => controller.release(), [controller])

    return { effect, setEffect, supported, release }
}
