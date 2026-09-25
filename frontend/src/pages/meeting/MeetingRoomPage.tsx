import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { LiveKitRoom, RoomAudioRenderer, useParticipants } from '@livekit/components-react'
import { DisconnectReason, VideoPresets, type RoomOptions } from 'livekit-client'
import { Video } from 'lucide-react'
import { ActionPopupSystem } from '../../components/meeting/ActionPopup'
import { CueOverlay, BriefingPrejoinCard } from '../../features/briefing'
import { AgentActionToasts } from '../../features/agent'
import { TranslationController, TranslationOffer, TranslatedCaptions } from '../../features/translation'
import { PreJoin } from '../../components/room/PreJoin'
import { WaitingRoom, type WaitingState } from '../../components/room/WaitingRoom'
import { RoomHeader } from '../../components/room/RoomHeader'
import { Stage } from '../../components/room/Stage'
import { SidePanel } from '../../components/room/SidePanel'
import { ControlBar } from '../../components/room/ControlBar'
import { LobbyBanner } from '../../components/room/LobbyBanner'
import { TranscriptionAudioBridge } from '../../components/room/TranscriptionAudioBridge'
import { useBackgroundEffect } from '../../components/room/useBackgroundEffect'
import { loadChoices, saveChoices, type BackgroundEffect, type RoomChoices } from '../../components/room/deviceChoices'
import { useMediaQuery, COMPACT_QUERY } from '../../components/room/useMediaQuery'
import {
    CaptionsOverlay, ReactionsOverlay, useRoomSignals, useChatUnread,
} from '../../components/room/panels'
import { useAuthStore, useMeetingRoomStore, useToastStore } from '../../store'
import { meetingApi, errorMessage } from '../../lib/api'
import { useMeetingWebSocket } from '../../hooks/useWebSocket'
import type { Meeting, JoinMeetingResponse } from '../../types'
import '../../styles/room.css'

type Phase = 'loading' | 'prejoin' | 'joining' | 'waiting' | 'blocked' | 'room'

interface Blocked {
    state: WaitingState
    message: string | null
}

function hostDisplayName(meeting: Meeting): string {
    const host = meeting.participants?.find((p) => p.username === meeting.created_by)
    return host?.display_name || meeting.created_by
}

/* ──────────────────────────────────────────────────────────────────────
   Inside the LiveKit room: everything that needs room context.
   ────────────────────────────────────────────────────────────────────── */
interface RoomInnerProps {
    meetingId: string
    meeting: Meeting
    isHost: boolean
    initialEffect: BackgroundEffect
    onAudioChunk: (data: ArrayBuffer) => void
    onLeave: () => void
    onEnd: () => Promise<void>
    ending: boolean
    sttLabel: string
    sttColour: string
    sttReason: string | null
    sttOk: boolean
}

