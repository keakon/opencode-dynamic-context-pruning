import { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/utils"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    return msg.info.time.created < state.lastCompaction
}

export const getLastUserMessage = (messages: WithParts[]): WithParts | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const addPruneToolIds = (state: SessionState, ids: string[]): string[] => {
    const added: string[] = []
    for (const id of ids) {
        if (!state.prune.toolIdSet.has(id)) {
            state.prune.toolIds.push(id)
            state.prune.toolIdSet.add(id)
            added.push(id)
        }
    }
    return added
}
