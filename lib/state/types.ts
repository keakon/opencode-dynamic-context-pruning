import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
    currentPrunableTokens: number
}

export interface Prune {
    toolIds: string[]
    toolIdSet: Set<string>
}

export interface PrunableToolEntry {
    callId: string
    tool: string
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    prune: Prune
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    nudgeCounter: number
    lastCompaction: number
    currentTurn: number
    variant: string | undefined
    toolIdListCache: string[] | null
    toolIdListCacheHash: string | undefined
    toolIdToIndexCache: Map<string, number> | null
    toolTokensCache: Map<string, number>
    prunableToolIdList: PrunableToolEntry[] | null // Snapshot with callId and tool name for validation
    prunableListVersion: number // Snapshot version for internal tracking
    aggressivePruneExhausted: boolean
}
