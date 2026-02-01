import { SessionState, WithParts } from "../state"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "../logger"
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"
import { PRUNED_INPUT, PRUNED_OUTPUT, PRUNED_QUESTIONS, getPrunableContent } from "../messages/prune"
import { buildToolIdList } from "../messages/utils"

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: state.variant,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = state.variant ?? userInfo.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

/**
 * Get unpruned tool IDs from messages, filtering out already pruned ones.
 * Returns null if no unpruned IDs found.
 */
export function getUnprunedToolIds(state: SessionState, messages: WithParts[]): string[] | null {
    const allToolIds = buildToolIdList(state, messages)
    if (allToolIds.length === 0) {
        return null
    }

    const unprunedIds = allToolIds.filter((id) => !state.prune.toolIdSet.has(id))
    return unprunedIds.length > 0 ? unprunedIds : null
}

/**
 * Calculates token count for a single tool call.
 * Returns 0 if the tool has no prunable content.
 */
export function getToolTokens(state: SessionState, messages: WithParts[], toolId: string): number {
    const cached = state.toolTokensCache.get(toolId)
    if (cached !== undefined) return cached

    const tokens = computeToolTokens(state, messages, toolId)
    state.toolTokensCache.set(toolId, tokens)
    return tokens
}

function computeToolTokens(state: SessionState, messages: WithParts[], toolId: string): number {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || part.callID !== toolId) {
                continue
            }
            if (part.state.status === "completed") {
                if (part.tool === "question") {
                    const content = getPrunableContent(part.state.input?.questions, PRUNED_QUESTIONS)
                    return content ? countTokens(content) : 0
                } else {
                    const content = getPrunableContent(part.state.output, PRUNED_OUTPUT)
                    return content ? countTokens(content) : 0
                }
            } else if (part.state.status === "error") {
                const input = part.state.input
                if (input && typeof input === "object") {
                    let tokens = 0
                    for (const value of Object.values(input)) {
                        const content = getPrunableContent(value, PRUNED_INPUT)
                        if (content) {
                            tokens += countTokens(content)
                        }
                    }
                    return tokens
                }
            }
        }
    }
    return 0
}

export const calculateTokensSaved = (
    state: SessionState,
    messages: WithParts[],
    pruneToolIds: string[],
): number => {
    if (pruneToolIds.length === 0) {
        return 0
    }
    try {
        let totalTokens = 0
        for (const id of pruneToolIds) {
            totalTokens += getToolTokens(state, messages, id)
        }
        return totalTokens
    } catch {
        // Tokenizer errors are non-critical; return 0 to avoid blocking pruning
        return 0
    }
}
