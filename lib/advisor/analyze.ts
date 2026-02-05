/**
 * Small Model Advisor - Model Analysis
 *
 * Calls the small model to analyze context and generate pruning suggestions.
 * Uses OpenCode's temporary session mechanism (per docs/SMALL_MODEL_ADVISOR.md).
 */

import type {
    AnalysisContext,
    AdvisorResult,
    AdvisorModelResponse,
    PruneSuggestion,
    AdvisorState,
} from "./types"
import type { SmallModelAdvisorConfig } from "../config"
import { buildAdvisorPrompt, ADVISOR_SYSTEM_PROMPT, estimatePromptTokens } from "./prompt"
import { parseAdvisorModelResponse } from "./parse"
import { Logger } from "../logger"

/** Maximum prompt tokens to avoid excessive cost */
const MAX_PROMPT_TOKENS = 4000

/** Maximum consecutive failures before disabling advisor */
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Call the small model to analyze context and generate suggestions.
 * Uses OpenCode's temporary session mechanism for isolation.
 *
 * @param client - OpenCode client instance
 * @param context - Analysis context with tool information
 * @param advisorConfig - Advisor-specific configuration
 * @param advisorState - Advisor state for fallback model rotation
 * @param logger - Logger instance
 * @returns Advisor result with suggestions
 */
export async function analyzeContext(
    client: any,
    context: AnalysisContext,
    advisorConfig: SmallModelAdvisorConfig,
    advisorState: AdvisorState,
    logger: Logger,
): Promise<AdvisorResult> {
    const startTime = Date.now()

    // Build id to paramKey and id to callId mappings (string IDs)
    const idToParamKey = new Map<string, string>()
    const idToCallId = new Map<string, string>()
    for (const tool of context.tools) {
        idToParamKey.set(tool.id, tool.paramKey)
        idToCallId.set(tool.id, tool.callId)
    }

    // Check if advisor is disabled due to failures
    if (advisorState.disabled) {
        return {
            response: null,
            success: false,
            error: "Advisor disabled due to consecutive failures",
            latencyMs: Date.now() - startTime,
            idToParamKey,
            idToCallId,
        }
    }

    // Check prompt size
    const estimatedTokens = estimatePromptTokens(context, advisorConfig)
    if (estimatedTokens > MAX_PROMPT_TOKENS) {
        if (advisorConfig.debug) {
            logger.info(`[advisor] Prompt too large (${estimatedTokens} tokens), skipping analysis`)
        }
        return {
            response: null,
            success: false,
            error: "Prompt exceeds token limit",
            latencyMs: Date.now() - startTime,
            idToParamKey,
            idToCallId,
        }
    }

    const toolsInPrompt = context.tools.slice(0, advisorConfig.maxToolsInPrompt)
    const prompt = buildAdvisorPrompt(context, advisorConfig)

    // Get model list: small_model from OpenCode config + fallback models
    const modelList = await buildModelList(client, advisorConfig)
    if (modelList.length === 0) {
        return {
            response: null,
            success: false,
            error: "No model configured for advisor",
            latencyMs: Date.now() - startTime,
            idToParamKey,
            idToCallId,
        }
    }

    // Try models in round-robin order starting from currentModelIndex
    const maxRetries = modelList.length
    let lastError: string = ""

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const modelIndex = (advisorState.currentModelIndex + attempt) % modelList.length
        const model = modelList[modelIndex]

        try {
            const response = await callModelViaTemporarySession(
                client,
                model,
                prompt,
                advisorConfig.timeout,
                advisorConfig.debug ? logger : null,
            )

            if (!response) {
                lastError = `Empty response from model ${model}`
                continue
            }

            // Parse the response
            const maxId = context.maxToolId
            const allowedIds = new Set(toolsInPrompt.map((tool) => tool.id))
            const { response: parsed, parseError } = parseAdvisorModelResponse(
                response,
                maxId,
                allowedIds,
            )

            if (parseError) {
                if (advisorConfig.debug) {
                    logger.info(`[advisor] Parse error: ${parseError}`)
                }
                lastError = parseError
                continue
            }

            if (!parsed) {
                lastError = "Failed to parse advisor response"
                continue
            }

            // Success - update model index for next time
            advisorState.currentModelIndex = modelIndex

            if (advisorConfig.debug) {
                logger.info(
                    `[advisor] Analysis complete: ${parsed.discardIds.length} discard, ${parsed.extractItems.length} extract, ${Date.now() - startTime}ms`,
                )
            }

            return {
                response: parsed,
                success: true,
                latencyMs: Date.now() - startTime,
                idToParamKey,
                idToCallId,
            }
        } catch (error: any) {
            lastError = error.message || String(error)
            if (advisorConfig.debug) {
                logger.info(`[advisor] Model ${model} failed: ${lastError}`)
            }
            // Continue to next model
        }
    }

    // All models failed - advance index for next attempt (per docs 4.5)
    advisorState.currentModelIndex = (advisorState.currentModelIndex + 1) % modelList.length

    if (advisorConfig.debug) {
        logger.info(`[advisor] All models failed: ${lastError}`)
    }

    return {
        response: null,
        success: false,
        error: lastError,
        latencyMs: Date.now() - startTime,
        idToParamKey,
        idToCallId,
    }
}

