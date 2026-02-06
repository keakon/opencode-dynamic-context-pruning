import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"
import { createAdvisorState } from "../advisor/types"

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
        state.toolIdToPartCache = null
        state.toolTokensCache.clear()
        state.toolTokensCacheHash = undefined
        state.prunableToolIdList = null
        state.prunableListVersion = 0
        state.nextPrunableId = 0
        state.prunableIdMap = new Map()

        // Clear advisor state on compaction (per spec)
        state.advisor.pendingSuggestion = null
        state.advisor.advisorInProgress = false

        // Rebuild protectedKeyExpiry based on rejectCount after compaction (per docs 6.2)
        // This ensures protection periods remain valid when turn numbers reset
        const newTurn = countTurns(state, messages)
        for (const [paramKey, info] of state.advisor.protectedKeyExpiry) {
            // Rebuild protection: rejectCount * 3 turns from new turn
            const newExpiry = newTurn + info.rejectCount * 3
            state.advisor.protectedKeyExpiry.set(paramKey, {
                until: newExpiry,
                rejectCount: info.rejectCount,
            })
        }

        logger.info("Detected compaction from messages - cleared tool cache and advisor state", {
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
        toolIdToPartCache: null,
        toolTokensCache: new Map(),
        toolTokensCacheHash: undefined,
        prunableToolIdList: null,
        prunableListVersion: 0,
        nextPrunableId: 0,
        prunableIdMap: new Map(),
        aggressivePruneExhausted: false,
        advisor: createAdvisorState(),
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
    state.toolIdToPartCache = fresh.toolIdToPartCache
    state.toolTokensCache.clear()
    state.toolTokensCacheHash = fresh.toolTokensCacheHash
    state.prunableToolIdList = fresh.prunableToolIdList
    state.prunableListVersion = fresh.prunableListVersion
    state.nextPrunableId = fresh.nextPrunableId
    state.prunableIdMap = fresh.prunableIdMap
    state.aggressivePruneExhausted = fresh.aggressivePruneExhausted
    state.advisor = createAdvisorState()
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
    state.aggressivePruneExhausted = persisted.aggressivePruneExhausted ?? false

    const prunableIdMap = new Map<string, number>()
    if (Array.isArray(persisted.prunableIdMap)) {
        for (const entry of persisted.prunableIdMap) {
            if (
                Array.isArray(entry) &&
                entry.length === 2 &&
                typeof entry[0] === "string" &&
                typeof entry[1] === "number"
            ) {
                prunableIdMap.set(entry[0], entry[1])
            }
        }
    }
    let nextPrunableId =
        typeof persisted.nextPrunableId === "number" ? persisted.nextPrunableId : 0
    if (prunableIdMap.size > 0) {
        let maxId = -1
        for (const value of prunableIdMap.values()) {
            if (value > maxId) {
                maxId = value
            }
        }
        if (nextPrunableId <= maxId) {
            nextPrunableId = maxId + 1
        }
    }
    state.prunableIdMap = prunableIdMap
    state.nextPrunableId = nextPrunableId

    // Load advisor state if persisted
    if (persisted.advisor) {
        const persistedAdvisor = persisted.advisor as any
        const expiryMap = new Map<string, { until: number; rejectCount: number }>()
        const protectedKeysRaw = persistedAdvisor.protectedKeys
        if (Array.isArray(protectedKeysRaw)) {
            if (protectedKeysRaw.length > 0 && Array.isArray(protectedKeysRaw[0])) {
                for (const [key, info] of protectedKeysRaw as Array<
                    [string, { until: number; rejectCount: number }]
                >) {
                    if (typeof key === "string" && info && typeof info === "object") {
                        const until =
                            typeof info.until === "number" ? info.until : state.currentTurn + 3
                        const rejectCount =
                            typeof info.rejectCount === "number" ? info.rejectCount : 1
                        expiryMap.set(key, { until, rejectCount })
                    }
                }
            } else {
                for (const key of protectedKeysRaw as string[]) {
                    if (typeof key === "string") {
                        expiryMap.set(key, { until: state.currentTurn + 3, rejectCount: 1 })
                    }
                }
            }
        }

        const legacyExpiry = persistedAdvisor.protectedKeyExpiry
        if (legacyExpiry && typeof legacyExpiry === "object") {
            for (const [key, value] of Object.entries(legacyExpiry)) {
                if (typeof value === "number") {
                    expiryMap.set(key, { until: value, rejectCount: 1 })
                } else if (value && typeof value === "object") {
                    const info = value as { until: number; rejectCount: number }
                    expiryMap.set(key, {
                        until: typeof info.until === "number" ? info.until : state.currentTurn + 3,
                        rejectCount: typeof info.rejectCount === "number" ? info.rejectCount : 1,
                    })
                }
            }
        }

        state.advisor = {
            pendingSuggestion: null, // Not persisted, reset each session
            feedbackHistory: persistedAdvisor.feedbackHistory ?? [],
            protectedKeys: new Set(expiryMap.keys()),
            protectedKeyExpiry: expiryMap,
            consecutiveFailures: 0,
            disabled: false,
            currentModelIndex: 0, // Not persisted per spec, always reset
            advisorInProgress: false, // Not persisted, reset each session
        }
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
