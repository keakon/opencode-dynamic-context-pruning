function normalizePath(input: string): string {
    return input.replaceAll("\\\\", "/")
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

const GLOB_REGEX_CACHE = new Map<string, RegExp>()
const GLOB_REGEX_CACHE_LIMIT = 100

/**
 * Basic glob matching with support for `**`, `*`, and `?`.
 *
 * Notes:
 * - Matching is performed against the full (normalized) string.
 * - `*` and `?` do not match `/`.
 * - `**` matches across `/`.
 */
export function matchesGlob(inputPath: string, pattern: string): boolean {
    if (!pattern) return false

    const input = normalizePath(inputPath)
    const pat = normalizePath(pattern)
    const cached = GLOB_REGEX_CACHE.get(pat)
    if (cached) {
        return cached.test(input)
    }

    let regex = "^"

    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i]

        if (ch === "*") {
            const next = pat[i + 1]
            if (next === "*") {
                const after = pat[i + 2]
                if (after === "/") {
                    // **/  (zero or more directories)
                    regex += "(?:.*/)?"
                    i += 2
                    continue
                }

                // **
                regex += ".*"
                i++
                continue
            }

            // *
            regex += "[^/]*"
            continue
        }

        if (ch === "?") {
            regex += "[^/]"
            continue
        }

        if (ch === "/") {
            regex += "/"
            continue
        }

        regex += escapeRegExpChar(ch)
    }

    regex += "$"

    const compiled = new RegExp(regex)
    GLOB_REGEX_CACHE.set(pat, compiled)
    if (GLOB_REGEX_CACHE.size > GLOB_REGEX_CACHE_LIMIT) {
        const oldestKey = GLOB_REGEX_CACHE.keys().next().value as string | undefined
        if (oldestKey) {
            GLOB_REGEX_CACHE.delete(oldestKey)
        }
    }
    return compiled.test(input)
}

export function getFilePathFromParameters(parameters: unknown): string | undefined {
    if (typeof parameters !== "object" || parameters === null) {
        return undefined
    }

    const record = parameters as Record<string, unknown>
    const filePath = record.filePath
    if (typeof filePath === "string" && filePath.length > 0) {
        return filePath
    }
    const snake = record.file_path
    if (typeof snake === "string" && snake.length > 0) {
        return snake
    }
    return undefined
}

export function isProtectedFilePath(filePath: string | undefined, patterns: string[]): boolean {
    if (!filePath) return false
    if (!patterns || patterns.length === 0) return false

    return patterns.some((pattern) => matchesGlob(filePath, pattern))
}

/**
 * Check if a tool call should be protected from pruning.
 * Unified logic used by inject, sweep, deduplication, purge-errors, supersede-writes.
 */
export function isToolCallProtected(
    tool: string,
    parameters: unknown,
    protectedTools: string[],
    protectedFilePatterns: string[],
): boolean {
    if (protectedTools.includes(tool)) {
        return true
    }
    const filePath = getFilePathFromParameters(parameters)
    return isProtectedFilePath(filePath, protectedFilePatterns)
}
