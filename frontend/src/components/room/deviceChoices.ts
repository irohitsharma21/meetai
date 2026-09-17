/**
 * What the user picked on the pre-join screen, remembered across meetings.
 *
 * Stored in localStorage so the next "Ready to join?" opens with the same
 * camera, microphone and background effect. Every read is defensive: private
 * windows and blocked storage must never break joining.
 */

export type BackgroundEffect = 'none' | 'blur-light' | 'blur-strong'

export interface RoomChoices {
    micOn: boolean
    camOn: boolean
    audioDeviceId: string | null
    videoDeviceId: string | null
    effect: BackgroundEffect
}

const KEY = 'meetai.room.choices'

export const DEFAULT_CHOICES: RoomChoices = {
    micOn: true,
    camOn: true,
    audioDeviceId: null,
    videoDeviceId: null,
    effect: 'none',
}

const EFFECTS: BackgroundEffect[] = ['none', 'blur-light', 'blur-strong']

export function loadChoices(): RoomChoices {
    try {
        const raw = localStorage.getItem(KEY)
        if (!raw) return DEFAULT_CHOICES
        const parsed = JSON.parse(raw) as Partial<RoomChoices>
        return {
            micOn: typeof parsed.micOn === 'boolean' ? parsed.micOn : DEFAULT_CHOICES.micOn,
            camOn: typeof parsed.camOn === 'boolean' ? parsed.camOn : DEFAULT_CHOICES.camOn,
            audioDeviceId: typeof parsed.audioDeviceId === 'string' ? parsed.audioDeviceId : null,
            videoDeviceId: typeof parsed.videoDeviceId === 'string' ? parsed.videoDeviceId : null,
            effect: EFFECTS.includes(parsed.effect as BackgroundEffect) ? (parsed.effect as BackgroundEffect) : 'none',
        }
    } catch {
        return DEFAULT_CHOICES
    }
}

export function saveChoices(choices: RoomChoices): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(choices))
    } catch {
        /* storage blocked - the session still works, it just will not remember */
    }
}

/** Blur radius per effect level, in pixels of the segmenter's output. */
export const BLUR_RADIUS: Record<Exclude<BackgroundEffect, 'none'>, number> = {
    'blur-light': 6,
    'blur-strong': 16,
}

export const EFFECT_LABEL: Record<BackgroundEffect, string> = {
    none: 'No effect',
    'blur-light': 'Light blur',
    'blur-strong': 'Strong blur',
}
