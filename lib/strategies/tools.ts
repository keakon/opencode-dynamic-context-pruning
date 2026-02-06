import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { calculateTokensSaved, getCurrentParams } from "./utils"
import { addPruneToolIds } from "../shared-utils"
import { syncToolCache } from "../state/tool-cache"
import { PRUNE_TOOL_SPEC } from "../prompts/prune-tool-spec"

export interface PruneToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}

// Unified logic for executing prune operations (discard + extract).
async function executePruneOperation(
    ctx: PruneToolContext,
    toolCtx: { sessionID: string },
    discardIds: string[],
    extractItems: [string, string][],
): Promise<string> {
    const { client, state, logger, config, workingDirectory } = ctx
    const sessionId = toolCtx.sessionID

    const totalCount = discardIds.length + extractItems.length
    logger.info(
        `Prune tool invoked with ${discardIds.length} discard + ${extractItems.length} extract IDs (listVersion=${state.prunableListVersion})`,
    )

    // --- Fetch messages early so we can sync tool cache before validation ---
    const messagesResponse = await client.session.messages({
        path: { id: sessionId },
    })
    const messages: WithParts[] = messagesResponse.data || messagesResponse

    await ensureSessionInitialized(client, state, sessionId, logger, messages)

    // Sync tool cache BEFORE validation to ensure fresh state
    await syncToolCache(state, config, logger, messages)

    // --- Validate prunable list snapshot ---
    const prunableList = state.prunableToolIdList
    if (!prunableList || prunableList.length === 0) {
        throw new Error("No prunable tools available. Wait for a fresh <prunable-tools> list.")
    }

    // --- Parse and validate all numeric IDs ---
    const allRawIds = [...discardIds, ...extractItems.map(([id]) => id)]
    for (const id of allRawIds) {
        if (!/^\d+$/.test(id)) {
            throw new Error(`Invalid non-numeric ID: ${id}. Use numeric IDs from <prunable-tools>.`)
        }
    }

    // Check for duplicate IDs within extract (distillation is positional, duplicates lose data)
    const extractIds = extractItems.map(([id]) => id)
    if (new Set(extractIds).size !== extractIds.length) {
        throw new Error(
            "Duplicate IDs detected in extract. Each ID must be unique when using distillation.",
        )
    }

    // Check for overlap between discard and extract
    const discardIdSet = new Set(discardIds)
    const extractIdSet = new Set(extractIds)
    const overlap = [...discardIdSet].filter((id) => extractIdSet.has(id))
    if (overlap.length > 0) {
        throw new Error(
            `IDs [${overlap.join(", ")}] appear in both discard and extract. Each ID must be in only one.`,
        )
    }

    // Deduplicate discard IDs; extract already validated unique
    const dedupedDiscardNums = [...new Set(discardIds.map(Number))]
    const extractNums = extractIds.map(Number)

    // Build extraction map: numericId -> distillation text
    const extractionMap = new Map<number, string>()
    for (const [id, dist] of extractItems) {
        extractionMap.set(Number(id), dist)
    }

    // --- Resolve IDs against snapshot, skipping invalid ones ---
    const allProcessedIds = [...dedupedDiscardNums, ...extractNums]
    const validEntries: { numId: number; callId: string; distillation?: string }[] = []
    const skippedIds: number[] = []
    const mismatchedIds: string[] = []

    for (const numId of allProcessedIds) {
        const entry = prunableList.find((e) => e.id === numId)
        if (!entry) {
            skippedIds.push(numId)
            continue
        }

        // Validate tool name still matches what was shown in the list
        const currentMetadata = state.toolParameters.get(entry.callId)
        if (currentMetadata && currentMetadata.tool !== entry.tool) {
            mismatchedIds.push(
                `ID ${numId}: expected "${entry.tool}", found "${currentMetadata.tool}"`,
            )
            continue
        }

        validEntries.push({
            numId,
            callId: entry.callId,
            distillation: extractionMap.get(numId),
        })
    }

    if (mismatchedIds.length > 0) {
        logger.warn(`Skipped ${mismatchedIds.length} mismatched IDs: ${mismatchedIds.join("; ")}`)
    }

    if (validEntries.length === 0) {
        const details: string[] = []
        if (skippedIds.length > 0) details.push(`skipped: ${skippedIds.join(", ")}`)
        if (mismatchedIds.length > 0) details.push(`mismatched: ${mismatchedIds.join("; ")}`)
        throw new Error(
            `All ${totalCount} IDs are invalid (${details.join("; ")}). Only use IDs from <prunable-tools>.`,
        )
    }

    if (skippedIds.length > 0) {
        logger.warn(`Skipped ${skippedIds.length} invalid IDs: ${skippedIds.join(", ")}`)
    }

    // --- Filter out already-pruned tools ---
    const filteredEntries = validEntries.filter((e) => !state.prune.toolIdSet.has(e.callId))
    if (filteredEntries.length === 0) {
        throw new Error("All specified tools have already been pruned.")
    }
    if (filteredEntries.length < validEntries.length) {
        logger.info(`Filtered ${validEntries.length - filteredEntries.length} already-pruned tools`)
    }

    const filteredPruneToolIds = filteredEntries.map((e) => e.callId)
    const distillationList = filteredEntries
        .filter((e) => e.distillation !== undefined)
        .map((e) => e.distillation!)

    // --- Execute pruning ---
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
        distillationList.length > 0 ? distillationList : undefined,
    )

    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.nudgeCounter = 0

    // Sync tool cache AFTER pruning to ensure cache reflects pruned state
    await syncToolCache(state, config, logger, messages)

    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state", { error: err.message }),
    )

    let result = formatPruningResultForTool(newPruneToolIds, toolMetadata, workingDirectory)

    // Append skipped info to result message
    const notes: string[] = []
    if (skippedIds.length > 0) {
        notes.push(`Skipped ${skippedIds.length} invalid ID(s): ${skippedIds.join(", ")}`)
    }
    if (mismatchedIds.length > 0) {
        notes.push(`Skipped ${mismatchedIds.length} mismatched ID(s): ${mismatchedIds.join("; ")}`)
    }
    if (notes.length > 0) {
        result += `\n\nNote: ${notes.join(". ")}`
    }

    return result
}

export function createPruneTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: PRUNE_TOOL_SPEC,
        args: {
            discard: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe("Numeric IDs from <prunable-tools> to discard"),
            extract: tool.schema
                .array(tool.schema.tuple([tool.schema.string(), tool.schema.string()]))
                .optional()
                .describe("Array of [id, distillation] tuples from <prunable-tools>"),
        },
        async execute(args, toolCtx) {
            const discardIds = args.discard ?? []
            const extractItems = (args.extract ?? []) as [string, string][]

            // Manual validation: at least one param must be provided and non-empty
            if (discardIds.length === 0 && extractItems.length === 0) {
                return "Error: At least one of 'discard' or 'extract' must be provided and non-empty."
            }

            // Validate extract items are valid [id, content] tuples
            for (const item of extractItems) {
                if (
                    !Array.isArray(item) ||
                    item.length !== 2 ||
                    typeof item[0] !== "string" ||
                    typeof item[1] !== "string"
                ) {
                    return "Error: extract items must be an array of [id, content] tuples."
                }
            }

            return executePruneOperation(ctx, toolCtx, discardIds, extractItems)
        },
    })
}
