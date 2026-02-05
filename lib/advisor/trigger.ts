/**
 * Small Model Advisor - Trigger Conditions
 *
 * Determines when the advisor should analyze the context and provide suggestions.
 * Uses independent threshold logic (not reusing nudge thresholds).
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

import type { SessionState } from "../state"
import type { PluginConfig } from "../config"
import type { AdvisorState } from "./types"

/**
 * Check if the advisor should run based on current state and configuration.
 *
 * The advisor is triggered when ALL conditions are met:
 * 1. Advisor is enabled and not disabled due to failures
 * 2. No pending unconsumed suggestion exists
 * 3. No advisor analysis is currently in progress
 * 4. Token count >= tokenThreshold
 * 5. Prunable tool count >= minPrunableCount
 *
 * @returns true if the advisor should analyze and provide suggestions
 */
export function shouldTriggerAdvisor(
    state: SessionState,
    config: PluginConfig,
    advisorState: AdvisorState,
    prunableToolCount: number,
): boolean {
    const advisorConfig = config.smallModelAdvisor

    // 1. Check if advisor feature is enabled
    if (!advisorConfig?.enabled) {
        return false
    }

    // 2. Check if advisor is disabled due to consecutive failures
    if (advisorState.disabled) {
        return false
    }

    // 3. Check if there's already a pending suggestion (consumed or not)
    // Per docs: "pendingSuggestion 存在就不再触发新分析"
    // This ensures the serial guarantee: generate → consume → feedback → clear
    if (advisorState.pendingSuggestion) {
        return false
    }

    // 4. Check if analysis is already in progress (async guard)
    if (advisorState.advisorInProgress) {
        return false
    }

    // 5. Check minimum prunable tool count
    const minToolCount = advisorConfig.minPrunableCount ?? 5
    if (prunableToolCount < minToolCount) {
        return false
    }

    // 6. Check token threshold (independent from nudge thresholds)
    const tokenThreshold = advisorConfig.tokenThreshold ?? 40000
    const currentTokens = state.stats.currentPrunableTokens
    if (currentTokens < tokenThreshold) {
        return false
    }

    return true
}

/**
 * Check if nudge should be suppressed because advisor is active.
 * When suppressNudge is enabled, normal/warn nudges are suppressed
 * if the advisor is enabled and not disabled.
 */
export function shouldSuppressNudge(
    config: PluginConfig,
    advisorState: AdvisorState,
    nudgeUrgency: "normal" | "warn" | "critical",
): boolean {
    const advisorConfig = config.smallModelAdvisor

    // Only suppress if advisor is enabled and configured to suppress
    if (!advisorConfig?.enabled || !advisorConfig.suppressNudge) {
        return false
    }

    // Don't suppress critical nudges
    if (nudgeUrgency === "critical") {
        return false
    }

    // Don't suppress if advisor is disabled due to failures
    if (advisorState.disabled) {
        return false
    }

    // Suppress normal and warn nudges
    return true
}

/**
 * Check if there's a pending suggestion that should be injected.
 */
export function hasSuggestionToInject(advisorState: AdvisorState): boolean {
    return advisorState.pendingSuggestion !== null && !advisorState.pendingSuggestion.consumed
}

/**
 * Reset advisor state (e.g., after config change or manual reset).
 */
export function resetAdvisorState(advisorState: AdvisorState): void {
    advisorState.consecutiveFailures = 0
    advisorState.disabled = false
    advisorState.pendingSuggestion = null
    advisorState.currentModelIndex = 0
    advisorState.advisorInProgress = false
}
