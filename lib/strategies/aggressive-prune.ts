import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isToolCallProtected } from "../protected-file-patterns"
import { getUnprunedToolIds, getToolTokens } from "./utils"
import { addPruneToolIds } from "../shared-utils"

interface ToolTokenInfo {
    id: string
    tokens: number
    index: number
    isError: boolean
}

/**
 * Aggressive pruning strategy - automatically prunes tool calls based on
 * token thresholds and tool value.
 *
 * Two-tier approach:
 * 1. At warnThreshold: prune error/low-value tools first
 * 2. At criticalThreshold: prune oldest tools regardless of type
 *
 * Both tiers target warnThreshold as the goal, providing a 40k buffer.
 * Sets aggressivePruneExhausted flag if still above criticalThreshold after pruning.
 */
export const aggressivePrune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (!config.tokenBudget.enabled) {
        return
    }

    const unprunedIds = getUnprunedToolIds(state, messages)
    if (!unprunedIds || unprunedIds.length === 0) {
        state.stats.currentPrunableTokens = 0
        return
    }

    const protectedTools = config.tools.settings.protectedTools

    // Calculate tokens for each unpruned, non-protected tool
    const toolTokenInfos: ToolTokenInfo[] = []
    let totalTokens = 0

    for (let i = 0; i < unprunedIds.length; i++) {
        const id = unprunedIds[i]
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        // Skip protected tools - they can never be auto-pruned
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

        const tokens = getToolTokens(state, messages, id)
        if (tokens === 0) {
            continue // Skip tools with no prunable content
        }
        totalTokens += tokens
        toolTokenInfos.push({
            id,
            tokens,
            index: i,
            isError: metadata.status === "error",
        })
    }

    // Store current token count for nudge decision
    state.stats.currentPrunableTokens = totalTokens

    if (totalTokens === 0 || toolTokenInfos.length === 0) {
        return
    }

    const { warnThreshold, criticalThreshold } = config.tokenBudget
    const toPrune: string[] = []
    let remainingTokens = totalTokens

    // Tier 1: At warnThreshold, prune error tools first (low-value cleanup)
    if (totalTokens >= warnThreshold) {
        const errorTools = toolTokenInfos.filter((t) => t.isError)
        if (errorTools.length > 0) {
            // Sort error tools by index (oldest first)
            errorTools.sort((a, b) => a.index - b.index)

            for (const info of errorTools) {
                toPrune.push(info.id)
                remainingTokens -= info.tokens
                // Stop if we're below warnThreshold
                if (remainingTokens < warnThreshold) {
                    break
                }
            }

            if (toPrune.length > 0) {
                logger.info(
                    `Early prune: marked ${toPrune.length} error tools for pruning ` +
                        `(${totalTokens - remainingTokens} tokens freed)`,
                )
            }
        }
    }

    // Tier 2: At criticalThreshold, prune oldest tools until below warnThreshold.
    // Note: remainingTokens here is AFTER Tier1 pruning, not the original totalTokens.
    if (remainingTokens >= criticalThreshold) {
        logger.info(
            `Aggressive prune triggered: ${remainingTokens} tokens >= ${criticalThreshold} criticalThreshold`,
        )

        // Get remaining (non-error or not yet pruned) tools
        const prunedSet = new Set(toPrune)
        const remainingTools = toolTokenInfos.filter((t) => !prunedSet.has(t.id))

        // Sort by index (oldest first)
        remainingTools.sort((a, b) => a.index - b.index)

        for (const info of remainingTools) {
            if (remainingTokens < warnThreshold) {
                break
            }
            toPrune.push(info.id)
            remainingTokens -= info.tokens
        }
    }

    // Set exhausted flag if still above criticalThreshold after pruning.
    // Note: also reset in getNudgeUrgency() when non-token triggers fire.
    state.aggressivePruneExhausted = remainingTokens >= criticalThreshold

    if (toPrune.length > 0) {
        const tokensFreed = totalTokens - remainingTokens
        state.stats.totalPruneTokens += tokensFreed
        addPruneToolIds(state, toPrune)
        logger.info(
            `Aggressive prune complete: marked ${toPrune.length} tools for pruning ` +
                `(${tokensFreed} tokens freed, ${remainingTokens} remaining)`,
        )
    }

    // Update current token count
    state.stats.currentPrunableTokens = remainingTokens
}
