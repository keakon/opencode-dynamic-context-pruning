import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompts"
import { calculateTokensSaved, getCurrentParams } from "./utils"
import { addPruneToolIds } from "../shared-utils"

const DISCARD_TOOL_DESCRIPTION = loadPrompt("discard-tool-spec")
const EXTRACT_TOOL_DESCRIPTION = loadPrompt("extract-tool-spec")

export interface PruneToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}

// Shared logic for executing prune operations.
async function executePruneOperation(
    ctx: PruneToolContext,
    toolCtx: { sessionID: string },
    ids: string[],
    toolName: string,
    distillation?: string[],
): Promise<string> {
    const { client, state, logger, config, workingDirectory } = ctx
    const sessionId = toolCtx.sessionID

    logger.info(`${toolName} tool invoked with ${ids.length} IDs (listVersion=${state.prunableListVersion})`)

    // Use the snapshot of prunable tool IDs that was saved when <prunable-tools> was generated.
    // This prevents ID shifting issues when new messages arrive between list generation and execution.
    const prunableList = state.prunableToolIdList
    if (!prunableList || prunableList.length === 0) {
        throw new Error("No prunable tools available. Wait for a fresh <prunable-tools> list.")
    }

    const numericToolIds: number[] = []
    for (const id of ids) {
        if (!/^\d+$/.test(id)) {
            throw new Error(`Invalid non-numeric ID: ${id}. Use numeric IDs from <prunable-tools>.`)
        }
        numericToolIds.push(Number(id))
    }

    // For extract operations, each ID has a positional distillation entry.
    // Duplicate IDs would cause the second distillation to be silently lost after dedup,
    // so reject them early (before any deduplication).
    if (distillation && new Set(numericToolIds).size !== numericToolIds.length) {
        throw new Error(
            `Duplicate IDs detected in extract operation. Each ID must be unique when using distillation.`,
        )
    }

    // For discard, deduplicate IDs; for extract, keep original order (already validated unique)
    const processedNumericIds = distillation ? numericToolIds : [...new Set(numericToolIds)]

    // Validate all IDs are within bounds of the snapshot
    if (processedNumericIds.some((id) => id < 0 || id >= prunableList.length)) {
        throw new Error(
            `IDs out of range (valid: 0-${prunableList.length - 1}). Only use IDs from <prunable-tools>.`,
        )
    }

    // Resolve numeric IDs to callIDs using the snapshot, and validate tool names match.
    // This detects ID drift when the list changes between generation and execution.
    const pruneToolIds: string[] = []
    const mismatchedIds: string[] = []

    for (const index of processedNumericIds) {
        const entry = prunableList[index]
        const currentMetadata = state.toolParameters.get(entry.callId)

        // Verify the tool name still matches what was shown in the list
        if (currentMetadata && currentMetadata.tool !== entry.tool) {
            mismatchedIds.push(
                `ID ${index}: expected "${entry.tool}", found "${currentMetadata.tool}"`,
            )
        }
        pruneToolIds.push(entry.callId)
    }

    if (mismatchedIds.length > 0) {
        throw new Error(
            `Tool list has changed since generation. Mismatches: ${mismatchedIds.join("; ")}. ` +
                `Please use IDs from the latest <prunable-tools> list.`,
        )
    }

    // Filter out already-pruned tools (handles same-turn repeated calls)
    const filteredPruneToolIds = pruneToolIds.filter((id) => !state.prune.toolIdSet.has(id))
    if (filteredPruneToolIds.length === 0) {
        throw new Error("All specified tools have already been pruned.")
    }
    if (filteredPruneToolIds.length < pruneToolIds.length) {
        logger.info(
            `Filtered ${pruneToolIds.length - filteredPruneToolIds.length} already-pruned tools`,
        )
    }

    // Fetch messages for token calculation and session initialization
    const messagesResponse = await client.session.messages({
        path: { id: sessionId },
    })
    const messages: WithParts[] = messagesResponse.data || messagesResponse

    await ensureSessionInitialized(ctx.client, state, sessionId, logger, messages)

    const currentParams = getCurrentParams(state, messages, logger)
    const newPruneToolIds = addPruneToolIds(state, filteredPruneToolIds)

    const toolMetadata = new Map<string, ToolParameterEntry>()
    for (const id of newPruneToolIds) {
        const toolParameters = state.toolParameters.get(id)
        if (toolParameters) {
            toolMetadata.set(id, toolParameters)
        }
    }

    state.stats.pruneTokenCounter += calculateTokensSaved(state, messages, newPruneToolIds)

    await sendUnifiedNotification(
        client,
        logger,
        config,
        state,
        sessionId,
        newPruneToolIds,
        toolMetadata,
        currentParams,
        workingDirectory,
        distillation,
    )

    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.nudgeCounter = 0

    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state", { error: err.message }),
    )

    return formatPruningResultForTool(newPruneToolIds, toolMetadata, workingDirectory)
}

export function createDiscardTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: DISCARD_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("Numeric IDs from <prunable-tools> to discard"),
        },
        async execute(args, toolCtx) {
            return executePruneOperation(ctx, toolCtx, args.ids, "Discard")
        },
    })
}

export function createExtractTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: EXTRACT_TOOL_DESCRIPTION,
        args: {
            items: tool.schema
                .array(tool.schema.tuple([tool.schema.string(), tool.schema.string()]))
                .min(1)
                .describe("Array of [id, distillation] tuples from <prunable-tools>"),
        },
        async execute(args, toolCtx) {
            const ids = args.items.map(([id]) => id)
            const distillation = args.items.map(([, dist]) => dist)
            return executePruneOperation(ctx, toolCtx, ids, "Extract", distillation)
        },
    })
}
