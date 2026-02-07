// Tool specs
import { PRUNE_TOOL_SPEC } from "./prune-tool-spec"

// System prompts
import { SYSTEM_PROMPT_BOTH } from "./system/both"

const PROMPTS: Record<string, string> = {
    "prune-tool-spec": PRUNE_TOOL_SPEC,
    "system/system-prompt-both": SYSTEM_PROMPT_BOTH,
}

// Simple cache for prompts with variable substitution (no LRU needed - prompts are static and few)
const PROMPT_CACHE = new Map<string, string>()

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    // Build cache key: name + sorted vars for stability
    let cacheKey = name
    if (vars) {
        const sortedPairs = Object.keys(vars)
            .sort()
            .map((k) => `${k}=${vars[k]}`)
        cacheKey += "|" + sortedPairs.join("&")
    }

    const cached = PROMPT_CACHE.get(cacheKey)
    if (cached !== undefined) {
        return cached
    }

    let content = PROMPTS[name]
    if (!content) {
        throw new Error(`Prompt not found: ${name}`)
    }
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    PROMPT_CACHE.set(cacheKey, content)
    return content
}
