import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../shared-utils"

export const PRUNED_OUTPUT = "[Output pruned]"
export const PRUNED_INPUT = "[pruned]"
export const PRUNED_QUESTIONS = "[pruned - see output]"

/**
 * Get prunable content string if the value should be pruned.
 * Returns null if the value is already pruned or too short.
 */
export function getPrunableContent(value: any, placeholder: string): string | null {
    if (value == null || value === placeholder) return null
    const content = typeof value === "string" ? value : JSON.stringify(value)
    return content.length > placeholder.length ? content : null
}

export const prune = (state: SessionState, messages: WithParts[]): void => {
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIdSet.has(part.callID)) {
                continue
            }

            let modified = false
            if (part.state.status === "completed") {
                if (part.tool === "question") {
                    if (getPrunableContent(part.state.input?.questions, PRUNED_QUESTIONS)) {
                        part.state.input.questions = PRUNED_QUESTIONS
                        modified = true
                    }
                } else {
                    if (getPrunableContent(part.state.output, PRUNED_OUTPUT)) {
                        part.state.output = PRUNED_OUTPUT
                        modified = true
                    }
                }
            } else if (part.state.status === "error") {
                const input = part.state.input
                if (input && typeof input === "object") {
                    for (const key of Object.keys(input)) {
                        if (getPrunableContent(input[key], PRUNED_INPUT)) {
                            input[key] = PRUNED_INPUT
                            modified = true
                        }
                    }
                }
            }

            if (
                modified &&
                (state.earliestModifiedMsgIndex === -1 || i < state.earliestModifiedMsgIndex)
            ) {
                state.earliestModifiedMsgIndex = i
            }
        }
    }
}
