/**
 * Small Model Advisor - Feedback Collection
 *
 * Tracks whether the main model followed advisor suggestions.
 * Collects feedback at turn end to improve future suggestions.
 * Implements protection for rejected suggestions.
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

import type { SessionState } from "../state"
import type { AdvisorState, FeedbackEntry, PendingSuggestion, PruneSuggestion } from "./types"
import { addProtection, cleanExpiredProtections } from "./context"

/** Maximum feedback history entries to keep */
const MAX_FEEDBACK_HISTORY = 50

/**
 * Collect feedback by comparing pending suggestions against actual state.
 * Called at the START of a new turn to see what the user did in the previous turn.
 *
 * Acceptance is determined by checking if the tool is still in the prunable list:
 * - If callId no longer exists in prunableToolIdList → accepted (was pruned somehow)
 * - If callId exists but is in state.prune.toolIdSet → accepted (marked for pruning)
 * - If callId exists and not in prune set → rejected (user chose to keep it)
 *
 * This approach correctly handles both:
 * - Automatic pruning strategies
 * - User-initiated discard/extract tool operations
 *
 * @param state - Current session state
 * @param advisorState - Advisor state with pending suggestion
 * @returns Feedback entries for the pending suggestion
 */
export function collectFeedbackAtTurnEnd(
    state: SessionState,
    advisorState: AdvisorState,
): FeedbackEntry[] {
    const feedback: FeedbackEntry[] = []
    const pending = advisorState.pendingSuggestion

    // No pending suggestion or not yet consumed (shown to main model)
    if (!pending || !pending.consumed) {
        return feedback
    }

    const currentTurn = state.currentTurn

    // Don't collect feedback for suggestions generated in the same turn (per docs)
    // This prevents false rejection detection when turn hasn't advanced
    if (pending.turn >= currentTurn) {
        return feedback
    }

    const prunableList = state.prunableToolIdList ?? []
    const prunedToolIdSet = state.prune?.toolIdSet ?? new Set<string>()

    // Build a lookup from the original callIds to check existence
    const callIdToEntry = new Map<string, boolean>()
    for (const entry of prunableList) {
        callIdToEntry.set(entry.callId, true)
    }

    for (const suggestion of pending.suggestions) {
        // Get the paramKey and callId for this suggestion
        const paramKey = pending.idToParamKey.get(suggestion.id)
        const callId = pending.idToCallId?.get(suggestion.id)
        if (!paramKey || !callId) continue

        // Determine acceptance:
        // 1. If callId no longer in prunable list → it was fully removed → accepted
        // 2. If callId is in prune.toolIdSet → it was marked for pruning → accepted
        // 3. Otherwise → rejected
        let accepted = false
        let reason: string | undefined
        let alternativeAction: string | undefined

        if (!callIdToEntry.has(callId)) {
            // Tool was completely removed from prunable list
            accepted = true
        } else if (prunedToolIdSet.has(callId)) {
            // Tool is marked for pruning
            accepted = true
        } else {
            // Rejected - infer reason based on context
            // Check if extract was suggested but the content was kept entirely
            if (suggestion.action === "discard") {
                reason = "Content deemed necessary - kept for potential future use"
                alternativeAction = "kept"
            } else if (suggestion.action === "extract") {
                reason = "Original content preferred over summarization"
                alternativeAction = "kept without extraction"
            }
        }

        const feedbackEntry: FeedbackEntry = {
            paramKey,
            suggestedAction: suggestion.action,
            accepted,
            turn: currentTurn,
            reason,
            alternativeAction,
        }

        feedback.push(feedbackEntry)

        // If rejected, add protection to prevent re-suggesting
        if (!accepted) {
            addProtection(advisorState, paramKey, currentTurn)
        }
    }

    return feedback
}

/**
 * Record feedback into the advisor state.
 * Keeps a rolling window of feedback to bound memory usage.
 */
