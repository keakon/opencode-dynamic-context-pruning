import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites, purgeErrors, aggressivePrune } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { loadPrompt } from "./prompts"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"
import { handleHelpCommand } from "./commands/help"
import { handleSweepCommand } from "./commands/sweep"
import { cleanupPruneState } from "./shared-utils"
import { buildToolIdList, computeLastMsgToolStateHash } from "./messages/utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

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

        const discardEnabled = config.tools.discard.enabled
        const extractEnabled = config.tools.extract.enabled

        let promptName: string
        if (discardEnabled && extractEnabled) {
            promptName = "system/system-prompt-both"
        } else if (discardEnabled) {
            promptName = "system/system-prompt-discard"
        } else if (extractEnabled) {
            promptName = "system/system-prompt-extract"
        } else {
            return
        }

        const syntheticPrompt = loadPrompt(promptName)
        output.system.push(syntheticPrompt)
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, output.messages)

        if (state.isSubAgent) {
            return
        }

        syncToolCache(state, config, logger, output.messages)

        // Invalidate token cache when message structure or tool states change
        // Includes tool state hash to detect content updates within the same message
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

        deduplicate(state, logger, config, output.messages)
        supersedeWrites(state, logger, config, output.messages)
        purgeErrors(state, logger, config, output.messages)
        aggressivePrune(state, logger, config, output.messages)

        prune(state, output.messages)

        // Periodic cleanup: remove stale prune IDs every 10 turns to prevent memory growth
        if (state.currentTurn > 0 && state.currentTurn % 10 === 0) {
            const validToolIds = new Set(buildToolIdList(state, output.messages))
            const removed = cleanupPruneState(state, validToolIds)
            if (removed > 0) {
                logger.debug("Cleaned up stale prune IDs", { removed })
            }
        }

        insertPruneToolContext(state, config, logger, output.messages)

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
