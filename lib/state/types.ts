import { Message, Part } from "@opencode-ai/sdk/v2"
import type { AdvisorState } from "../advisor/types"

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

export interface TurnCacheEntry {
    turn: number
    cacheRead: number
    cacheWrite: number
    input: number
    output: number
    reasoning: number
    timestamp: string
}

export interface CacheMetrics {
    totalCacheRead: number
    totalCacheWrite: number
    totalInput: number
    totalOutput: number
    totalReasoning: number
    requestCount: number
    turnHistory: TurnCacheEntry[]
    lastProcessedMsgId?: string
}

export interface Prune {
    toolIds: string[]
    toolIdSet: Set<string>
}

export interface PrunableToolEntry {
    id: number
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
    toolIdToPartCache: Map<string, { msgIndex: number; partIndex: number }> | null // Index for O(1) part lookup
    toolTokensCache: Map<string, number>
    toolTokensCacheHash: string | undefined // Hash for invalidation (msgLength_lastMsgId_lastCompaction)
    prunableToolIdList: PrunableToolEntry[] | null // Snapshot with callId and tool name for validation
    prunableListVersion: number // Snapshot version for internal tracking
    nextPrunableId: number // Auto-increment counter for stable prunable IDs
    prunableIdMap: Map<string, number>
    aggressivePruneExhausted: boolean
    // Tracks the first message index modified in the current request cycle.
    // Used for selective cleaning of stale <prunable-tools> blocks in cache-invalidated regions.
    earliestModifiedMsgIndex: number
    cacheMetrics: CacheMetrics
    advisor: AdvisorState
}

export type { AdvisorState }
