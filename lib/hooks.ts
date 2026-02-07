import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import {
    deduplicate,
    supersedeWrites,
    purgeErrors,
    purgeStaleOutputs,
    aggressivePrune,
} from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { loadPrompt } from "./prompts"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"
import { handleHelpCommand } from "./commands/help"
import { handleSweepCommand } from "./commands/sweep"
import { cleanupPruneState } from "./shared-utils"
import { buildToolIdList, computeLastMsgToolStateHash } from "./messages/utils"
import {
    shouldTriggerAdvisor,
    shouldSuppressNudge,
    buildAnalysisContext,
    analyzeContext,
    formatAdvisorSuggestion,
    storePendingSuggestion,
    markSuggestionConsumed,
    hasPendingSuggestion,
    getPendingSuggestion,
    countPrunableTools,
    recordAdvisorFailure,
    recordAdvisorSuccess,
    responseToPruneSuggestions,
    collectFeedbackAtTurnEnd,
    recordFeedback,
    advisorTurnStart,
} from "./advisor"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

/**
 * Validate small_model advisor configuration format at startup.
 * Only validates fallbackModels format if provided (fallbackModels is optional).
 * Per docs: "留空则仅使用 OpenCode 的 small_model"
 *
 * @param config - Plugin configuration
 * @param logger - Logger instance
 * @returns true if valid or advisor disabled, false if invalid and now disabled
 */
function validateSmallModelConfig(config: PluginConfig, logger: Logger): boolean {
    const advisorConfig = config.smallModelAdvisor
    if (!advisorConfig?.enabled) {
        return true // Advisor disabled, no validation needed
    }

    // fallbackModels is optional - empty means use OpenCode's small_model only
    // Only validate format if models are provided
    const models = advisorConfig.fallbackModels
    if (models && models.length > 0) {
        for (const model of models) {
            const parts = model.split("/")
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                logger.warn(
                    `[advisor] Invalid fallback model format: "${model}", expected "provider/model". Disabling advisor.`,
                )
                advisorConfig.enabled = false
                return false
            }
        }
    }

    return true
}

/**
 * Run the small model advisor analysis asynchronously.
 * The result is stored in advisorState.pendingSuggestion for the NEXT turn.
 * This function is fire-and-forget (does not block the main flow).
 */
async function runAdvisorAsync(
    client: any,
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    const advisorState = state.advisor
    const advisorConfig = config.smallModelAdvisor

    if (!advisorConfig?.enabled) {
        return
    }

    // Mark analysis as in progress
    advisorState.advisorInProgress = true

    try {
        // Build analysis context
        const context = buildAnalysisContext(state, config, messages, advisorState)

        if (context.tools.length === 0) {
            return
        }

        if (advisorConfig.debug) {
            logger.info(
                `[advisor] Starting analysis: ${context.tools.length} tools, ${context.currentTokens} tokens`,
            )
        }

        // Call the small model via temporary session
        const result = await analyzeContext(client, context, advisorConfig, advisorState, logger)

        if (!result.success) {
            recordAdvisorFailure(advisorState)
            if (advisorConfig.debug) {
                logger.info(`[advisor] Analysis failed: ${result.error}`)
            }
            return
        }

        recordAdvisorSuccess(advisorState)

        if (!result.response) {
            return
        }

        // Check if there are any suggestions
        const suggestions = responseToPruneSuggestions(result.response)
        if (suggestions.length === 0) {
            if (advisorConfig.debug) {
                logger.info("[advisor] No suggestions from analysis")
            }
            return
        }

        // Store pending suggestion for next turn
        storePendingSuggestion(
            advisorState,
            suggestions,
            result.response.reasoning,
            state.currentTurn,
            result.idToParamKey,
            result.idToCallId,
        )

        if (advisorConfig.debug) {
            logger.info(
                `[advisor] Stored ${suggestions.length} suggestions for next turn injection`,
            )
        }
    } catch (error: any) {
        recordAdvisorFailure(advisorState)
        if (advisorConfig?.debug) {
            logger.info(`[advisor] Error: ${error.message}`)
        }
    } finally {
        advisorState.advisorInProgress = false
    }
}

/**
 * Inject advisor suggestions into the message context.
 * Uses the <advisor-suggestion> format, injected BEFORE <prunable-tools>.
 */
