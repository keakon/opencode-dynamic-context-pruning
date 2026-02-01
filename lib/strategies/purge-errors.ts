import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isToolCallProtected } from "../protected-file-patterns"
import { calculateTokensSaved, getUnprunedToolIds } from "./utils"
import { addPruneToolIds } from "../shared-utils"

/**
 * Purge Errors strategy - prunes tool inputs for tools that errored
 * after they are older than a configurable number of turns.
 * The error message is preserved, but the (potentially large) inputs
 * are removed to save context.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const purgeErrors = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (!config.strategies.purgeErrors.enabled) {
        return
    }

    const unprunedIds = getUnprunedToolIds(state, messages)
    if (!unprunedIds) {
        return
    }

    const protectedTools = config.strategies.purgeErrors.protectedTools
    const turnThreshold = config.strategies.purgeErrors.turns

    const newPruneIds: string[] = []

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        // Skip protected tools
        if (isToolCallProtected(
            metadata.tool,
            metadata.parameters,
            protectedTools,
            config.protectedFilePatterns,
        )) {
            continue
        }

        // Only process error tools
        if (metadata.status !== "error") {
            continue
        }

        // Check if the tool is old enough to prune
        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            newPruneIds.push(id)
        }
    }

    if (newPruneIds.length > 0) {
        state.stats.totalPruneTokens += calculateTokensSaved(state, messages, newPruneIds)
        addPruneToolIds(state, newPruneIds)
        logger.debug(
            `Marked ${newPruneIds.length} error tool calls for pruning (older than ${turnThreshold} turns)`,
        )
    }
}
