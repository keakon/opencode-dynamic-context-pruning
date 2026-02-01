import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { loadPrompt } from "../prompts"
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

const getNudgeString = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    if (discardEnabled && extractEnabled) {
        return loadPrompt(`nudge/nudge-both`)
    } else if (discardEnabled) {
        return loadPrompt(`nudge/nudge-discard`)
    } else if (extractEnabled) {
        return loadPrompt(`nudge/nudge-extract`)
    }
    return ""
}

const wrapPrunableTools = (content: string): string => `<prunable-tools>
The following tools are available for pruning. Only IDs listed here are valid.
${content}
</prunable-tools>`

const getCooldownMessage = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    let toolName: string
    if (discardEnabled && extractEnabled) {
        toolName = "discard or extract tools"
    } else if (discardEnabled) {
        toolName = "discard tool"
    } else {
        toolName = "extract tool"
    }

    return `<prunable-tools>
Context management was just performed. Do not use the ${toolName} again. A fresh list will be available after your next tool use.
</prunable-tools>`
}

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

        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        prunableEntries.push({
            id: toolCallId,
            numericId,
            tool: toolParameterEntry.tool,
            paramKey,
        })
    }

    if (prunableEntries.length === 0) {
        state.prunableToolIdList = null // Clear stale snapshot
        return ""
    }

    // Sort by numeric ID for stable, predictable output order
    prunableEntries.sort((a, b) => a.numericId - b.numericId)

    // Save snapshot of the numeric ID → callID mapping for use by discard/extract tools.
    // This prevents ID shifting when new tool calls arrive between list generation and execution.
    state.prunableToolIdList = prunableEntries.map((e) => e.id)

    const lines: string[] = prunableEntries.map((entry, i) => {
        const description = entry.paramKey
            ? `${entry.tool}, ${truncate(entry.paramKey, 50)}`
            : entry.tool
        return `${i}: ${description}`
    })

    logger.debug(`Found ${prunableEntries.length} prunable tools`)

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

    let prunableToolsContent: string

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        prunableToolsContent = getCooldownMessage(config)
    } else {
        const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
        if (!prunableToolsList) {
            return
        }

        logger.debug("prunable-tools: \n" + prunableToolsList)

        let nudgeString = ""
        if (
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            logger.info("Inserting prune nudge message")
            nudgeString = "\n" + getNudgeString(config)
        }

        prunableToolsContent = prunableToolsList + nudgeString
    }

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