function RoomInner({
    meetingId, meeting, isHost, initialEffect, onAudioChunk, onLeave, onEnd, ending,
    sttLabel, sttColour, sttReason, sttOk,
}: RoomInnerProps) {
    const compact = useMediaQuery(COMPACT_QUERY)
    const hostIdentity = meeting.created_by
    const hostName = hostDisplayName(meeting)

    const roomRole = useMeetingRoomStore((s) => s.roomRole)
    const joinCode = useMeetingRoomStore((s) => s.joinCode)
    const sidePanel = useMeetingRoomStore((s) => s.sidePanel)
    const setSidePanel = useMeetingRoomStore((s) => s.setSidePanel)
    const pinned = useMeetingRoomStore((s) => s.pinned)
    const setPinned = useMeetingRoomStore((s) => s.setPinned)
    const captionsOn = useMeetingRoomStore((s) => s.captionsOn)
    const settings = useMeetingRoomStore((s) => s.meetingSettings)
    const waitingCount = useMeetingRoomStore((s) => s.lobbyWaitingCount)

    const signals = useRoomSignals({ hostIdentity, isHost })
    // Must stay mounted for the whole call: it owns the chat subscription
    // that gives a late-opened panel its history.
    const { unread } = useChatUnread(sidePanel === 'chat')
    const participants = useParticipants()

    const persistEffect = useCallback((e: BackgroundEffect) => {
        saveChoices({ ...loadChoices(), effect: e })
    }, [])
    const { effect, setEffect, supported: effectsSupported, release: releaseEffects } =
        useBackgroundEffect(initialEffect, persistEffect)

    const leave = useCallback(() => {
        void releaseEffects()
        onLeave()
    }, [releaseEffects, onLeave])

    const end = useCallback(async () => {
        void releaseEffects()
        await onEnd()
    }, [releaseEffects, onEnd])

    const closePanel = useCallback(() => setSidePanel(null), [setSidePanel])

    // Escape closes the open panel (menus handle their own Escape).
    useEffect(() => {
        if (!sidePanel) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) closePanel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [sidePanel, closePanel])

    const chatDisabled = !isHost && settings?.allow_chat === false

    return (
        <>
            <RoomHeader
                title={meeting.title || 'Meeting'}
                joinCode={joinCode}
                role={roomRole}
                sttLabel={sttLabel}
                sttColour={sttColour}
                sttReason={sttReason}
                aiActive={sttOk}
                startedAt={meeting.started_at ?? null}
                waitingCount={waitingCount}
                isHost={isHost}
                compact={compact}
            />

            <div className="room-main">
                <div className="room-stage-wrap">
                    <Stage
                        hostIdentity={hostIdentity}
                        spotlight={signals.spotlight}
                        pinned={pinned}
                        onPin={setPinned}
                        compact={compact}
                        joinCode={joinCode}
                    />
                    <ReactionsOverlay />
                    <CaptionsOverlay enabled={captionsOn} />
                    <TranslatedCaptions />
                    <CueOverlay meetingId={meetingId} />
                    <TranslationOffer meetingId={meetingId} />
                    <TranslationController meetingId={meetingId} />
                    <AgentActionToasts
                        meetingId={meetingId}
                        panelOpen={sidePanel === 'agent'}
                        onOpenPanel={() => setSidePanel('agent')}
                    />
                    {isHost && <LobbyBanner meetingId={meetingId} waitingCount={waitingCount} />}
                </div>

                <SidePanel
                    meetingId={meetingId}
                    isHost={isHost}
                    hostIdentity={hostIdentity}
                    panel={sidePanel}
                    onClose={closePanel}
                    pinned={pinned}
                    onPin={setPinned}
                    compact={compact}
                    chatDisabled={chatDisabled}
                />
            </div>

            <ControlBar
                meetingId={meetingId}
                isHost={isHost}
                hostName={hostName}
                title={meeting.title || 'Meeting'}
                joinCode={joinCode}
                startedAt={meeting.started_at ?? null}
                signals={signals}
                effect={effect}
                setEffect={setEffect}
                effectsSupported={effectsSupported}
                unread={unread}
                participantCount={participants.length}
                waitingCount={waitingCount}
                compact={compact}
                onLeave={leave}
                onEnd={end}
                ending={ending}
            />

            <RoomAudioRenderer />
            <TranscriptionAudioBridge onAudioChunk={onAudioChunk} />
        </>
    )
}

/* ──────────────────────────────────────────────────────────────────────
   Page: load → pre-join → (waiting) → room
   ────────────────────────────────────────────────────────────────────── */
