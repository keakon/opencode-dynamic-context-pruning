/**
 * Small Model Advisor - Module Exports
 *
 * Central export point for the advisor module.
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

// Types
export type {
    PruneSuggestion,
    SuggestedAction,
    AdvisorResult,
    AdvisorModelResponse,
    PendingSuggestion,
    FeedbackEntry,
    AnalysisContext,
    AnalysisToolEntry,
    AdvisorState,
} from "./types"

export { createAdvisorState } from "./types"

// Trigger logic
export {
    shouldTriggerAdvisor,
    shouldSuppressNudge,
    hasSuggestionToInject,
    resetAdvisorState,
} from "./trigger"

// Context building
export {
    buildAnalysisContext,
    calculatePotentialSavings,
    addProtection,
    cleanExpiredProtections,
    countPrunableTools,
} from "./context"

// Model analysis
export {
    analyzeContext,
    recordAdvisorFailure,
    recordAdvisorSuccess,
    responseToPruneSuggestions,
} from "./analyze"

// Prompt
export { ADVISOR_SYSTEM_PROMPT, buildAdvisorPrompt, estimatePromptTokens } from "./prompt"

// Response parsing
export { parseAdvisorModelResponse } from "./parse"

// Suggestion injection
export { formatAdvisorSuggestion } from "./inject"

// Feedback
export {
    collectFeedbackAtTurnEnd,
    recordFeedback,
    storePendingSuggestion,
    markSuggestionConsumed,
    hasPendingSuggestion,
    getPendingSuggestion,
    advisorTurnStart,
    calculateFeedbackStats,
} from "./feedback"

export type { FeedbackStats } from "./feedback"
