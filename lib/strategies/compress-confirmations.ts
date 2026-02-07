import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../shared-utils"

/**
 * Per-tool confirmation output patterns.
 * Each tool has specific regex patterns that identify its "confirmation" outputs.
 * Only outputs matching these exact patterns will be compressed.
 *
 * See: docs/COST_OPTIMIZATION_PLAN.md section 4.2 (P2b)
 */
const TOOL_CONFIRMATION_PATTERNS: Record<string, RegExp[]> = {
    edit: [/^Edit applied successfully/],
    write: [/^Successfully wrote to/],
    bash: [/^\d+ files? (changed|created|deleted)/, /^Created commit [a-f0-9]+/],
    prune: [/^Context pruning complete/, /^Pruned \d+ items/],
}

/**
 * Tools whose outputs should never be compressed, regardless of content.
 * Information-retrieval tools, error outputs, and protected tools are excluded.
 */
const NEVER_COMPRESS_TOOLS = new Set([
    "read",
    "glob",
    "grep",
    "lsp",
    "task",
    "todowrite",
    "todoread",
])

const CONFIRMED_PLACEHOLDER = "[Confirmed]"

/**
 * CompressConfirmations strategy - replaces short confirmation-style tool outputs
 * with "[Confirmed]" after they exceed a configurable turn age.
 *
 * Unlike other pruning strategies that mark IDs for later removal via addPruneToolIds,
 * this strategy performs **in-place text replacement** to preserve the semantic signal
 * that the operation succeeded while reducing token usage.
 *
 * Targets specific tool + output pattern combinations:
 * - Edit: "Edit applied successfully..."
 * - Write: "Successfully wrote to..."
 * - Bash: "N files changed/created/deleted", "Created commit ..."
 * - Prune: "Context pruning complete...", "Pruned N items..."
 *
 * Does NOT compress:
 * - Read, Glob, Grep, Lsp (information-retrieval tools)
 * - Task, TodoWrite, TodoRead (protected tools)
 * - Error outputs (status !== "completed")
 * - Outputs longer than maxLength (default 500 characters)
 * - Already compressed or pruned outputs
 *
 * See: docs/COST_OPTIMIZATION_PLAN.md section 4.2 (P2b)
 */
export const compressConfirmations = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    const strategyConfig = config.strategies.compressConfirmations
    if (!strategyConfig.enabled) {
        return
    }

    const turnThreshold = strategyConfig.turns
    const maxLength = strategyConfig.maxLength
    let compressedCount = 0

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }

            // Only compress completed (successful) outputs
            if (part.state.status !== "completed") {
                continue
            }

            const toolName = (part.tool || "").toLowerCase()

            // Skip tools that should never be compressed
            if (NEVER_COMPRESS_TOOLS.has(toolName)) {
                continue
            }

            // Skip tools with no matching confirmation patterns
            const patterns = TOOL_CONFIRMATION_PATTERNS[toolName]
            if (!patterns) {
                continue
            }

            // Skip already-pruned or already-compressed tools
            if (state.prune.toolIdSet.has(part.callID)) {
                continue
            }

            // Check turn age
            const metadata = state.toolParameters.get(part.callID)
            if (!metadata) {
                continue
            }
            const turnAge = state.currentTurn - metadata.turn
            if (turnAge < turnThreshold) {
                continue
            }

            // Get output content
            const output = part.state.output
            if (output == null || output === CONFIRMED_PLACEHOLDER) {
                continue
            }
            const content = typeof output === "string" ? output : JSON.stringify(output)

            // Skip outputs that are too long (may contain important details)
            if (content.length > maxLength) {
                continue
            }

            // Check if content matches any confirmation pattern for this tool
            if (!patterns.some((p) => p.test(content))) {
                continue
            }

            // Replace with [Confirmed]
            part.state.output = CONFIRMED_PLACEHOLDER
            compressedCount++

            // Track earliest modified message for selective stale block cleaning
            if (state.earliestModifiedMsgIndex === -1 || i < state.earliestModifiedMsgIndex) {
                state.earliestModifiedMsgIndex = i
            }
        }
    }

    if (compressedCount > 0) {
        logger.debug(
            `CompressConfirmations: Compressed ${compressedCount} confirmation outputs to ${CONFIRMED_PLACEHOLDER}`,
        )
    }
}