export function MeetingRoomPage() {
    const { meetingId } = useParams<{ meetingId: string }>()
    const navigate = useNavigate()
    const { addToast } = useToastStore()
    const user = useAuthStore((s) => s.user)
    const {
        currentMeeting, setMeeting, setMeetingDoc, clearRoom, livekitToken, livekitUrl,
        isConnected, transcriptionStatus, exitReason,
    } = useMeetingRoomStore()

    const [phase, setPhase] = useState<Phase>('loading')
    const [blocked, setBlocked] = useState<Blocked>({ state: 'error', message: null })
    const [choices, setChoices] = useState<RoomChoices>(loadChoices)
    const [isEnding, setIsEnding] = useState(false)

    const meeting = currentMeeting
    const isHost = !!meeting && !!user && (user.username === meeting.created_by || user.role === 'admin')

    /*
     * The badge used to read "Transcribing" whenever the socket was open, which
     * is a claim about the socket, not about speech-to-text. If the provider is
     * unreachable that reads as a working feature producing nothing. The server
     * now reports whether STT can actually run, and the badge follows it.
     */
    const sttOk = isConnected && transcriptionStatus?.available === true
    const sttReason = transcriptionStatus?.reason ?? null
    const sttLabel = !livekitToken
        ? 'Connection failed'
        : !isConnected
            ? 'Connecting...'
            : transcriptionStatus === null
                ? 'Connecting...'
                : transcriptionStatus.available
                    ? 'Transcribing'
                    : 'Transcription off'
    const sttColour = sttOk
        ? 'var(--color-success)'
        : livekitToken
            ? 'var(--color-warning)'
            : 'var(--color-error)'

    // WebSocket for transcription + room signals; only once we hold a token.
    const { sendAudio } = useMeetingWebSocket(meetingId && livekitToken ? meetingId : null)
    const handleAudioChunk = useCallback((data: ArrayBuffer) => {
        sendAudio(data)
    }, [sendAudio])

    // ── Load the meeting; do NOT join yet ──
    useEffect(() => {
        if (!meetingId) return
        let cancelled = false
        setPhase('loading')
        meetingApi.get(meetingId)
            .then((res) => {
                if (cancelled) return
                const doc: Meeting = res.data
                setMeetingDoc(doc)
                if (doc.status === 'ended' || doc.status === 'processed') {
                    setBlocked({ state: 'ended', message: null })
                    setPhase('blocked')
                    return
                }
                setPhase('prejoin')
            })
            .catch((err) => {
                if (cancelled) return
                addToast({
                    type: 'error',
                    title: 'Could not open the meeting',
                    message: errorMessage(err, 'Please try again'),
                })
                navigate('/dashboard', { replace: true })
            })
        return () => {
            cancelled = true
            clearRoom()
        }
    }, [meetingId])

    // ── Join (from the pre-join button, or again once admitted) ──
    const join = useCallback(async (): Promise<void> => {
        if (!meetingId) return
        setPhase('joining')
        try {
            const res = await meetingApi.join(meetingId)
            if (res.status === 202) {
                setPhase('waiting')
                return
            }
            const { livekit_token, livekit_url, role, join_code } = res.data as JoinMeetingResponse

            // Fresh copy of the document: settings may have changed while we
            // sat in the lobby.
            const meetingRes = await meetingApi.get(meetingId)
            const doc: Meeting = meetingRes.data
            setMeeting(doc, livekit_token, livekit_url, role, join_code)

            // Start meeting if host and not already started
            if (role === 'host' && doc.status === 'scheduled') {
                await meetingApi.start(meetingId)
            }
            setPhase('room')
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status
            const detail = errorMessage(err, '')
            if (status === 423) {
                setBlocked({ state: 'locked', message: detail || null })
                setPhase('blocked')
            } else if (status === 403) {
                const denied = /declined/i.test(detail)
                setBlocked({ state: denied ? 'denied' : 'banned', message: detail || null })
                setPhase('blocked')
            } else if (status === 410) {
                setBlocked({ state: 'ended', message: detail || null })
                setPhase('blocked')
            } else {
                addToast({
                    type: 'error',
                    title: status === 503 ? 'Video not configured' : 'Failed to join meeting',
                    message: errorMessage(err, 'Please try again'),
                })
                navigate('/dashboard', { replace: true })
            }
        }
    }, [meetingId, setMeeting, addToast, navigate])

    const handlePreJoin = useCallback((c: RoomChoices) => {
        setChoices(c)
        void join()
    }, [join])

    const toDashboard = useCallback(() => {
        navigate('/dashboard', { replace: true })
    }, [navigate])

    /*
     * Where this page hands off to, once. Leaving fires from two places at
     * nearly the same moment - the click handler and LiveKit's onDisconnected -
     * and the host ending a meeting fires both as well, on the way to the
     * report. Without a latch the second one would overwrite the first
     * destination, sending the host to the dashboard instead of the report.
     */
    const departedRef = useRef(false)

    const handleLeave = useCallback(() => {
        if (departedRef.current) return
        departedRef.current = true

        // Navigate first and synchronously. Leaving a call must never wait on a
        // network round trip; the room is already gone from the user's point of
        // view the instant they click. `replace` so the browser back button
        // does not return them to a room they have left.
        //
        // The dashboard reads ?wrapup and opens the post-meeting panel over it,
        // so the wrap-up is something you land behind rather than a detour: the
        // destination is still the dashboard, and dismissing the panel leaves
        // you exactly where you expected to be.
        clearRoom()
        navigate(`/dashboard?wrapup=${encodeURIComponent(meetingId ?? '')}`, { replace: true })
    }, [clearRoom, navigate, meetingId])

    const handleEndMeeting = useCallback(async () => {
        if (!meetingId || isEnding) return

        // Claim the exit before the await: disconnecting the room triggers
        // onDisconnected, which would otherwise redirect to the dashboard while
        // this is still waiting on the server.
        if (departedRef.current) return
        departedRef.current = true
        setIsEnding(true)

        try {
            await meetingApi.end(meetingId)
            addToast({ type: 'success', title: 'Meeting ended', message: 'Generating AI report…' })
            clearRoom()
            navigate(`/meetings/${meetingId}/report`, { replace: true })
        } catch (err) {
            addToast({
                type: 'error',
                title: 'Could not end the meeting',
                message: errorMessage(err, 'You are still connected.'),
            })
            // The meeting is still live, so release the latch and let them try
            // again rather than stranding them in a room they cannot leave.
            departedRef.current = false
            setIsEnding(false)
        }
    }, [meetingId, isEnding, addToast, clearRoom, navigate])

    // ── Forced exits: removed by the host, or the host ended the meeting ──
    const forcedExit = useCallback((reason: 'removed' | 'ended') => {
        if (departedRef.current) return
        departedRef.current = true
        if (reason === 'removed') {
            addToast({ type: 'warning', title: 'Removed from meeting', message: 'The host removed you from this meeting.' })
            clearRoom()
            navigate('/dashboard', { replace: true })
        } else {
            addToast({ type: 'info', title: 'Meeting ended', message: 'The host has ended the meeting.' })
            clearRoom()
            navigate(`/dashboard?wrapup=${encodeURIComponent(meetingId ?? '')}`, { replace: true })
        }
    }, [addToast, clearRoom, navigate, meetingId])

    useEffect(() => {
        if (exitReason) forcedExit(exitReason)
    }, [exitReason, forcedExit])

    const handleDisconnected = useCallback((reason?: DisconnectReason) => {
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) forcedExit('removed')
        else if (reason === DisconnectReason.ROOM_DELETED) forcedExit('ended')
        else handleLeave()
    }, [forcedExit, handleLeave])

    const handleRoomError = useCallback((err: Error) => {
        console.warn('LiveKit room error:', err)
        addToast({ type: 'error', title: 'Connection problem', message: err.message })
    }, [addToast])

    // The lobby and settings change while we are in the room; the document is
    // where display names and the current settings live, so refresh it when
    // the socket says something moved.
    const lobbyWaitingCount = useMeetingRoomStore((s) => s.lobbyWaitingCount)
    // Keyed on content, not identity: the refetch itself writes a fresh
    // settings object back to the store, which must not re-trigger it.
    const settingsKey = useMeetingRoomStore((s) => JSON.stringify(s.meetingSettings))
    useEffect(() => {
        if (phase !== 'room' || !meetingId) return
        let cancelled = false
        meetingApi.get(meetingId)
            .then((res) => {
                if (!cancelled) setMeetingDoc(res.data as Meeting)
            })
            .catch(() => { /* the next update retries; nothing user-facing */ })
        return () => {
            cancelled = true
        }
    }, [phase, meetingId, lobbyWaitingCount, settingsKey, setMeetingDoc])

    // Stable capture props: LiveKitRoom re-registers its room listeners
    // whenever these change identity.
    const audioProp = useMemo(
        () => (choices.micOn ? { deviceId: choices.audioDeviceId ?? undefined } : false),
        [choices.micOn, choices.audioDeviceId],
    )
    const videoProp = useMemo(
        () => (choices.camOn ? { deviceId: choices.videoDeviceId ?? undefined } : false),
        [choices.camOn, choices.videoDeviceId],
    )

    // Stable room options: LiveKitRoom rebuilds the Room if this identity changes.
    const roomOptions = useMemo<RoomOptions>(() => ({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
            deviceId: choices.videoDeviceId ?? undefined,
            resolution: VideoPresets.h720.resolution,
        },
        audioCaptureDefaults: {
            deviceId: choices.audioDeviceId ?? undefined,
            echoCancellation: true,
            noiseSuppression: true,
        },
    }), [choices.videoDeviceId, choices.audioDeviceId])

    // ── Render by phase ──
    if (!meetingId) return null

    if (phase === 'loading' || !meeting) {
        return (
            <div className="room-wait">
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
                    <div style={{
                        width: 60, height: 60, borderRadius: 16,
                        background: 'var(--gradient-brand)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        animation: 'glow 2s ease infinite',
                    }}>
                        <Video size={28} color="#fff" />
                    </div>
                    <p style={{ color: 'var(--text-secondary)' }}>Opening meeting…</p>
                </div>
            </div>
        )
    }

    const hostName = hostDisplayName(meeting)

    if (phase === 'prejoin' || phase === 'joining') {
        return (
            <PreJoin
                meeting={meeting}
                isHost={isHost}
                hostName={hostName}
                selfName={user?.display_name || user?.username || 'You'}
                joining={phase === 'joining'}
                onJoin={handlePreJoin}
                onCancel={toDashboard}
                extra={<BriefingPrejoinCard meetingId={meetingId} />}
            />
        )
    }

    if (phase === 'waiting' || phase === 'blocked') {
        return (
            <WaitingRoom
                meetingId={meetingId}
                title={meeting.title}
                hostName={hostName}
                state={phase === 'waiting' ? 'waiting' : blocked.state}
                message={phase === 'blocked' ? blocked.message : null}
                onAdmitted={join}
                onCancel={toDashboard}
            />
        )
    }

    if (!livekitToken || !livekitUrl) {
        return (
            <div className="room-wait">
                <p style={{ color: 'var(--text-muted)' }}>Connecting to room…</p>
            </div>
        )
    }

    return (
        <LiveKitRoom
            className="room-root"
            token={livekitToken}
            serverUrl={livekitUrl}
            connect
            audio={audioProp}
            video={videoProp}
            options={roomOptions}
            /*
             * The only hook that catches both a deliberate disconnect and a
             * connection that has genuinely given up. Without it the room
             * tears down and the user is left on an empty stage.
             */
            onDisconnected={handleDisconnected}
            onError={handleRoomError}
        >
            <RoomInner
                meetingId={meetingId}
                meeting={meeting}
                isHost={isHost}
                initialEffect={choices.effect}
                onAudioChunk={handleAudioChunk}
                onLeave={handleLeave}
                onEnd={handleEndMeeting}
                ending={isEnding}
                sttLabel={sttLabel}
                sttColour={sttColour}
                sttReason={sttReason}
                sttOk={sttOk}
            />
            {/* Action popups */}
            <ActionPopupSystem meetingId={meetingId} />
        </LiveKitRoom>
    )
}
