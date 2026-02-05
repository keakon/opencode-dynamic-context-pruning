/**
 * Small Model Advisor - Response Parsing
 *
 * Parses and validates the response from the advisor model.
 * Handles malformed JSON and invalid suggestions gracefully.
 * IDs are normalized to strings as per docs/SMALL_MODEL_ADVISOR.md specification.
 */

import type { AdvisorModelResponse, SuggestedAction } from "./types"

/** Valid action values */
const VALID_ACTIONS: Set<SuggestedAction> = new Set(["discard", "extract"])

/**
 * Normalize an ID to string format. Accepts both string and number inputs.
 * Always returns the canonical string form (e.g., "01" → "1", "  2  " → "2").
 */
function normalizeId(id: unknown, maxId: number, allowedIds?: Set<string>): string | null {
    if (typeof id === "string") {
        const trimmed = id.trim()
        const num = parseInt(trimmed, 10)
        if (!Number.isNaN(num) && num >= 0 && num <= maxId) {
            // Normalize to canonical string form (removes leading zeros, whitespace)
            const normalized = String(num)
            if (allowedIds && !allowedIds.has(normalized)) {
                return null
            }
            return normalized
        }
    } else if (typeof id === "number" && Number.isInteger(id) && id >= 0 && id <= maxId) {
        const normalized = String(id)
        if (allowedIds && !allowedIds.has(normalized)) {
            return null
        }
        return normalized
    }
    return null
}

/**
 * Parse the advisor model response into structured format.
 * Expected format: { discardIds: string[], extractItems: [[id, summary], ...], reasoning: string }
 * Also accepts numeric IDs for backward compatibility with older models.
 *
 * @param response - Raw response string from the model
 * @param maxId - Maximum valid ID index (for validation)
 * @returns Parsed response and any parse error
 */
export function parseAdvisorModelResponse(
    response: string,
    maxId: number,
    allowedIds?: Set<string>,
): { response: AdvisorModelResponse | null; parseError?: string } {
    // Try to extract JSON object from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
        // Check for empty/no-op responses
        if (response.trim() === "" || response.includes("No pruning needed")) {
            return {
                response: {
                    discardIds: [],
                    extractItems: [],
                    reasoning: "No pruning needed",
                },
            }
        }
        return { response: null, parseError: "No JSON object found in response" }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
        return { response: null, parseError: `JSON parse error: ${e}` }
    }

    if (!parsed || typeof parsed !== "object") {
        return { response: null, parseError: "Response is not an object" }
    }

    const obj = parsed as Record<string, unknown>

    // Validate and extract discardIds (accept both string and number)
    const discardIds: string[] = []
    if (Array.isArray(obj.discardIds)) {
        for (const id of obj.discardIds) {
            const normalizedId = normalizeId(id, maxId, allowedIds)
            if (normalizedId !== null) {
                discardIds.push(normalizedId)
            }
        }
    }

    // Validate and extract extractItems (accept both string and number IDs)
    const extractItems: [string, string][] = []
    if (Array.isArray(obj.extractItems)) {
        for (const item of obj.extractItems) {
            if (Array.isArray(item) && item.length >= 2) {
                const normalizedId = normalizeId(item[0], maxId, allowedIds)
                const summary = item[1]
                if (normalizedId !== null && typeof summary === "string" && summary.trim()) {
                    // Truncate summary to MAX_SUMMARY_LENGTH (per docs spec)
                    extractItems.push([normalizedId, truncateSummary(summary)])
                }
            }
        }
    }

    // Extract reasoning
    const reasoning =
        typeof obj.reasoning === "string" && obj.reasoning.trim()
            ? obj.reasoning.trim()
            : "No reasoning provided"

    // Ensure no duplicate IDs between discard and extract
    const extractIds = new Set(extractItems.map(([id]) => id))
    const finalDiscardIds = discardIds.filter((id) => !extractIds.has(id))

    // Deduplicate within each list
    const uniqueDiscardIds = [...new Set(finalDiscardIds)]
    const seenExtractIds = new Set<string>()
    const uniqueExtractItems: [string, string][] = []
    for (const [id, summary] of extractItems) {
        if (!seenExtractIds.has(id)) {
            seenExtractIds.add(id)
            uniqueExtractItems.push([id, summary])
        }
    }

    return {
        response: {
            discardIds: uniqueDiscardIds,
            extractItems: uniqueExtractItems,
            reasoning,
        },
    }
}

// Maximum summary length per docs spec
const MAX_SUMMARY_LENGTH = 100

/**
 * Truncate summary to max length, ensuring we don't cut in the middle of a word.
 */
function truncateSummary(summary: string): string {
    const trimmed = summary.trim()
    if (trimmed.length <= MAX_SUMMARY_LENGTH) {
        return trimmed
    }
    // Truncate and add ellipsis
    return trimmed.slice(0, MAX_SUMMARY_LENGTH - 3) + "..."
}

/**
 * Legacy function name for backward compatibility.
 * @deprecated Use parseAdvisorModelResponse instead
 */
export const parseAdvisorResponse = parseAdvisorModelResponse
