import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { PRUNABLE_TOOL_THRESHOLD } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { getNudgePrompt } from "../prompts/nudge"
import { extractParameterKey, buildToolIdList, createSyntheticUserMessage } from "./utils"
import { isToolCallProtected } from "../protected-file-patterns"
import { getLastUserMessage } from "../shared-utils"
import { truncate } from "../ui/utils"
import { getToolTokens } from "../strategies/utils"
import type { AdvisorState } from "../advisor/types"
import { shouldSuppressNudge, hasSuggestionToInject } from "../advisor/trigger"

type NudgeUrgency = "none" | "normal" | "warn" | "critical"

/**
 * Regex to match <prunable-tools>...</prunable-tools> blocks and trailing whitespace.
 * Uses non-greedy matching to handle multiple blocks correctly.
 */
const PRUNABLE_TOOLS_REGEX = /<prunable-tools>[\s\S]*?<\/prunable-tools>\s*/g

/**
 * Clean historical <prunable-tools> content from messages.
 *
 * Each request injects a new prunable-tools list, but the old injections
 * remain in historical messages. Since the content changes each time
 * (tool count, IDs, etc.), this breaks Anthropic's prefix caching mechanism,
 * causing cache_creation to grow continuously while cache_read stays low.
 *
 * By cleaning historical injections, we keep message content stable and
 * maximize prompt cache hit rate.
 */
const cleanHistoricalPrunableTools = (messages: WithParts[]): void => {
    // Skip if there are fewer than 2 messages (nothing historical to clean)
    if (messages.length < 2) {
        return
    }

    // Iterate all messages except the last one (which will receive new injection)
    for (let i = 0; i < messages.length - 1; i++) {
        const msg = messages[i]
        let modified = false

        for (const part of msg.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                // Reset regex lastIndex for correct matching with global flag
                PRUNABLE_TOOLS_REGEX.lastIndex = 0
                const newText = part.text.replace(PRUNABLE_TOOLS_REGEX, "").trim()
                if (newText !== part.text) {
                    part.text = newText
                    modified = true
                }
            }
        }

        if (modified) {
            // Remove empty text parts to avoid affecting cache hash
            msg.parts = msg.parts.filter((part) => {
                if (part.type === "text" && typeof part.text === "string") {
                    return part.text.length > 0
                }
                return true
            })
        }
    }
}

const getNudgeString = (config: PluginConfig, urgency: NudgeUrgency): string => {
    if (urgency === "none") {
        return ""
    }

    if (!config.tools.prune.enabled) {
        return ""
    }

    return getNudgePrompt(urgency)
}

/**
 * Determine nudge urgency based on token budget thresholds and tool count.
 */
const getNudgeUrgency = (
    state: SessionState,
    config: PluginConfig,
    prunableToolCount: number,
): NudgeUrgency => {
    if (!config.tokenBudget.enabled) {
        // Fallback to counter-based nudge
        if (
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            return "normal"
        }
        return "none"
    }

    const tokens = state.stats.currentPrunableTokens

    // Check if a non-token-based trigger is active (used to override exhausted state)
    const isNonTokenTriggered =
        (config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency) ||
        (config.tools.settings.nudgeEnabled && prunableToolCount >= PRUNABLE_TOOL_THRESHOLD)

    // Token-based urgency levels
    if (tokens >= config.tokenBudget.criticalThreshold) {
        // If exhausted (previous prune couldn't reduce below threshold) and not counter-triggered, stay silent
        if (state.aggressivePruneExhausted && !isNonTokenTriggered) {
            return "none"
        }
        // Reset exhausted on non-token trigger (also reset in aggressivePrune when tokens drop)
        if (isNonTokenTriggered) {
            state.aggressivePruneExhausted = false
        }
        return "critical"
    } else if (tokens >= config.tokenBudget.warnThreshold) {
        return "warn"
    }

    // Tool count threshold (consistent with N+ outputs rule in system prompt)
    // This ensures nudge appears when there are enough tools to prune
    if (config.tools.settings.nudgeEnabled && prunableToolCount >= PRUNABLE_TOOL_THRESHOLD) {
        return "normal"
    }

    // Below thresholds, use counter-based nudge as fallback
    if (
        config.tools.settings.nudgeEnabled &&
        state.nudgeCounter >= config.tools.settings.nudgeFrequency
    ) {
        return "normal"
    }

    return "none"
}

const wrapPrunableTools = (content: string): string => `<prunable-tools>
Only these IDs are valid:
${content}
</prunable-tools>`

