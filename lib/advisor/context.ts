/**
 * Small Model Advisor - Context Building
 *
 * Builds the analysis context from current session state and messages.
 * This context is used to generate prompts for the small model.
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

import type { SessionState, WithParts, PrunableToolEntry } from "../state"
import type { PluginConfig, SmallModelAdvisorConfig } from "../config"
import type {
    AnalysisContext,
    AnalysisToolEntry,
    AdvisorState,
    FeedbackEntry,
    ProtectionInfo,
} from "./types"
import { getToolTokens } from "../strategies/utils"
import { extractParameterKey } from "../messages/utils"

/** Default preview length if config not provided */
const DEFAULT_PREVIEW_LENGTH = 200

/** Base protection duration in turns after a suggestion is rejected */
const BASE_PROTECTION_TURNS = 3

/** Minimum turn age before an item can be suggested for pruning */
const TURN_PROTECTION_AGE = 2

/** Maximum protection duration in turns to prevent permanent protection */
const MAX_PROTECTION_TURNS = 15

/**
 * Build the analysis context for the advisor from current state.
 * Includes sorting, protection marking, feedback summary, and FULL conversation context.
 *
 * @param state - Current session state
 * @param config - Plugin configuration
 * @param messages - Current message list
 * @param advisorState - Advisor state with feedback history
 * @returns Analysis context for the advisor
 */
export function buildAnalysisContext(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    advisorState: AdvisorState,
): AnalysisContext {
    const advisorConfig = config.smallModelAdvisor
    const previewLength = advisorConfig?.contentPreviewLength ?? DEFAULT_PREVIEW_LENGTH

    // Build protected IDs set from protected keys
    const protectedIds = new Set<string>()
    const protectedParamKeys = advisorState.protectedKeys

    // Get current turn for age calculation
    const currentTurn = state.currentTurn

    // Build tool entries
    const tools: AnalysisToolEntry[] = []
    const prunableList = state.prunableToolIdList ?? []

    for (let i = 0; i < prunableList.length; i++) {
        const entry = prunableList[i]
        const toolEntry = buildToolEntry(state, messages, i, entry, currentTurn, previewLength)
        if (toolEntry) {
            // Apply turn protection: skip items younger than TURN_PROTECTION_AGE turns (per docs 6.3)
            const age = currentTurn - toolEntry.turn
            if (age < TURN_PROTECTION_AGE) {
                // Skip turn-protected items entirely - don't add to tools list
                protectedIds.add(toolEntry.id)
                continue
            }
            // Check if protected by rejection feedback
            if (protectedParamKeys.has(toolEntry.paramKey)) {
                toolEntry.isProtected = true
                protectedIds.add(toolEntry.id)
            }
            tools.push(toolEntry)
        }
    }

    // Sort by priority score (tokenCount × age) descending - highest priority first
    tools.sort((a, b) => b.priorityScore - a.priorityScore)

    // Build feedback summary
    const feedbackSummary = buildFeedbackSummary(advisorState.feedbackHistory)

    // Build conversation context for the advisor
    const conversationSummary = buildConversationSummary(messages)
    const recentAssistantActivity = buildRecentAssistantActivity(messages)

    return {
        tools,
        currentTokens: state.stats.currentPrunableTokens,
        warnThreshold: config.tokenBudget.warnThreshold,
        criticalThreshold: config.tokenBudget.criticalThreshold,
        currentTurn,
        protectedIds,
        feedbackSummary,
        conversationSummary,
        recentAssistantActivity,
        maxToolId: prunableList.length - 1,
    }
}

/**
 * Build a single tool entry for analysis.
 */
