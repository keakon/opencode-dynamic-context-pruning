import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"

async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch {
        return false
    }
}

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(client, state, lastSessionId, logger, messages)
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        state.toolParameters.clear()
        state.prune.toolIds = []
        state.prune.toolIdSet = new Set()
        state.toolIdListCache = null
        state.toolIdListCacheHash = undefined
        state.toolIdToIndexCache = null
        state.prunableToolIdList = null
        logger.info("Detected compaction from messages - cleared tool cache", {
            timestamp: lastCompactionTimestamp,
        })
    }

    state.currentTurn = countTurns(state, messages)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        prune: {
            toolIds: [],
            toolIdSet: new Set(),
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
            currentPrunableTokens: 0,
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        nudgeCounter: 0,
        lastCompaction: 0,
        currentTurn: 0,
        variant: undefined,
        toolIdListCache: null,
        toolIdListCacheHash: undefined,
        toolIdToIndexCache: null,
        toolTokensCache: new Map(),
        prunableToolIdList: null,
    }
}

export function resetSessionState(state: SessionState): void {
    const fresh = createSessionState()
    state.sessionId = fresh.sessionId
    state.isSubAgent = fresh.isSubAgent
    state.prune = fresh.prune
    state.stats = fresh.stats
    state.toolParameters.clear()
    state.nudgeCounter = fresh.nudgeCounter
    state.lastCompaction = fresh.lastCompaction
    state.currentTurn = fresh.currentTurn
    state.variant = fresh.variant
    state.toolIdListCache = fresh.toolIdListCache
    state.toolIdListCacheHash = fresh.toolIdListCacheHash
    state.toolIdToIndexCache = fresh.toolIdToIndexCache
    state.toolTokensCache.clear()
    state.prunableToolIdList = fresh.prunableToolIdList
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    logger.info("session ID = " + sessionId)
    logger.info("Initializing session state", { sessionId: sessionId })

    resetSessionState(state)
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    const toolIdSet = new Set(persisted.prune.toolIds || [])
    state.prune = {
        toolIds: persisted.prune.toolIds || [],
        toolIdSet,
    }
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
        currentPrunableTokens: 0, // Recalculated on each turn
    }
}

function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}
