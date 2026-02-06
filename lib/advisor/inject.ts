/**
 * Small Model Advisor - Suggestion Injection
 *
 * Injects advisor suggestions into the context.
 * Uses <advisor-suggestion> format as specified in docs/SMALL_MODEL_ADVISOR.md.
 * Suggestions are formatted as actionable guidance for the main model.
 */

import type { PendingSuggestion } from "./types"

/**
 * Format advisor suggestions for injection into the context.
 * Uses the <advisor-suggestion> (singular) tag per document spec.
 * Uses compact format: Discard: [...] / Extract: [...] / Reasoning (per docs 7.1).
 * Should be injected BEFORE <prunable-tools> in the message.
 *
 * @param pendingSuggestion - The pending suggestion to inject
 * @returns Formatted suggestion text to inject
 */
export function formatAdvisorSuggestion(pendingSuggestion: PendingSuggestion): string {
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
            const summary = (s.summary ?? "").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()
            return `${s.id} → "${summary}"`
        })
        lines.push(`Extract: [${items.join(", ")}]`)
    }

    if (pendingSuggestion.reasoning) {
        lines.push(`Reasoning: ${pendingSuggestion.reasoning}`)
    }

    // Hint for accepting suggestions (per docs 7.1)
    lines.push("Use the prune tool to accept suggestions.")

    lines.push("</advisor-suggestion>")

    return lines.join("\n")
}