function buildToolEntry(
    state: SessionState,
    messages: WithParts[],
    index: number,
    entry: PrunableToolEntry,
    currentTurn: number,
    previewLength: number,
): AnalysisToolEntry | null {
    const toolParam = state.toolParameters.get(entry.callId)
    if (!toolParam) {
        return null
    }

    // Get token count
    const tokens = getToolTokens(state, messages, entry.callId)

    // Get parameter key for identification
    const paramKey = extractParameterKey(entry.tool, toolParam.parameters)

    // Get output preview
    const outputPreview = getOutputPreview(state, messages, entry.callId, previewLength)

    // Check if this tool call resulted in an error
    const isError = toolParam.status === "error" || !!toolParam.error

    // Calculate age (in turns)
    const age = Math.max(1, currentTurn - toolParam.turn)

    // Priority score: tokenCount × age (higher = more important to prune)
    const priorityScore = tokens * age

    return {
        id: String(index),
        tool: entry.tool,
        paramKey: `${entry.tool}:${paramKey}`,
        callId: entry.callId,
        tokens,
        turn: toolParam.turn,
        isError,
        outputPreview,
        isProtected: false, // Will be set by caller if needed
        priorityScore,
    }
}

/**
 * Get a truncated preview of the tool output.
 */
function getOutputPreview(
    state: SessionState,
    messages: WithParts[],
    toolCallId: string,
    maxLength: number,
): string {
    const partLocation = state.toolIdToPartCache?.get(toolCallId)
    if (!partLocation) {
        return ""
    }

    const msg = messages[partLocation.msgIndex]
    if (!msg) {
        return ""
    }

    const part = msg.parts[partLocation.partIndex] as any
    if (!part || part.type !== "tool") {
        return ""
    }

    // Get output from tool state (only available when completed)
    if (part.state?.status !== "completed") {
        return ""
    }

    const output = part.state.output
    if (!output) {
        return ""
    }

    const content = typeof output === "string" ? output : JSON.stringify(output)

    // Truncate to preview length
    if (content.length <= maxLength) {
        return content
    }

    return content.substring(0, maxLength) + "..."
}

/**
 * Build a summary of recent feedback for the advisor prompt.
 * Helps the model learn from user preferences, including rejection reasons.
 */
function buildFeedbackSummary(feedbackHistory: FeedbackEntry[]): string {
    if (feedbackHistory.length === 0) {
        return ""
    }

    // Get the last 10 feedback entries
    const recentFeedback = feedbackHistory.slice(-10)

    // Group by acceptance
    const accepted = recentFeedback.filter((f) => f.accepted)
    const rejected = recentFeedback.filter((f) => !f.accepted)

    const lines: string[] = []

    if (accepted.length > 0) {
        lines.push(
            `✓ Accepted ${accepted.length} suggestions: ${accepted
                .slice(-3)
                .map((f) => f.paramKey)
                .join(", ")}`,
        )
    }

    if (rejected.length > 0) {
        lines.push(
            `✗ Rejected ${rejected.length} suggestions (be more conservative for similar content):`,
        )
        // Show rejection details with reasons
        for (const f of rejected.slice(-3)) {
            const reasonPart = f.reason ? ` - Reason: ${f.reason}` : ""
            const actionPart = f.alternativeAction ? ` (${f.alternativeAction})` : ""
            lines.push(`  - ${f.paramKey}${reasonPart}${actionPart}`)
        }
    }

    return lines.join("\n")
}

/**
 * Check if a message content is a system injection that should be ignored.
 * System injections include prunable-tools lists, advisor suggestions, etc.
 */
function isSystemInjection(content: string): boolean {
    const injectionPatterns = [
        /<prunable-tools>/i,
        /<advisor-suggestion>/i,
        /<context_info>/i,
        /<system-reminder>/i,
    ]
    return injectionPatterns.some((pattern) => pattern.test(content))
}

/**
 * Build a summary of recent conversation to help advisor understand context.
 * Extracts user requests and key discussion points.
 * Filters out system injections to avoid polluting the summary.
 */
function buildConversationSummary(messages: WithParts[]): string {
    const lines: string[] = []

    // Get recent user messages (last 3-5)
    const userMessages = messages.filter((m) => m.info?.role === "user").slice(-5)

    if (userMessages.length === 0) {
        return ""
    }

    lines.push("Recent user requests:")
    for (const msg of userMessages) {
        // Extract text content from message parts
        const textParts = msg.parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.content || p.text || "")
            .filter((t: string) => t.length > 0 && !isSystemInjection(t))

        if (textParts.length > 0) {
            // Truncate long messages
            let content = textParts.join(" ")
            if (content.length > 200) {
                content = content.substring(0, 200) + "..."
            }
            lines.push(`- ${content}`)
        }
    }

    return lines.join("\n")
}

