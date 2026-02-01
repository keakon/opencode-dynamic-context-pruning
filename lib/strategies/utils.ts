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

export const calculateTokensSaved = (
    state: SessionState,
    messages: WithParts[],
    pruneToolIds: string[],
): number => {
    if (pruneToolIds.length === 0) {
        return 0
    }
    try {
        const pruneToolIdSet = new Set(pruneToolIds)
        let totalTokens = 0
        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type !== "tool" || !pruneToolIdSet.has(part.callID)) {
                    continue
                }
                if (part.state.status === "completed") {
                    if (part.tool === "question") {
                        const content = getPrunableContent(part.state.input?.questions, PRUNED_QUESTIONS)
                        if (content) {
                            totalTokens += countTokens(content)
                        }
                    } else {
                        const content = getPrunableContent(part.state.output, PRUNED_OUTPUT)
                        if (content) {
                            totalTokens += countTokens(content)
                        }
                    }
                } else if (part.state.status === "error") {
                    const input = part.state.input
                    if (input && typeof input === "object") {
                        for (const value of Object.values(input)) {
                            const content = getPrunableContent(value, PRUNED_INPUT)
                            if (content) {
                                totalTokens += countTokens(content)
                            }
                        }
                    }
                }
            }
        }
        return totalTokens
    } catch {
        // Tokenizer errors are non-critical; return 0 to avoid blocking pruning
        return 0
    }
}
