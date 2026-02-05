/**
 * Small Model Advisor - Suggestion Injection
 *
 * Injects advisor suggestions into the context.
 * Uses <advisor-suggestion> format as specified in docs/SMALL_MODEL_ADVISOR.md.
 * Suggestions are formatted as actionable guidance for the main model.
 */

import type { PendingSuggestion, AnalysisContext, PruneSuggestion } from "./types"

/**
 * Format advisor suggestions for injection into the context.
 * Uses the <advisor-suggestion> (singular) tag per document spec.
 * Uses compact format: Discard: [...] / Extract: [...] / Reasoning (per docs 7.1).
 * Should be injected BEFORE <prunable-tools> in the message.
 *
 * @param pendingSuggestion - The pending suggestion to inject
 * @param context - Analysis context for tool info resolution
 * @returns Formatted suggestion text to inject
 */
export function formatAdvisorSuggestion(
    pendingSuggestion: PendingSuggestion,
    context: AnalysisContext,
): string {
    const suggestions = pendingSuggestion.suggestions
    if (suggestions.length === 0) {
        return ""
    }

    const lines: string[] = []

    lines.push("<advisor-suggestion>")

    // Group by action type
    const discards = suggestions.filter((s) => s.action === "discard")
    const extracts = suggestions.filter((s) => s.action === "extract")

    // Compact format: Discard: [id1, id2, ...] (per docs 7.1)
    if (discards.length > 0) {
        const ids = discards.map((s) => s.id).join(", ")
        lines.push(`Discard: [${ids}]`)
    }

    // Compact format: Extract: [id → "summary", ...] (per docs 7.1)
    if (extracts.length > 0) {
        const items = extracts.map((s) => {
            const summary = s.summary ?? ""
            // Per docs 7.1: max 50 chars with "..." suffix if truncated
            const shortSummary = summary.length > 50 ? summary.slice(0, 50) + "..." : summary
            return `${s.id} → "${shortSummary}"`
        })
        lines.push(`Extract: [${items.join(", ")}]`)
    }

    if (pendingSuggestion.reasoning) {
        lines.push(`Reasoning: ${pendingSuggestion.reasoning}`)
    }

    // Hint for accepting suggestions (per docs 7.1)
    lines.push("Use discard/extract tools to accept suggestions.")

    lines.push("</advisor-suggestion>")

    return lines.join("\n")
}

/**
 * Build a minimal suggestion summary for logging/debug.
 */
export function buildSuggestionSummary(suggestions: PruneSuggestion[]): string {
    const discardCount = suggestions.filter((s) => s.action === "discard").length
    const extractCount = suggestions.filter((s) => s.action === "extract").length

    const parts: string[] = []
    if (discardCount > 0) parts.push(`${discardCount} discard`)
    if (extractCount > 0) parts.push(`${extractCount} extract`)

    return `Advisor suggests: ${parts.join(", ")}`
}