/**
 * Build a summary of recent assistant activity to help advisor understand
 * what the main model is working on.
 */
function buildRecentAssistantActivity(messages: WithParts[]): string {
    const lines: string[] = []

    // Get the last few assistant messages
    const assistantMessages = messages.filter((m) => m.info?.role === "assistant").slice(-3)

    if (assistantMessages.length === 0) {
        return ""
    }

    // Analyze what the assistant has been doing
    const recentTools: string[] = []
    const recentTexts: string[] = []

    for (const msg of assistantMessages) {
        for (const part of msg.parts) {
            const p = part as any
            if (p.type === "tool") {
                // Track tool usage to understand current activity
                const toolName = p.name || p.tool || "unknown"
                if (!recentTools.includes(toolName)) {
                    recentTools.push(toolName)
                }
            } else if (p.type === "text" && (p.content || p.text)) {
                // Track assistant reasoning/responses
                let text = p.content || p.text
                if (text.length > 150) {
                    text = text.substring(0, 150) + "..."
                }
                recentTexts.push(text)
            }
        }
    }

    if (recentTools.length > 0) {
        lines.push(`Tools being used: ${recentTools.join(", ")}`)
    }

    if (recentTexts.length > 0) {
        lines.push("Recent assistant activity:")
        // Only include last 2 text snippets
        for (const text of recentTexts.slice(-2)) {
            lines.push(`- ${text}`)
        }
    }

    return lines.join("\n")
}

/**
 * Calculate the total tokens that would be saved if suggestions are followed.
 */
export function calculatePotentialSavings(
    context: AnalysisContext,
    suggestionIds: string[],
): number {
    let total = 0
    for (const id of suggestionIds) {
        const tool = context.tools.find((t) => t.id === id)
        if (tool) {
            total += tool.tokens
        }
    }
    return total
}

/**
 * Update protection status for rejected suggestions.
 * Called when feedback indicates user ignored a suggestion.
 * Protection duration increases with consecutive rejections: 3 × rejectCount turns.
 */
export function addProtection(
    advisorState: AdvisorState,
    paramKey: string,
    currentTurn: number,
): void {
    advisorState.protectedKeys.add(paramKey)

    // Get existing protection info or create new one
    const existing = advisorState.protectedKeyExpiry.get(paramKey)
    const rejectCount = existing ? existing.rejectCount + 1 : 1

    // Protection duration increases with consecutive rejections, but capped
    const protectionDuration = Math.min(BASE_PROTECTION_TURNS * rejectCount, MAX_PROTECTION_TURNS)
    advisorState.protectedKeyExpiry.set(paramKey, {
        until: currentTurn + protectionDuration,
        rejectCount,
    })
}

/**
 * Clean up expired protections.
 */
export function cleanExpiredProtections(advisorState: AdvisorState, currentTurn: number): void {
    for (const [paramKey, protectionInfo] of advisorState.protectedKeyExpiry) {
        if (currentTurn >= protectionInfo.until) {
            advisorState.protectedKeys.delete(paramKey)
            advisorState.protectedKeyExpiry.delete(paramKey)
        }
    }
}

/**
 * Count prunable tools excluding turn protection and advisor protection.
 * Used for trigger condition evaluation (per docs section 3).
 *
 * @param state - Current session state
 * @param advisorState - Advisor state with protection info
 * @returns Count of tools eligible for pruning suggestions
 */
export function countPrunableTools(state: SessionState, advisorState: AdvisorState): number {
    const prunableList = state.prunableToolIdList ?? []
    const currentTurn = state.currentTurn
    const protectedParamKeys = advisorState.protectedKeys

    let count = 0
    for (const entry of prunableList) {
        const toolParam = state.toolParameters.get(entry.callId)
        if (!toolParam) continue

        // Exclude turn-protected items (younger than TURN_PROTECTION_AGE turns)
        const age = currentTurn - toolParam.turn
        if (age < TURN_PROTECTION_AGE) continue

        // Exclude advisor-protected items (rejected suggestions)
        const paramKey = `${entry.tool}:${extractParameterKey(entry.tool, toolParam.parameters)}`
        if (protectedParamKeys.has(paramKey)) continue

        count++
    }

    return count
}
