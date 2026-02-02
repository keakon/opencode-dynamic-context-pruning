import { isMessageCompacted } from "../shared-utils"
import type { SessionState, WithParts } from "../state"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const SYNTHETIC_MESSAGE_ID = "msg_01234567890123456789012345"
const SYNTHETIC_PART_ID = "prt_01234567890123456789012345"
const SYNTHETIC_CALL_ID = "call_01234567890123456789012345"

/**
 * Compute a lightweight hash of tool part states in the last message.
 * Used to detect content updates within the same message (e.g., running→completed).
 * Format: "status1,status2,..." for tool parts, or empty string if no tools.
 */
export function computeLastMsgToolStateHash(messages: WithParts[]): string {
    if (messages.length === 0) return ""
    const lastMsg = messages[messages.length - 1]
    const parts = Array.isArray(lastMsg.parts) ? lastMsg.parts : []
    const toolStates: string[] = []
    for (const part of parts) {
        if (part.type === "tool" && part.state) {
            toolStates.push(part.state.status || "unknown")
        }
    }
    return toolStates.join(",")
}

export const isDeepSeekOrKimi = (providerID: string, modelID: string): boolean => {
    const lowerProviderID = providerID.toLowerCase()
    const lowerModelID = modelID.toLowerCase()
    return (
        lowerProviderID.includes("deepseek") ||
        lowerProviderID.includes("kimi") ||
        lowerModelID.includes("deepseek") ||
        lowerModelID.includes("kimi")
    )
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    variant?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()

    return {
        info: {
            id: SYNTHETIC_MESSAGE_ID,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent || "code",
            model: userInfo.model,
            time: { created: now },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: SYNTHETIC_PART_ID,
                sessionID: userInfo.sessionID,
                messageID: SYNTHETIC_MESSAGE_ID,
                type: "text",
                text: content,
            },
        ],
    }
}

export const createSyntheticAssistantMessage = (
    baseMessage: WithParts,
    content: string,
    variant?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()

    return {
        info: {
            id: SYNTHETIC_MESSAGE_ID,
            sessionID: userInfo.sessionID,
            role: "assistant" as const,
            agent: userInfo.agent || "code",
            parentID: userInfo.id,
            modelID: userInfo.model.modelID,
            providerID: userInfo.model.providerID,
            mode: "default",
            path: {
                cwd: "/",
                root: "/",
            },
            time: { created: now, completed: now },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: SYNTHETIC_PART_ID,
                sessionID: userInfo.sessionID,
                messageID: SYNTHETIC_MESSAGE_ID,
                type: "text",
                text: content,
            },
        ],
    }
}

export const createSyntheticToolPart = (baseMessage: WithParts, content: string) => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()

    return {
        id: SYNTHETIC_PART_ID,
        sessionID: userInfo.sessionID,
        messageID: baseMessage.info.id,
        type: "tool" as const,
        callID: SYNTHETIC_CALL_ID,
        tool: "context_info",
        state: {
            status: "completed" as const,
            input: {},
            output: content,
            title: "Context Info",
            metadata: {},
            time: { start: now, end: now },
        },
    }
}

/**
 * Extracts a human-readable key from tool metadata for display purposes.
 */
export const extractParameterKey = (tool: string, parameters: any): string => {
    if (!parameters) return ""

    if (tool === "read" && parameters.filePath) {
        const offset = parameters.offset
        const limit = parameters.limit
        if (offset !== undefined && limit !== undefined) {
            return `${parameters.filePath} (lines ${offset}-${offset + limit})`
        }
        if (offset !== undefined) {
            return `${parameters.filePath} (lines ${offset}+)`
        }
        if (limit !== undefined) {
            return `${parameters.filePath} (lines 0-${limit})`
        }
        return parameters.filePath
    }
    if (tool === "write" && parameters.filePath) {
        return parameters.filePath
    }
    if (tool === "edit" && parameters.filePath) {
        return parameters.filePath
    }

    if (tool === "list") {
        return parameters.path || "(current directory)"
    }
    if (tool === "glob") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }
    if (tool === "grep") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }

    if (tool === "bash") {
        if (parameters.description) return parameters.description
        if (parameters.command) {
            return parameters.command.length > 50
                ? parameters.command.substring(0, 50) + "..."
                : parameters.command
        }
    }

    if (tool === "webfetch" && parameters.url) {
        return parameters.url
    }
    if (tool === "websearch" && parameters.query) {
        return `"${parameters.query}"`
    }
    if (tool === "codesearch" && parameters.query) {
        return `"${parameters.query}"`
    }

    if (tool === "todowrite") {
        return `${parameters.todos?.length || 0} todos`
    }
    if (tool === "todoread") {
        return "read todo list"
    }

    if (tool === "task" && parameters.description) {
        return parameters.description
    }
    if (tool === "skill" && parameters.name) {
        return parameters.name
    }

    if (tool === "lsp") {
        const op = parameters.operation || "lsp"
        const path = parameters.filePath || ""
        const line = parameters.line
        const char = parameters.character
        if (path && line !== undefined && char !== undefined) {
            return `${op} ${path}:${line}:${char}`
        }
        if (path) {
            return `${op} ${path}`
        }
        return op
    }

    if (tool === "question") {
        const questions = parameters.questions
        if (Array.isArray(questions) && questions.length > 0) {
            const headers = questions
                .map((q: any) => q.header || "")
                .filter(Boolean)
                .slice(0, 3)

            const count = questions.length
            const plural = count > 1 ? "s" : ""

            if (headers.length > 0) {
                const suffix = count > 3 ? ` (+${count - 3} more)` : ""
                return `${count} question${plural}: ${headers.join(", ")}${suffix}`
            }
            return `${count} question${plural}`
        }
        return "question"
    }

    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") {
        return ""
    }
    return paramStr.substring(0, 50)
}

export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
    const lastMsgId = messages.length > 0 ? messages[messages.length - 1].info.id : undefined
    const msgHash = messages.length + "_" + lastMsgId + "_" + state.lastCompaction

    if (state.toolIdListCacheHash === msgHash && state.toolIdListCache) {
        return state.toolIdListCache
    }
    const toolIds: string[] = []
    const toolIdToPartCache = new Map<string, { msgIndex: number; partIndex: number }>()

    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const msg = messages[msgIndex]
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex]
            if (part.type === "tool" && part.callID && part.tool) {
                toolIds.push(part.callID)
                toolIdToPartCache.set(part.callID, { msgIndex, partIndex })
            }
        }
    }
    state.toolIdListCache = toolIds
    state.toolIdListCacheHash = msgHash
    state.toolIdToIndexCache = new Map()
    for (let i = 0; i < toolIds.length; i++) {
        state.toolIdToIndexCache.set(toolIds[i], i)
    }
    state.toolIdToPartCache = toolIdToPartCache
    return toolIds
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}
