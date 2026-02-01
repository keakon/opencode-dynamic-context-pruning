// Tool specs
import { DISCARD_TOOL_SPEC } from "./discard-tool-spec"
import { EXTRACT_TOOL_SPEC } from "./extract-tool-spec"

// System prompts
import { SYSTEM_PROMPT_BOTH } from "./system/both"
import { SYSTEM_PROMPT_DISCARD } from "./system/discard"
import { SYSTEM_PROMPT_EXTRACT } from "./system/extract"

const PROMPTS: Record<string, string> = {
    "discard-tool-spec": DISCARD_TOOL_SPEC,
    "extract-tool-spec": EXTRACT_TOOL_SPEC,
    "system/system-prompt-both": SYSTEM_PROMPT_BOTH,
    "system/system-prompt-discard": SYSTEM_PROMPT_DISCARD,
    "system/system-prompt-extract": SYSTEM_PROMPT_EXTRACT,
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
