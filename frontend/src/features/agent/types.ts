/*
 * Delegate agent: the personal assistant that sits in the owner's meetings and
 * carries out the tasks the owner has allowed. Mirrors the backend contract.
 */

export type AgentTool = 'share_contact' | 'share_snippet' | 'send_document' | 'send_email' | 'add_note'

export type ContactField = 'full_name' | 'email' | 'phone' | 'company' | 'title' | 'linkedin' | 'website'

export type AgentContact = Record<ContactField, string>

export interface AgentSnippet {
    id: string
    label: string
    text: string
}

export type PermissionMode = 'confirm' | 'auto'

export interface AgentPermission {
    enabled: boolean
    mode: PermissionMode
}

export interface AgentProfile {
    contact: AgentContact
    share_fields: string[]
    snippets: AgentSnippet[]
    permissions: Record<string, AgentPermission>
    updated_at?: string
}

export interface AgentCapability {
    tool: AgentTool | string
    label: string
    description: string
    sends_email: boolean
}

export interface AgentProfileResponse {
    profile: AgentProfile
    capabilities: AgentCapability[]
    email_available: boolean
    llm_available: boolean
}

export type AgentActionStatus =
    | 'pending'
    | 'needs_input'
    | 'blocked'
    | 'running'
    | 'done'
    | 'failed'
    | 'rejected'

export interface AgentRecipient {
    username: string | null
    name: string
    email: string
}

export interface AgentCandidate {
    username: string
    name: string
    email_hint: string
}

export interface AgentAction {
    id: string
    meeting_id: string
    owner: string
    tool: AgentTool | string
    source: 'voice' | 'typed'
    command: string
    summary: string
    recipients: AgentRecipient[]
    candidates: AgentCandidate[]
    preview: { subject: string; body: string } | null
    status: AgentActionStatus
    message: string | null
    created_at: string
    updated_at: string
}

export interface ApprovePayload {
    recipient_username?: string
    recipient_email?: string
    subject?: string
    body?: string
}

export interface AgentNotice {
    from_name: string
    message: string
}

export const CONTACT_FIELDS: { key: ContactField; label: string; placeholder: string; type?: string }[] = [
    { key: 'full_name', label: 'Full name', placeholder: 'Rohit Sharma' },
    { key: 'email', label: 'Email', placeholder: 'you@company.com', type: 'email' },
    { key: 'phone', label: 'Phone', placeholder: '+91 98765 43210', type: 'tel' },
    { key: 'company', label: 'Company', placeholder: 'Acme Inc.' },
    { key: 'title', label: 'Title', placeholder: 'Product Manager' },
    { key: 'linkedin', label: 'LinkedIn', placeholder: 'linkedin.com/in/you', type: 'url' },
    { key: 'website', label: 'Website', placeholder: 'yourcompany.com', type: 'url' },
]

export const TOOL_LABELS: Record<string, string> = {
    share_contact: 'Share contact',
    share_snippet: 'Share snippet',
    send_document: 'Send document',
    send_email: 'Send email',
    add_note: 'Note',
}

export const OPEN_STATUSES: AgentActionStatus[] = ['pending', 'needs_input']
