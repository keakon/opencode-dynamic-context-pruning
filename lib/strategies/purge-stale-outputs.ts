import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isToolCallProtected } from "../protected-file-patterns"
import { calculateTokensSaved, getUnprunedToolIds } from "./utils"
import { addPruneToolIds } from "../shared-utils"

/**
 * PurgeStaleOutputs strategy - prunes tool outputs that are considered "stale"
 * based on their age (turn count) and the total number of prunable tools.
 *
 * This strategy is designed to work automatically without requiring AI intervention,
 * reducing the need for injecting prunable-tools lists and thereby improving
 * prompt cache hit rates.
 *
 * Key differences from AggressivePrune:
 * - PurgeStaleOutputs: Based on tool count and age, preserves recent outputs per tool type
 * - AggressivePrune: Based on token budget, prunes oldest first regardless of type
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const purgeStaleOutputs = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    const strategyConfig = config.strategies.purgeStaleOutputs
    if (!strategyConfig.enabled) {
        return
    }

    const unprunedIds = getUnprunedToolIds(state, messages)
    if (!unprunedIds || unprunedIds.length < strategyConfig.minPrunableCount) {
        return
    }

    const turnThreshold = strategyConfig.turns
    const preserveRecent = strategyConfig.preserveRecent
    const protectedTools = [
        ...config.tools.settings.protectedTools,
        ...strategyConfig.protectedTools,
    ]

    // Group tools by type and track their metadata
    const toolsByType = new Map<string, Array<{ id: string; turn: number }>>()

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        // Skip protected tools
        if (
            isToolCallProtected(
                metadata.tool,
                metadata.parameters,
                protectedTools,
                config.protectedFilePatterns,
            )
        ) {
            continue
        }

        const toolType = metadata.tool.toLowerCase()
        if (!toolsByType.has(toolType)) {
            toolsByType.set(toolType, [])
        }
        toolsByType.get(toolType)!.push({ id, turn: metadata.turn })
    }

    const newPruneIds: string[] = []

    // For each tool type, keep the most recent N outputs, prune stale ones
    for (const [, tools] of toolsByType) {
        // Sort by turn descending (most recent first)
        tools.sort((a, b) => b.turn - a.turn)

        // Iterate through tools, skipping the most recent ones
        for (let i = 0; i < tools.length; i++) {
            const tool = tools[i]
            const turnAge = state.currentTurn - tool.turn

            // Keep the most recent `preserveRecent` tools of this type
            if (i < preserveRecent) {
                continue
            }

            // Prune if the tool is old enough
            if (turnAge >= turnThreshold) {
                newPruneIds.push(tool.id)
            }
        }
    }

    if (newPruneIds.length > 0) {
        state.stats.totalPruneTokens += calculateTokensSaved(state, messages, newPruneIds)
        addPruneToolIds(state, newPruneIds)
        logger.debug(
            `PurgeStaleOutputs: Marked ${newPruneIds.length} stale tool outputs for pruning ` +
                `(older than ${turnThreshold} turns, preserved ${preserveRecent} recent per type)`,
        )
    }
}