function injectAdvisorSuggestions(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    logger: Logger,
): void {
    const advisorState = state.advisor
    const pending = getPendingSuggestion(advisorState)

    if (!pending || messages.length === 0) {
        return
    }

    // Format the suggestion
    const suggestionText = formatAdvisorSuggestion(pending)
    if (!suggestionText) {
        return
    }

    // Find the last user message to append to
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "user") continue

        // Look for a text part to append to
        for (let j = msg.parts.length - 1; j >= 0; j--) {
            const part = msg.parts[j]
            if (part.type === "text") {
                const textPart = part as any
                if (typeof textPart.text === "string") {
                    // Inject BEFORE the prunable-tools list if present
                    const prunableIndex = textPart.text.indexOf("<prunable-tools>")
                    if (prunableIndex !== -1) {
                        textPart.text =
                            textPart.text.slice(0, prunableIndex) +
                            suggestionText +
                            "\n\n" +
                            textPart.text.slice(prunableIndex)
                    } else {
                        textPart.text += `\n\n${suggestionText}`
                    }
                    // Mark as consumed
                    markSuggestionConsumed(advisorState)

                    if (config.smallModelAdvisor?.debug) {
                        logger.info("[advisor] Injected suggestions into context")
                    }
                    return
                }
            }
        }

        // If no text part found, create one
        const newPart = {
            type: "text" as const,
            text: suggestionText,
        }
        msg.parts.push(newPart as any)
        markSuggestionConsumed(advisorState)
        return
    }
}

/**
 * Collect feedback from previous turn's suggestions.
 * Called at the start of each turn to see what the user did.
 */
function collectAdvisorFeedback(state: SessionState, config: PluginConfig, logger: Logger): void {
    const advisorState = state.advisor
    const advisorConfig = config.smallModelAdvisor

    if (!advisorConfig?.enabled) {
        return
    }

    // Only collect feedback if there was a consumed suggestion
    if (!advisorState.pendingSuggestion || !advisorState.pendingSuggestion.consumed) {
        return
    }

    // Collect feedback based on actual prune state (no need for lastPrunedCallIds)
    const feedback = collectFeedbackAtTurnEnd(state, advisorState)

    if (feedback.length > 0) {
        recordFeedback(advisorState, feedback)

        if (advisorConfig.debug) {
            const accepted = feedback.filter((f) => f.accepted).length
            const rejected = feedback.length - accepted
            logger.info(`[advisor] Feedback collected: ${accepted} accepted, ${rejected} rejected`)
        }
    }
}

/**
 * Collect cache metrics from assistant messages that haven't been processed yet.
 * This captures cache_read, cache_write, input, output, and reasoning token counts
 * from each API response for before/after optimization comparison.
 */
