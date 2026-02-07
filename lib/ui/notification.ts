import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    countDistillationTokens,
    formatExtracted,
    formatPrunedItemsList,
    formatStatsHeader,
    formatTokenCount,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

function buildMinimalMessage(
    state: SessionState,
    distillation: string[] | undefined,
    showDistillation: boolean,
): string {
    const extractedTokens = countDistillationTokens(distillation)
    const extractedSuffix =
        extractedTokens > 0 ? ` (extracted ${formatTokenCount(extractedTokens)})` : ""
    const message =
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        extractedSuffix

    return message + formatExtracted(showDistillation ? distillation : undefined)
}

function buildDetailedMessage(
    state: SessionState,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory: string,
    distillation: string[] | undefined,
    showDistillation: boolean,
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const extractedTokens = countDistillationTokens(distillation)
        const extractedSuffix =
            extractedTokens > 0 ? `, extracted ${formatTokenCount(extractedTokens)}` : ""
        message += `\n\n▣ Pruning (${pruneTokenCounterStr}${extractedSuffix})`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += "\n" + itemLines.join("\n")
    }

    return (message + formatExtracted(showDistillation ? distillation : undefined)).trim()
}

export async function sendUnifiedNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    params: any,
    workingDirectory: string,
    distillation?: string[],
): Promise<boolean> {
    if (pruneToolIds.length === 0) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const showDistillation = config.tools.prune.showDistillation

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalMessage(state, distillation, showDistillation)
            : buildDetailedMessage(
                  state,
                  pruneToolIds,
                  toolMetadata,
                  workingDirectory,
                  distillation,
                  showDistillation,
              )

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
