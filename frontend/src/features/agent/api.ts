import api from '../../lib/api'
import type { AgentAction, AgentProfile, AgentProfileResponse, ApprovePayload } from './types'

const m = (id: string) => encodeURIComponent(id)

export const agentApi = {
    getProfile: () => api.get<AgentProfileResponse>('/agent/profile').then((r) => r.data),

    saveProfile: (profile: Omit<AgentProfile, 'updated_at'>) =>
        api.put<{ profile: AgentProfile }>('/agent/profile', profile).then((r) => r.data.profile),

    command: (meetingId: string, text: string) =>
        api.post<AgentAction>(`/agent/${m(meetingId)}/command`, { text }, { timeout: 90_000 }).then((r) => r.data),

    listActions: (meetingId: string) =>
        api.get<{ actions: AgentAction[] }>(`/agent/${m(meetingId)}/actions`).then((r) => r.data.actions ?? []),

    approve: (meetingId: string, actionId: string, payload: ApprovePayload = {}) =>
        api
            .post<AgentAction>(`/agent/${m(meetingId)}/actions/${m(actionId)}/approve`, payload, { timeout: 90_000 })
            .then((r) => r.data),

    reject: (meetingId: string, actionId: string) =>
        api.post<AgentAction>(`/agent/${m(meetingId)}/actions/${m(actionId)}/reject`).then((r) => r.data),
}
