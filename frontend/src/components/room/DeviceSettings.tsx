import { ChevronDown, Settings2 } from 'lucide-react'
import { useMediaDeviceSelect } from '@livekit/components-react'
import { Dialog } from './Dialog'
import { loadChoices, saveChoices } from './deviceChoices'

function DevicePicker({
    kind, label, id,
}: {
    kind: MediaDeviceKind
    label: string
    id: string
}) {
    const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind })
    const noun = kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'

    const onChange = async (deviceId: string) => {
        try {
            await setActiveMediaDevice(deviceId)
            const c = loadChoices()
            if (kind === 'audioinput') saveChoices({ ...c, audioDeviceId: deviceId || null })
            if (kind === 'videoinput') saveChoices({ ...c, videoDeviceId: deviceId || null })
        } catch {
            /* the room keeps the previous device; nothing to clean up */
        }
    }

    return (
        <div className="room-field">
            <label className="label" htmlFor={id}>{label}</label>
            <div className="room-select">
                <select
                    id={id}
                    className="input"
                    value={activeDeviceId ?? ''}
                    onChange={(e) => void onChange(e.target.value)}
                    disabled={devices.length === 0}
                >
                    {devices.length === 0 && <option value="">No {noun.toLowerCase()} found</option>}
                    {devices.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                            {d.label || `${noun} ${i + 1}`}
                        </option>
                    ))}
                </select>
                <ChevronDown size={14} />
            </div>
        </div>
    )
}

/** In-call device switching. Rendered inside the room so switches apply live. */
export function DeviceSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <Dialog open={open} onClose={onClose} title="Devices" icon={<Settings2 size={15} />}>
            <DevicePicker kind="audioinput" label="Microphone" id="dev-mic" />
            <DevicePicker kind="videoinput" label="Camera" id="dev-cam" />
            <DevicePicker kind="audiooutput" label="Speakers" id="dev-out" />
            <p className="room-dialog-hint">
                Changes apply immediately and are remembered for your next meeting.
            </p>
        </Dialog>
    )
}