/**
 * Build the list of models to try, starting with OpenCode's small_model.
 * This is async because client.config.get() may return a Promise.
 */
async function buildModelList(client: any, config: SmallModelAdvisorConfig): Promise<string[]> {
    const models: string[] = []

    // Get small_model from OpenCode config (async API)
    try {
        const configResult = await client.config?.get?.()
        const openCodeConfig = configResult?.data ?? configResult
        const smallModel = openCodeConfig?.small_model
        if (smallModel && typeof smallModel === "string") {
            models.push(smallModel)
        }
    } catch {
        // Ignore errors reading OpenCode config
    }

    // Add fallback models
    if (config.fallbackModels && config.fallbackModels.length > 0) {
        for (const model of config.fallbackModels) {
            if (!models.includes(model)) {
                models.push(model)
            }
        }
    }

    return models
}

/**
 * Call the model using OpenCode's temporary session mechanism.
 * Creates a session, sends the prompt, waits for response, then deletes the session.
 * Per docs/SMALL_MODEL_ADVISOR.md section 4.2.
 */
async function callModelViaTemporarySession(
    client: any,
    model: string,
    prompt: string,
    timeoutMs: number,
    logger: Logger | null,
): Promise<string | null> {
    let sessionId: string | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let aborted = false

    try {
        // 1. Create temporary session
        const createResponse = await client.session.create({
            body: { title: "[DCP] Advisor" },
            query: { directory: process.cwd() },
        })

        sessionId = createResponse?.data?.id || createResponse?.id
        if (!sessionId) {
            throw new Error("Failed to create temporary session")
        }

        if (logger) {
            logger.info(`[advisor] Created temporary session ${sessionId} with model ${model}`)
        }

        // 2. Parse provider/model format
        const [providerID, modelID] = model.split("/")
        if (!providerID || !modelID) {
            throw new Error(`Invalid model format: ${model}, expected provider/model`)
        }

        // 3. Set up timeout with abort
        timeoutId = setTimeout(() => {
            aborted = true
            try {
                client.session.abort?.({ path: { id: sessionId } })
            } catch {
                // Ignore abort errors
            }
        }, timeoutMs)

        // 4. Send prompt with model and system prompt
        const result = await client.session.prompt({
            path: { id: sessionId },
            body: {
                model: { providerID, modelID },
                system: ADVISOR_SYSTEM_PROMPT,
                noReply: false,
                parts: [{ type: "text", text: prompt }],
            },
        })

        if (aborted) {
            return null
        }

        // 5. Extract response content
        const content = extractResponseContent(result)

        return content
    } finally {
        // Clean up timeout
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
        // Always clean up the temporary session
        if (sessionId) {
            try {
                await client.session.delete?.({ path: { id: sessionId } })
                if (logger) {
                    logger.info(`[advisor] Deleted temporary session ${sessionId}`)
                }
            } catch {
                // Ignore cleanup errors
            }
        }
    }
}

/**
 * Extract text content from the session prompt response.
 * Handles the parts array format from OpenCode session.prompt.
 */
function extractResponseContent(result: any): string | null {
    if (!result) return null

    // Handle various response formats
    const data = result.data || result

    // Response with parts array (OpenCode session.prompt format)
    if (Array.isArray(data.parts)) {
        const textParts = data.parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text || p.content || "")
            .filter((t: string) => t.length > 0)
        if (textParts.length > 0) {
            return textParts.join("\n")
        }
    }

    // Direct string response
    if (typeof data === "string") {
        return data
    }

    // Response with content field
    if (typeof data.content === "string") {
        return data.content
    }

    // Response with text field
    if (typeof data.text === "string") {
        return data.text
    }

    // Response with messages array (like chat completions)
    if (Array.isArray(data.messages) && data.messages.length > 0) {
        const lastMessage = data.messages[data.messages.length - 1]
        if (typeof lastMessage.content === "string") {
            return lastMessage.content
        }
    }

    // OpenAI-style response
    if (data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content
    }

    return null
}

/**
 * Record advisor failure and potentially disable it.
 */
export function recordAdvisorFailure(state: AdvisorState): void {
    state.consecutiveFailures++
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.disabled = true
    }
}

/**
 * Record advisor success and reset failure counter.
 */
export function recordAdvisorSuccess(state: AdvisorState): void {
    state.consecutiveFailures = 0
}

/**
 * Convert AdvisorModelResponse to PruneSuggestion array.
 */
export function responseToPruneSuggestions(response: AdvisorModelResponse): PruneSuggestion[] {
    const suggestions: PruneSuggestion[] = []

    // Add discard suggestions
    for (const id of response.discardIds) {
        suggestions.push({ id, action: "discard" })
    }

    // Add extract suggestions
    for (const [id, summary] of response.extractItems) {
        suggestions.push({ id, action: "extract", summary })
    }

    return suggestions
}
