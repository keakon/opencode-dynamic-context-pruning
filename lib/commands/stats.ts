/**
 * DCP Stats command handler.
 * Shows pruning statistics for the current session and all-time totals.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { loadAllSessionStats, type AggregatedStats } from "../state/persistence"
import { getCurrentParams } from "../strategies/utils"

export interface StatsCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function formatCacheHitRate(cacheRead: number, input: number): string {
    const total = cacheRead + input
    if (total === 0) return "N/A"
    return ((cacheRead / total) * 100).toFixed(1) + "%"
}

function formatStatsMessage(
    sessionTokens: number,
    sessionTools: number,
    allTime: AggregatedStats,
    sessionCacheRead: number,
    sessionCacheWrite: number,
    sessionInput: number,
    sessionRequests: number,
): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                    DCP Statistics                         │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session:")
    lines.push("─".repeat(60))
    lines.push(`  Tokens pruned: ~${formatTokenCount(sessionTokens)}`)
    lines.push(`  Tools pruned:   ${sessionTools}`)
    if (sessionRequests > 0) {
        lines.push("")
        lines.push("  Cache Performance:")
        lines.push(`    Hit rate:     ${formatCacheHitRate(sessionCacheRead, sessionInput)}`)
        lines.push(`    Cache read:  ~${formatTokenCount(sessionCacheRead)}`)
        lines.push(`    Cache write: ~${formatTokenCount(sessionCacheWrite)}`)
        lines.push(`    Base input:  ~${formatTokenCount(sessionInput)}`)
        lines.push(`    Requests:     ${sessionRequests}`)
    }
    lines.push("")
    lines.push("All-time:")
    lines.push("─".repeat(60))
    lines.push(`  Tokens saved:  ~${formatTokenCount(allTime.totalTokens)}`)
    lines.push(`  Tools pruned:   ${allTime.totalTools}`)
    lines.push(`  Sessions:       ${allTime.sessionCount}`)
    if (allTime.totalRequests > 0) {
        lines.push("")
        lines.push("  Cache Performance:")
        lines.push(
            `    Hit rate:     ${formatCacheHitRate(allTime.totalCacheRead, allTime.totalInput)}`,
        )
        lines.push(`    Cache read:  ~${formatTokenCount(allTime.totalCacheRead)}`)
        lines.push(`    Cache write: ~${formatTokenCount(allTime.totalCacheWrite)}`)
        lines.push(`    Base input:  ~${formatTokenCount(allTime.totalInput)}`)
        lines.push(`    Requests:     ${allTime.totalRequests}`)
    }

    return lines.join("\n")
}

export async function handleStatsCommand(ctx: StatsCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    // Session stats from in-memory state
    const sessionTokens = state.stats.totalPruneTokens
    const sessionTools = state.prune.toolIds.length

    // All-time stats from storage files
    const allTime = await loadAllSessionStats(logger)

    const message = formatStatsMessage(
        sessionTokens,
        sessionTools,
        allTime,
        state.cacheMetrics.totalCacheRead,
        state.cacheMetrics.totalCacheWrite,
        state.cacheMetrics.totalInput,
        state.cacheMetrics.requestCount,
    )

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Stats command executed", {
        sessionTokens,
        sessionTools,
        allTimeTokens: allTime.totalTokens,
        allTimeTools: allTime.totalTools,
    })
}