function collectCacheMetrics(state: SessionState, messages: WithParts[], logger: Logger): void {
    const metrics = state.cacheMetrics

    // Scan backwards for new assistant messages with token data
    const newEntries: WithParts[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        if ((msg.info as any).summary === true) continue // Skip compaction summaries

        const tokens = (msg.info as any).tokens
        if (!tokens || (!tokens.input && !tokens.output && !tokens.cache?.read)) continue

        if (msg.info.id === metrics.lastProcessedMsgId) break // Already processed
        newEntries.push(msg)
    }

    if (newEntries.length === 0) return

    // Process in chronological order (newEntries is reversed)
    for (let i = newEntries.length - 1; i >= 0; i--) {
        const msg = newEntries[i]
        const tokens = (msg.info as any).tokens

        const cacheRead = tokens.cache?.read || 0
        const cacheWrite = tokens.cache?.write || 0
        const input = tokens.input || 0
        const output = tokens.output || 0
        const reasoning = tokens.reasoning || 0

        metrics.totalCacheRead += cacheRead
        metrics.totalCacheWrite += cacheWrite
        metrics.totalInput += input
        metrics.totalOutput += output
        metrics.totalReasoning += reasoning
        metrics.requestCount++
        metrics.turnHistory.push({
            turn: state.currentTurn,
            cacheRead,
            cacheWrite,
            input,
            output,
            reasoning,
            timestamp: new Date().toISOString(),
        })
        metrics.lastProcessedMsgId = msg.info.id
    }

    // Cap history size to prevent unbounded growth
    const MAX_HISTORY = 1000
    if (metrics.turnHistory.length > MAX_HISTORY) {
        metrics.turnHistory = metrics.turnHistory.slice(-MAX_HISTORY)
    }

    logger.debug(`Collected cache metrics from ${newEntries.length} new response(s)`, {
        requestCount: metrics.requestCount,
        cacheHitRate:
            metrics.totalCacheRead + metrics.totalInput > 0
                ? (
                      (metrics.totalCacheRead / (metrics.totalCacheRead + metrics.totalInput)) *
                      100
                  ).toFixed(1) + "%"
                : "N/A",
    })
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (_input: unknown, output: { system: string[] }) => {
        if (state.isSubAgent) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        if (!config.tools.prune.enabled) {
            return
        }

        const syntheticPrompt = loadPrompt("system/system-prompt-both")
        output.system.push(syntheticPrompt)
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    // Validate small_model configuration at startup (per docs recommendation)
    validateSmallModelConfig(config, logger)

    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, output.messages)

        if (state.isSubAgent) {
            return
        }

        // Collect cache metrics from new assistant messages (before modifying anything)
        collectCacheMetrics(state, output.messages, logger)

        // Advisor turn start: cleanup and prepare for feedback collection
        advisorTurnStart(state.advisor, state.currentTurn)

        // Collect feedback from previous turn's suggestions
        collectAdvisorFeedback(state, config, logger)

        syncToolCache(state, config, logger, output.messages)

        // Invalidate token cache when message structure or tool states change
        const lastMsgId =
            output.messages.length > 0
                ? output.messages[output.messages.length - 1].info.id
                : undefined
        const toolStateHash = computeLastMsgToolStateHash(output.messages)
        const tokenCacheHash =
            output.messages.length +
            "_" +
            lastMsgId +
            "_" +
            state.lastCompaction +
            "_" +
            toolStateHash
        if (state.toolTokensCacheHash !== tokenCacheHash) {
            state.toolTokensCache.clear()
            state.toolTokensCacheHash = tokenCacheHash
        }

        // Run automatic pruning strategies
        deduplicate(state, logger, config, output.messages)
        supersedeWrites(state, logger, config, output.messages)
        purgeErrors(state, logger, config, output.messages)
        purgeStaleOutputs(state, logger, config, output.messages)
        aggressivePrune(state, logger, config, output.messages)

        prune(state, output.messages)

        // Periodic cleanup
        if (state.currentTurn > 0 && state.currentTurn % 10 === 0) {
            const validToolIds = new Set(buildToolIdList(state, output.messages))
            const removed = cleanupPruneState(state, validToolIds)
            if (removed > 0) {
                logger.debug("Cleaned up stale prune IDs", { removed })
            }
        }

        // Insert prunable-tools context (possibly suppressed by advisor)
        const listInjected = insertPruneToolContext(
            state,
            config,
            logger,
            output.messages,
            state.advisor,
        )

        // Inject pending advisor suggestions only when prunable-tools list was injected,
        // otherwise the model would see suggestion IDs without a list to resolve them
        if (listInjected && hasPendingSuggestion(state.advisor)) {
            injectAdvisorSuggestions(state, config, output.messages, logger)
        }

        // Check if advisor should run for next turn (async, non-blocking)
        // Use countPrunableTools to exclude turn-protected and advisor-protected items (per docs section 3)
        const prunableCount = countPrunableTools(state, state.advisor)
        if (shouldTriggerAdvisor(state, config, state.advisor, prunableCount)) {
            // Fire and forget - don't await
            runAdvisorAsync(client, state, config, logger, output.messages).catch((e) => {
                if (config.smallModelAdvisor?.debug) {
                    logger.info(`[advisor] Async error: ${e.message}`)
                }
            })
        }

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        _output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp") {
            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""
            const _subArgs = args.slice(1)

            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]

            if (subcommand === "context") {
                await handleContextCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (subcommand === "stats") {
                await handleStatsCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__DCP_STATS_HANDLED__")
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    client,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    args: _subArgs,
                    workingDirectory,
                })
                throw new Error("__DCP_SWEEP_HANDLED__")
            }

            await handleHelpCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            })
            throw new Error("__DCP_HELP_HANDLED__")
        }
    }
}
