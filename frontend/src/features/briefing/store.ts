import { useCallback } from 'react'
import { create } from 'zustand'
import { errorMessage } from '../../lib/api'
import { briefingApi, uploadErrorMessage, validateFile } from './api'
import type {
    BriefingAvailability,
    BriefingDoc,
    BriefingSettings,
    Cue,
    UploadItem,
} from './types'

const DEFAULT_SETTINGS: BriefingSettings = { enabled: true, sensitivity: 'medium' }
const DEFAULT_AVAILABLE: BriefingAvailability = { semantic: true, llm: true }
/** Plenty for one meeting; stops a runaway feed from growing without bound. */
const HISTORY_LIMIT = 100
/** Stable empty array so selectors don't return a fresh [] every render. */
const EMPTY_UPLOADS: UploadItem[] = []

interface BriefingState {
    /** The meeting this state belongs to; switching meetings resets it. */
    meetingId: string | null
    docs: BriefingDoc[]
    settings: BriefingSettings
    available: BriefingAvailability
    loaded: boolean
    loading: boolean
    loadError: string | null
    uploads: UploadItem[]
    /** Every cue received this meeting, newest first. */
    history: Cue[]

    load: (meetingId: string, force?: boolean) => Promise<void>
    uploadFiles: (meetingId: string, files: File[] | FileList) => Promise<void>
    dismissUpload: (key: string) => void
    removeDoc: (meetingId: string, docId: string) => Promise<void>
    updateSettings: (meetingId: string, partial: Partial<BriefingSettings>) => Promise<void>
    addCue: (cue: Cue) => void
}

let inflightLoad: { meetingId: string; promise: Promise<void> } | null = null
/** Uploads run one after another, even across separate drops. */
let uploadChain: Promise<void> = Promise.resolve()
let uploadSeq = 0

export const useBriefingStore = create<BriefingState>((set, get) => {
    /** Reset everything if the store still holds another meeting's state. */
    const bind = (meetingId: string) => {
        if (get().meetingId === meetingId) return
        set({
            meetingId,
            docs: [],
            settings: DEFAULT_SETTINGS,
            available: DEFAULT_AVAILABLE,
            loaded: false,
            loading: false,
            loadError: null,
            uploads: [],
            history: [],
        })
    }

    const patchUpload = (key: string, patch: Partial<UploadItem>) =>
        set((s) => ({ uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)) }))

    return {
        meetingId: null,
        docs: [],
        settings: DEFAULT_SETTINGS,
        available: DEFAULT_AVAILABLE,
        loaded: false,
        loading: false,
        loadError: null,
        uploads: [],
        history: [],

        load: async (meetingId, force = false) => {
            bind(meetingId)
            if (!force && get().loaded) return
            if (inflightLoad && inflightLoad.meetingId === meetingId) return inflightLoad.promise

            set({ loading: true, loadError: null })
            const promise = briefingApi
                .list(meetingId)
                .then((data) => {
                    if (get().meetingId !== meetingId) return
                    set({
                        docs: Array.isArray(data?.docs) ? data.docs : [],
                        settings: data?.settings ?? DEFAULT_SETTINGS,
                        available: data?.available ?? DEFAULT_AVAILABLE,
                        loaded: true,
                        loading: false,
                    })
                })
                .catch((err) => {
                    if (get().meetingId !== meetingId) return
                    set({ loading: false, loadError: errorMessage(err, 'Could not load your documents.') })
                })
                .finally(() => {
                    if (inflightLoad?.promise === promise) inflightLoad = null
                })
            inflightLoad = { meetingId, promise }
            return promise
        },

        uploadFiles: (meetingId, fileList) => {
            bind(meetingId)
            const files = Array.from(fileList)
            const accepted: { key: string; file: File }[] = []
            const items: UploadItem[] = files.map((file) => {
                const key = `up-${++uploadSeq}`
                const invalid = validateFile(file)
                if (!invalid) accepted.push({ key, file })
                return {
                    key,
                    name: file.name,
                    size: file.size,
                    progress: 0,
                    status: invalid ? 'error' : 'queued',
                    error: invalid ?? undefined,
                }
            })
            set((s) => ({ uploads: [...s.uploads, ...items] }))

            const run = async () => {
                for (const { key, file } of accepted) {
                    if (get().meetingId !== meetingId) return
                    patchUpload(key, { status: 'uploading', progress: 0 })
                    try {
                        const doc = await briefingApi.upload(meetingId, file, (p) =>
                            patchUpload(key, { progress: p }),
                        )
                        if (get().meetingId !== meetingId) return
                        set((s) => ({
                            docs: [doc, ...s.docs.filter((d) => d.id !== doc.id)],
                            uploads: s.uploads.filter((u) => u.key !== key),
                        }))
                    } catch (err) {
                        patchUpload(key, {
                            status: 'error',
                            error: uploadErrorMessage(err, (e) => errorMessage(e, 'Upload failed.')),
                        })
                    }
                }
            }
            uploadChain = uploadChain.then(run, run)
            return uploadChain
        },

        dismissUpload: (key) => set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) })),

        removeDoc: async (meetingId, docId) => {
            const before = get().docs
            set({ docs: before.filter((d) => d.id !== docId) })
            try {
                await briefingApi.remove(meetingId, docId)
            } catch (err) {
                if (get().meetingId === meetingId) set({ docs: before })
                throw err
            }
        },

        updateSettings: async (meetingId, partial) => {
            const before = get().settings
            const next = { ...before, ...partial }
            set({ settings: next })
            try {
                const saved = await briefingApi.updateSettings(meetingId, next)
                if (get().meetingId === meetingId && saved) set({ settings: saved })
            } catch (err) {
                if (get().meetingId === meetingId) set({ settings: before })
                throw err
            }
        },

        addCue: (cue) => {
            const { meetingId } = get()
            if (meetingId && cue.meeting_id && cue.meeting_id !== meetingId) return
            set((s) => {
                if (s.history.some((c) => c.id === cue.id)) return s
                return { history: [cue, ...s.history].slice(0, HISTORY_LIMIT) }
            })
        },
    }
})

/**
 * The upload flow shared by the side panel and the pre-join card: pending
 * items, a way to start uploads, and the resulting doc count.
 */
export function useBriefingUploader(meetingId: string) {
    const uploads = useBriefingStore((s) => (s.meetingId === meetingId ? s.uploads : EMPTY_UPLOADS))
    const docCount = useBriefingStore((s) => (s.meetingId === meetingId ? s.docs.length : 0))
    const uploadFiles = useBriefingStore((s) => s.uploadFiles)
    const dismissUpload = useBriefingStore((s) => s.dismissUpload)

    const upload = useCallback(
        (files: File[] | FileList) => uploadFiles(meetingId, files),
        [uploadFiles, meetingId],
    )
    const busy = uploads.some((u) => u.status !== 'error')

    return { uploads, upload, dismissUpload, busy, docCount }
}