const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): string => {
    const allToolIds = buildToolIdList(state, messages)
    if (allToolIds.length === 0) {
        return ""
    }
    const toolIdToIndex = state.toolIdToIndexCache!

    const allProtectedTools = config.tools.settings.protectedTools

    const prunableEntries: {
        id: string
        numericId: number
        tool: string
        paramKey: string
    }[] = []

    for (const [toolCallId, toolParameterEntry] of state.toolParameters) {
        if (state.prune.toolIdSet.has(toolCallId)) {
            continue
        }

        if (
            isToolCallProtected(
                toolParameterEntry.tool,
                toolParameterEntry.parameters,
                allProtectedTools,
                config.protectedFilePatterns,
            )
        ) {
            continue
        }

        const numericId = toolIdToIndex.get(toolCallId)
        if (numericId === undefined) {
            logger.warn(`Tool in cache but not in toolIdList - possible stale entry`, {
                toolCallId,
                tool: toolParameterEntry.tool,
            })
            continue
        }

        // Skip tools with no prunable content (content too short to be worth pruning)
        if (getToolTokens(state, messages, toolCallId) === 0) {
            continue
        }

        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        prunableEntries.push({
            id: toolCallId,
            numericId,
            tool: toolParameterEntry.tool,
            paramKey,
        })
    }

    if (prunableEntries.length === 0) {
        state.prunableToolIdList = [] // Empty array indicates "checked but none available"
        return ""
    }

    // Sort by numeric ID for stable, predictable output order
    prunableEntries.sort((a, b) => a.numericId - b.numericId)

    // Increment snapshot version for internal tracking and debugging.
    state.prunableListVersion++

    // Save snapshot with callId, tool name, and auto-increment ID for validation.
    // This allows detecting ID drift when the list changes between generation and execution.
    const currentCallIds = new Set<string>()
    state.prunableToolIdList = prunableEntries.map((e) => {
        currentCallIds.add(e.id)
        const existing = state.prunableIdMap.get(e.id)
        const id = existing === undefined ? state.nextPrunableId++ : existing
        if (existing === undefined) {
            state.prunableIdMap.set(e.id, id)
        }
        return {
            id,
            callId: e.id,
            tool: e.tool,
        }
    })
    for (const key of state.prunableIdMap.keys()) {
        if (!currentCallIds.has(key)) {
            state.prunableIdMap.delete(key)
        }
    }

    const lines: string[] = state.prunableToolIdList.map((entry, i) => {
        const paramKey = prunableEntries[i].paramKey
        const description = paramKey ? `${entry.tool}, ${truncate(paramKey, 50)}` : entry.tool
        return `${entry.id}: ${description}`
    })

    logger.debug(
        `Found ${prunableEntries.length} prunable tools (version=${state.prunableListVersion})`,
    )

    return wrapPrunableTools(lines.join("\n"))
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    advisorState?: AdvisorState,
): boolean => {
    if (!config.tools.prune.enabled) {
        return false
    }

    const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
    if (!prunableToolsList) {
        return false
    }

    const prunableToolCount = state.prunableToolIdList?.length ?? 0
    const nudgeUrgency = getNudgeUrgency(state, config, prunableToolCount)

    // On-demand injection: skip when no nudge is triggered
    // on_warn mode: skip unless warn or critical (more cache-friendly)
    // Exception: always inject when advisor has pending suggestions, so the model can see the IDs
    const injectMode = config.tools.settings.injectPrunableTools ?? "on_demand"
    const advisorNeedsList = advisorState ? hasSuggestionToInject(advisorState) : false
    if (injectMode === "on_demand" && nudgeUrgency === "none" && !advisorNeedsList) {
        return false
    }
    if (
        injectMode === "on_warn" &&
        (nudgeUrgency === "none" || nudgeUrgency === "normal") &&
        !advisorNeedsList
    ) {
        return false
    }

    // Clean historical prunable-tools injections only when we are about to inject a new list.
    // This keeps message content stable across requests when injection is skipped.
    cleanHistoricalPrunableTools(messages)

    logger.debug("prunable-tools: \n" + prunableToolsList)

    let nudgeString = ""
    if (nudgeUrgency !== "none") {
        // Check if nudge should be suppressed by advisor
        const suppress =
            advisorState &&
            nudgeUrgency !== "critical" &&
            shouldSuppressNudge(config, advisorState, nudgeUrgency)

        if (suppress) {
            logger.debug(`[advisor] Suppressing ${nudgeUrgency} nudge (advisor active)`)
        } else {
            logger.info(`Inserting prune nudge message (urgency: ${nudgeUrgency})`)
            nudgeString = "\n" + getNudgeString(config, nudgeUrgency)
        }
    }

    const prunableToolsContent = prunableToolsList + nudgeString

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return false
    }

    const variant = state.variant ?? (lastUserMessage.info as UserMessage).variant

    // Always inject as user message instead of assistant prefill.
    // - opus-4-6 does not support assistant prefill (last message must be user role)
    // - Semantically, pruning hints are suggestions, not model self-knowledge
    // - User messages allow the model to make autonomous decisions
    messages.push(createSyntheticUserMessage(lastUserMessage, prunableToolsContent, variant))
    return true
}