export function recordFeedback(advisorState: AdvisorState, feedback: FeedbackEntry[]): void {
    if (feedback.length === 0) return

    advisorState.feedbackHistory.push(...feedback)

    // Trim to max history size
    if (advisorState.feedbackHistory.length > MAX_FEEDBACK_HISTORY) {
        advisorState.feedbackHistory = advisorState.feedbackHistory.slice(-MAX_FEEDBACK_HISTORY)
    }

    // Clear pending suggestion after feedback is collected
    advisorState.pendingSuggestion = null
}

/**
 * Store a new pending suggestion.
 * Only one suggestion can be pending at a time (serial guarantee).
 *
 * @param advisorState - Advisor state
 * @param suggestions - Parsed suggestions from advisor (string IDs)
 * @param reasoning - Reasoning from advisor
 * @param currentTurn - Current turn number
 * @param idToParamKey - Map from ID to paramKey for feedback tracking
 * @param idToCallId - Map from ID to callId for acceptance checking
 */
export function storePendingSuggestion(
    advisorState: AdvisorState,
    suggestions: { id: string; action: "discard" | "extract"; summary?: string }[],
    reasoning: string,
    currentTurn: number,
    idToParamKey: Map<string, string>,
    idToCallId: Map<string, string>,
): void {
    advisorState.pendingSuggestion = {
        suggestions: suggestions.map((s) => ({
            id: s.id,
            action: s.action,
            summary: s.summary,
        })),
        reasoning,
        turn: currentTurn,
        consumed: false,
        idToParamKey: new Map(idToParamKey),
        idToCallId: new Map(idToCallId),
    }
}

/**
 * Mark the pending suggestion as consumed (injected into context).
 */
export function markSuggestionConsumed(advisorState: AdvisorState): void {
    if (advisorState.pendingSuggestion) {
        advisorState.pendingSuggestion.consumed = true
    }
}

/**
 * Check if there's a pending unconsumed suggestion ready to inject.
 */
export function hasPendingSuggestion(advisorState: AdvisorState): boolean {
    return advisorState.pendingSuggestion !== null && !advisorState.pendingSuggestion.consumed
}

/**
 * Get the pending suggestion if available and not consumed.
 */
export function getPendingSuggestion(advisorState: AdvisorState): PendingSuggestion | null {
    if (advisorState.pendingSuggestion && !advisorState.pendingSuggestion.consumed) {
        return advisorState.pendingSuggestion
    }
    return null
}

/**
 * Perform cleanup tasks at the start of a new turn:
 * 1. Clean expired protections
 * 2. Clean expired pending suggestions (unconsumed for more than 2 turns)
 */
const SUGGESTION_EXPIRY_TURNS = 2

export function advisorTurnStart(advisorState: AdvisorState, currentTurn: number): void {
    cleanExpiredProtections(advisorState, currentTurn)

    // Clean expired pending suggestions: unconsumed and older than SUGGESTION_EXPIRY_TURNS
    if (advisorState.pendingSuggestion) {
        const suggestionAge = currentTurn - advisorState.pendingSuggestion.turn
        if (!advisorState.pendingSuggestion.consumed && suggestionAge > SUGGESTION_EXPIRY_TURNS) {
            advisorState.pendingSuggestion = null
        }
    }
}

/**
 * Calculate aggregate feedback statistics for debugging/monitoring.
 */
export interface FeedbackStats {
    totalSuggestions: number
    acceptedSuggestions: number
    rejectedSuggestions: number
    acceptanceRate: number
}

export function calculateFeedbackStats(advisorState: AdvisorState): FeedbackStats {
    const history = advisorState.feedbackHistory
    const total = history.length
    const accepted = history.filter((f) => f.accepted).length
    const rejected = total - accepted

    return {
        totalSuggestions: total,
        acceptedSuggestions: accepted,
        rejectedSuggestions: rejected,
        acceptanceRate: total > 0 ? accepted / total : 0,
    }
}
