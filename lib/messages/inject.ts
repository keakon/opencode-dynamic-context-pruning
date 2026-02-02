import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { PRUNABLE_TOOL_THRESHOLD } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { getNudgePrompt } from "../prompts/nudge"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticAssistantMessage,
    createSyntheticUserMessage,
    createSyntheticToolPart,
    isDeepSeekOrKimi,
    isIgnoredUserMessage,
} from "./utils"
import { isToolCallProtected } from "../protected-file-patterns"
import { getLastUserMessage } from "../shared-utils"
import { truncate } from "../ui/utils"
import { getToolTokens } from "../strategies/utils"

type NudgeUrgency = "none" | "normal" | "warn" | "critical"

const getNudgeString = (config: PluginConfig, urgency: NudgeUrgency): string => {
    if (urgency === "none") {
        return ""
    }

    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    let mode: "both" | "discard" | "extract"
    if (discardEnabled && extractEnabled) {
        mode = "both"
    } else if (discardEnabled) {
        mode = "discard"
    } else if (extractEnabled) {
        mode = "extract"
    } else {
        return ""
    }

    return getNudgePrompt(mode, urgency)
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
The following tools are available for pruning. Only IDs listed here are valid.
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

        if (isToolCallProtected(
            toolParameterEntry.tool,
            toolParameterEntry.parameters,
            allProtectedTools,
            config.protectedFilePatterns,
        )) {
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

    // Save snapshot with both callId and tool name for validation.
    // This allows detecting ID drift when the list changes between generation and execution.
    state.prunableToolIdList = prunableEntries.map((e) => ({
        callId: e.id,
        tool: e.tool,
    }))

    const lines: string[] = prunableEntries.map((entry, i) => {
        const description = entry.paramKey
            ? `${entry.tool}, ${truncate(entry.paramKey, 50)}`
            : entry.tool
        return `${i}: ${description}`
    })

    logger.debug(`Found ${prunableEntries.length} prunable tools (version=${state.prunableListVersion})`)

    return wrapPrunableTools(lines.join("\n"))
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (!config.tools.discard.enabled && !config.tools.extract.enabled) {
        return
    }

    const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
    if (!prunableToolsList) {
        return
    }

    logger.debug("prunable-tools: \n" + prunableToolsList)

    const prunableToolCount = state.prunableToolIdList?.length ?? 0
    const nudgeUrgency = getNudgeUrgency(state, config, prunableToolCount)
    let nudgeString = ""
    if (nudgeUrgency !== "none") {
        logger.info(`Inserting prune nudge message (urgency: ${nudgeUrgency})`)
        nudgeString = "\n" + getNudgeString(config, nudgeUrgency)
    }

    const prunableToolsContent = prunableToolsList + nudgeString

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const userInfo = lastUserMessage.info as UserMessage
    const variant = state.variant ?? userInfo.variant

    let lastNonIgnoredMessage: WithParts | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!(msg.info.role === "user" && isIgnoredUserMessage(msg))) {
            lastNonIgnoredMessage = msg
            break
        }
    }

    if (!lastNonIgnoredMessage || lastNonIgnoredMessage.info.role === "user") {
        messages.push(createSyntheticUserMessage(lastUserMessage, prunableToolsContent, variant))
    } else {
        const providerID = userInfo.model?.providerID || ""
        const modelID = userInfo.model?.modelID || ""

        if (isDeepSeekOrKimi(providerID, modelID)) {
            const toolPart = createSyntheticToolPart(lastNonIgnoredMessage, prunableToolsContent)
            lastNonIgnoredMessage.parts.push(toolPart)
        } else {
            messages.push(
                createSyntheticAssistantMessage(lastUserMessage, prunableToolsContent, variant),
            )
        }
    }
}
