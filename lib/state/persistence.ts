/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { SessionState, SessionStats, AdvisorState } from "./types"
import type { Logger } from "../logger"

export interface PersistedPrune {
    toolIds: string[]
}

export interface PersistedAdvisorState {
    feedbackHistory: AdvisorState["feedbackHistory"]
    protectedKeys: Array<[string, { until: number; rejectCount: number }]>
}

export interface PersistedSessionState {
    sessionName?: string
    prune: PersistedPrune
    stats: SessionStats
    aggressivePruneExhausted?: boolean
    advisor?: PersistedAdvisorState
    prunableIdMap?: Array<[string, number]>
    nextPrunableId?: number
    compressSummaries?: Array<[string, string]>
    lastUpdated: string
}

const STORAGE_DIR = join(homedir(), ".local", "share", "opencode", "storage", "plugin", "dcp")

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        await ensureStorageDir()

        const state: PersistedSessionState = {
            sessionName: sessionName,
            prune: {
                toolIds: sessionState.prune.toolIds,
            },
            stats: sessionState.stats,
            aggressivePruneExhausted: sessionState.aggressivePruneExhausted,
            advisor: {
                feedbackHistory: sessionState.advisor.feedbackHistory,
                protectedKeys: Array.from(sessionState.advisor.protectedKeyExpiry.entries()),
            },
            prunableIdMap: Array.from(sessionState.prunableIdMap.entries()),
            nextPrunableId: sessionState.nextPrunableId,
            lastUpdated: new Date().toISOString(),
        }

        const filePath = getSessionFilePath(sessionState.sessionId)
        const content = JSON.stringify(state, null, 2)
        await fs.writeFile(filePath, content, "utf-8")

        logger.info("Saved session state to disk", {
            sessionId: sessionState.sessionId,
            totalTokensSaved: state.stats.totalPruneTokens,
        })
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        if (!state || !state.prune || !Array.isArray(state.prune.toolIds) || !state.stats) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        if (state.prunableIdMap && !Array.isArray(state.prunableIdMap)) {
            state.prunableIdMap = undefined
        }
        if (state.compressSummaries && !Array.isArray(state.compressSummaries)) {
            state.compressSummaries = undefined
        } else if (Array.isArray(state.compressSummaries)) {
            state.compressSummaries = state.compressSummaries.filter(
                (e) =>
                    Array.isArray(e) &&
                    e.length === 2 &&
                    typeof e[0] === "string" &&
                    typeof e[1] === "string",
            )
        }

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune?.toolIds) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.toolIds.length
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
