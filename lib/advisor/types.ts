/**
 * Small Model Advisor - Type Definitions
 *
 * Defines the data structures used throughout the Advisor module for
 * context analysis and pruning suggestions.
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

/**
 * Suggested action type for a tool output.
 */
export type SuggestedAction = "discard" | "extract"

/**
 * A single pruning suggestion from the advisor (used in advisor response parsing).
 */
export interface PruneSuggestion {
    /** String ID from the prunable-tools list */
    id: string
    /** Suggested action: discard or extract */
    action: SuggestedAction
    /** Optional distillation summary for extract action */
    summary?: string
}

/**
 * Parsed result from the advisor model's JSON response.
 * Format: { discardIds: string[], extractItems: [string, string][], reasoning: string }
 */
export interface AdvisorModelResponse {
    /** IDs to discard */
    discardIds: string[]
    /** Items to extract: [id, summary] tuples */
    extractItems: [string, string][]
    /** Brief reasoning from the advisor */
    reasoning: string
}

/**
 * The pending suggestion stored in AdvisorState (single suggestion at a time).
 */
export interface PendingSuggestion {
    /** List of pruning suggestions from the advisor */
    suggestions: PruneSuggestion[]
    /** Reasoning from the advisor */
    reasoning: string
    /** Turn number when the suggestion was generated */
    turn: number
    /** Whether the suggestion has been consumed (injected into context) */
    consumed: boolean
    /** Map from string ID to paramKey for feedback tracking */
    idToParamKey: Map<string, string>
    /** Map from string ID to callId for feedback acceptance checking */
    idToCallId: Map<string, string>
}

/**
 * Result from the advisor analysis.
 */
export interface AdvisorResult {
    /** Parsed advisor response */
    response: AdvisorModelResponse | null
    /** Whether the advisor was able to complete analysis */
    success: boolean
    /** Error message if analysis failed */
    error?: string
    /** Latency in milliseconds */
    latencyMs: number
    /** Map from string ID to paramKey */
    idToParamKey: Map<string, string>
    /** Map from string ID to callId for feedback tracking */
    idToCallId: Map<string, string>
}

/**
 * Feedback entry for a suggestion (accepted or rejected).
 */
export interface FeedbackEntry {
    /** The paramKey of the tool output */
    paramKey: string
    /** The suggested action */
    suggestedAction: SuggestedAction
    /** Whether the user accepted (followed) the suggestion */
    accepted: boolean
    /** Turn number when feedback was recorded */
    turn: number
    /**
     * Reason for rejection (if rejected).
     * Captured from main model's response or inferred from context.
     */
    reason?: string
    /**
     * What action the main model took instead (if rejected).
     * e.g., "kept", "extracted with different summary", "used in edit"
     */
    alternativeAction?: string
}

/**
 * Context information passed to the advisor for analysis.
 * Includes FULL conversation context to help the advisor understand the main model's thinking.
 */
export interface AnalysisContext {
    /** List of prunable tool entries with their metadata, sorted by tokenCount × age */
    tools: AnalysisToolEntry[]
    /** Current prunable token count */
    currentTokens: number
    /** Warn threshold from config */
    warnThreshold: number
    /** Critical threshold from config */
    criticalThreshold: number
    /** Current turn number */
    currentTurn: number
    /** Protected tool IDs (from recent feedback rejection + turn protection) */
    protectedIds: Set<string>
    /** Past feedback history (summary) for the advisor prompt */
    feedbackSummary: string
    /** Summary of recent conversation (user requests and context) */
    conversationSummary: string
    /** Main model's recent activity/reasoning to understand what it's working on */
    recentAssistantActivity: string
    /** Maximum valid tool ID (prunableList.length - 1, for ID validation) */
    maxToolId: number
}

/**
 * Tool entry information for analysis.
 */
export interface AnalysisToolEntry {
    /** String ID in the prunable list */
    id: string
    /** Tool name (e.g., "read", "bash") */
    tool: string
    /** Key parameter value for identification (unified format: tool:param) */
    paramKey: string
    /** Original callId for feedback tracking */
    callId: string
    /** Estimated token count */
    tokens: number
    /** Turn number when the tool was called */
    turn: number
    /** Whether the tool call resulted in an error */
    isError: boolean
    /** Truncated output preview (configurable length) */
    outputPreview: string
    /** Whether this tool is protected from pruning */
    isProtected: boolean
    /** Computed priority score: tokenCount × age */
    priorityScore: number
}

/**
 * Protection info for a paramKey.
 */
export interface ProtectionInfo {
    /** Turn number when protection expires */
    until: number
    /** Number of consecutive rejections for this paramKey */
    rejectCount: number
}

/**
 * State maintained by the advisor across the session.
 */
export interface AdvisorState {
    /** Current pending suggestion (single, serial guarantee) */
    pendingSuggestion: PendingSuggestion | null
    /** Historical feedback entries */
    feedbackHistory: FeedbackEntry[]
    /** Set of paramKeys that are protected (rejected suggestions get protection) */
    protectedKeys: Set<string>
    /** Protection info per key (expiry turn and reject count) */
    protectedKeyExpiry: Map<string, ProtectionInfo>
    /** Number of consecutive advisor failures */
    consecutiveFailures: number
    /** Whether the advisor is currently disabled due to failures */
    disabled: boolean
    /** Current index into the fallback model list (for round-robin) */
    currentModelIndex: number
    /** Whether an advisor analysis is currently in progress (async guard) */
    advisorInProgress: boolean
}

/**
 * Creates a fresh advisor state.
 */
export function createAdvisorState(): AdvisorState {
    return {
        pendingSuggestion: null,
        feedbackHistory: [],
        protectedKeys: new Set(),
        protectedKeyExpiry: new Map(),
        consecutiveFailures: 0,
        disabled: false,
        currentModelIndex: 0,
        advisorInProgress: false,
    }
}
