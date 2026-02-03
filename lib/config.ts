import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface DiscardTool {
    enabled: boolean
}

export interface ExtractTool {
    enabled: boolean
    showDistillation: boolean
}

export interface ToolSettings {
    nudgeEnabled: boolean
    nudgeFrequency: number
    protectedTools: string[]
    injectPrunableTools: "always" | "on_demand" | "on_warn"
}

export interface Tools {
    settings: ToolSettings
    discard: DiscardTool
    extract: ExtractTool
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface SupersedeWrites {
    enabled: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface PurgeStaleOutputs {
    enabled: boolean
    turns: number
    minPrunableCount: number
    preserveRecent: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface TokenBudget {
    enabled: boolean
    warnThreshold: number
    criticalThreshold: number
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    commands: Commands
    turnProtection: TurnProtection
    tokenBudget: TokenBudget
    protectedFilePatterns: string[]
    tools: Tools
    strategies: {
        deduplication: Deduplication
        supersedeWrites: SupersedeWrites
        purgeErrors: PurgeErrors
        purgeStaleOutputs: PurgeStaleOutputs
    }
}

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "todowrite",
    "todoread",
    "discard",
    "extract",
    "batch",
    "write",
    "edit",
    "plan_enter",
    "plan_exit",
]

/**
 * Threshold for triggering normal nudge based on prunable tool count.
 * This value is also used in system prompts (N+ outputs rule).
 */
export const PRUNABLE_TOOL_THRESHOLD = 8

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "$schema",
    "enabled",
    "debug",
    "showUpdateToasts", // Deprecated but kept for backwards compatibility
    "pruneNotification",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "tokenBudget",
    "tokenBudget.enabled",
    "tokenBudget.warnThreshold",
    "tokenBudget.criticalThreshold",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "tools",
    "tools.settings",
    "tools.settings.nudgeEnabled",
    "tools.settings.nudgeFrequency",
    "tools.settings.protectedTools",
    "tools.settings.injectPrunableTools",
    "tools.discard",
    "tools.discard.enabled",
    "tools.extract",
    "tools.extract.enabled",
    "tools.extract.showDistillation",
    "strategies",
    // strategies.deduplication
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    // strategies.supersedeWrites
    "strategies.supersedeWrites",
    "strategies.supersedeWrites.enabled",
    // strategies.purgeErrors
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    // strategies.purgeStaleOutputs
    "strategies.purgeStaleOutputs",
    "strategies.purgeStaleOutputs.enabled",
    "strategies.purgeStaleOutputs.turns",
    "strategies.purgeStaleOutputs.minPrunableCount",
    "strategies.purgeStaleOutputs.preserveRecent",
    "strategies.purgeStaleOutputs.protectedTools",
])

// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

// Type validators for config values
interface ValidationError {
    key: string
    expected: string
    actual: string
}

type ValidatorType = "boolean" | "number" | "string" | "string[]" | string[]

// Declarative schema for config validation
const CONFIG_SCHEMA: Record<string, ValidatorType> = {
    enabled: "boolean",
    debug: "boolean",
    pruneNotification: ["off", "minimal", "detailed"],
    protectedFilePatterns: "string[]",
    "turnProtection.enabled": "boolean",
    "turnProtection.turns": "number",
    "tokenBudget.enabled": "boolean",
    "tokenBudget.warnThreshold": "number",
    "tokenBudget.criticalThreshold": "number",
    "commands.enabled": "boolean",
    "commands.protectedTools": "string[]",
    "tools.settings.nudgeEnabled": "boolean",
    "tools.settings.nudgeFrequency": "number",
    "tools.settings.protectedTools": "string[]",
    "tools.settings.injectPrunableTools": ["always", "on_demand", "on_warn"],
    "tools.discard.enabled": "boolean",
    "tools.extract.enabled": "boolean",
    "tools.extract.showDistillation": "boolean",
    "strategies.deduplication.enabled": "boolean",
    "strategies.deduplication.protectedTools": "string[]",
    "strategies.supersedeWrites.enabled": "boolean",
    "strategies.purgeErrors.enabled": "boolean",
    "strategies.purgeErrors.turns": "number",
    "strategies.purgeErrors.protectedTools": "string[]",
    "strategies.purgeStaleOutputs.enabled": "boolean",
    "strategies.purgeStaleOutputs.turns": "number",
    "strategies.purgeStaleOutputs.minPrunableCount": "number",
    "strategies.purgeStaleOutputs.preserveRecent": "number",
    "strategies.purgeStaleOutputs.protectedTools": "string[]",
}

function getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((o, k) => o?.[k], obj)
}

function validateField(
    config: Record<string, any>,
    key: string,
    validator: ValidatorType,
): ValidationError | null {
    const value = getNestedValue(config, key)
    if (value === undefined) return null

    if (Array.isArray(validator)) {
        // Enum validation
        if (!validator.includes(value)) {
            return {
                key,
                expected: validator.map((v) => `"${v}"`).join(" | "),
                actual: JSON.stringify(value),
            }
        }
    } else if (validator === "string[]") {
        if (!Array.isArray(value)) {
            return { key, expected: "string[]", actual: typeof value }
        }
        if (!value.every((v) => typeof v === "string")) {
            return { key, expected: "string[]", actual: "non-string entries" }
        }
    } else if (typeof value !== validator) {
        return { key, expected: validator, actual: typeof value }
    }
    return null
}

function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    // Schema-based validation
    for (const [key, validator] of Object.entries(CONFIG_SCHEMA)) {
        const error = validateField(config, key, validator)
        if (error) errors.push(error)
    }

    // Special validation: threshold monotonicity
    const warnThreshold = config.tokenBudget?.warnThreshold
    const criticalThreshold = config.tokenBudget?.criticalThreshold
    if (
        typeof warnThreshold === "number" &&
        typeof criticalThreshold === "number" &&
        warnThreshold > criticalThreshold
    ) {
        errors.push({
            key: "tokenBudget.warnThreshold",
            expected: "≤ criticalThreshold",
            actual: `${warnThreshold} > ${criticalThreshold}`,
        })
    }

    return errors
}

// Show validation warnings for a config file
function showConfigValidationWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: Invalid ${configType}`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    tokenBudget: {
        enabled: true,
        warnThreshold: 60000,
        criticalThreshold: 100000,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            nudgeEnabled: true,
            nudgeFrequency: 10,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            injectPrunableTools: "on_demand",
        },
        discard: {
            enabled: true,
        },
        extract: {
            enabled: true,
            showDistillation: false,
        },
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        supersedeWrites: {
            enabled: true,
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
        purgeStaleOutputs: {
            enabled: true,
            turns: 5,
            minPrunableCount: 10,
            preserveRecent: 3,
            protectedTools: [],
        },
    },
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    // Global: ~/.config/opencode/dcp.jsonc|json
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    // Custom config directory: $OPENCODE_CONFIG_DIR/dcp.jsonc|json
    let configDirPath: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        if (existsSync(configJsonc)) {
            configDirPath = configJsonc
        } else if (existsSync(configJson)) {
            configDirPath = configJson
        }
    }

    // Project: <project>/.opencode/dcp.jsonc|json
    let projectPath: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc
            } else if (existsSync(projectJson)) {
                projectPath = projectJson
            }
        }
    }

    return { global: globalPath, configDir: configDirPath, project: projectPath }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null }
    }

    try {
        const parsed = parse(fileContent)
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

// Helper: merge two arrays and deduplicate
function mergeArrays<T>(base: T[], override?: T[]): T[] {
    if (!override || override.length === 0) return base
    return [...new Set([...base, ...override])]
}

// Helper: get value with fallback
function val<T>(override: T | undefined, base: T): T {
    return override ?? base
}

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) return base
    return {
        deduplication: {
            enabled: val(override.deduplication?.enabled, base.deduplication.enabled),
            protectedTools: mergeArrays(
                base.deduplication.protectedTools,
                override.deduplication?.protectedTools,
            ),
        },
        supersedeWrites: {
            enabled: val(override.supersedeWrites?.enabled, base.supersedeWrites.enabled),
        },
        purgeErrors: {
            enabled: val(override.purgeErrors?.enabled, base.purgeErrors.enabled),
            turns: val(override.purgeErrors?.turns, base.purgeErrors.turns),
            protectedTools: mergeArrays(
                base.purgeErrors.protectedTools,
                override.purgeErrors?.protectedTools,
            ),
        },
        purgeStaleOutputs: {
            enabled: val(override.purgeStaleOutputs?.enabled, base.purgeStaleOutputs.enabled),
            turns: val(override.purgeStaleOutputs?.turns, base.purgeStaleOutputs.turns),
            minPrunableCount: val(
                override.purgeStaleOutputs?.minPrunableCount,
                base.purgeStaleOutputs.minPrunableCount,
            ),
            preserveRecent: val(
                override.purgeStaleOutputs?.preserveRecent,
                base.purgeStaleOutputs.preserveRecent,
            ),
            protectedTools: mergeArrays(
                base.purgeStaleOutputs.protectedTools,
                override.purgeStaleOutputs?.protectedTools,
            ),
        },
    }
}

function mergeTools(
    base: PluginConfig["tools"],
    override?: Partial<PluginConfig["tools"]>,
): PluginConfig["tools"] {
    if (!override) return base
    return {
        settings: {
            nudgeEnabled: val(override.settings?.nudgeEnabled, base.settings.nudgeEnabled),
            nudgeFrequency: val(override.settings?.nudgeFrequency, base.settings.nudgeFrequency),
            protectedTools: mergeArrays(
                base.settings.protectedTools,
                override.settings?.protectedTools,
            ),
            injectPrunableTools: val(
                override.settings?.injectPrunableTools,
                base.settings.injectPrunableTools,
            ),
        },
        discard: {
            enabled: val(override.discard?.enabled, base.discard.enabled),
        },
        extract: {
            enabled: val(override.extract?.enabled, base.extract.enabled),
            showDistillation: val(
                override.extract?.showDistillation,
                base.extract.showDistillation,
            ),
        },
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) return base
    return {
        enabled: val(override.enabled, base.enabled),
        protectedTools: mergeArrays(base.protectedTools, override.protectedTools),
    }
}

function mergeTokenBudget(
    base: PluginConfig["tokenBudget"],
    override?: Partial<PluginConfig["tokenBudget"]>,
): PluginConfig["tokenBudget"] {
    if (!override) return base
    return {
        enabled: val(override.enabled, base.enabled),
        warnThreshold: val(override.warnThreshold, base.warnThreshold),
        criticalThreshold: val(override.criticalThreshold, base.criticalThreshold),
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        turnProtection: { ...config.turnProtection },
        tokenBudget: { ...config.tokenBudget },
        protectedFilePatterns: [...config.protectedFilePatterns],
        tools: {
            settings: {
                ...config.tools.settings,
                protectedTools: [...config.tools.settings.protectedTools],
            },
            discard: { ...config.tools.discard },
            extract: { ...config.tools.extract },
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites,
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
            purgeStaleOutputs: {
                ...config.strategies.purgeStaleOutputs,
                protectedTools: [...config.strategies.purgeStaleOutputs.protectedTools],
            },
        },
    }
}

function mergeConfigOverride(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        commands: mergeCommands(config.commands, data.commands as any),
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        tokenBudget: mergeTokenBudget(config.tokenBudget, data.tokenBudget),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        tools: mergeTools(config.tools, data.tools as any),
        strategies: mergeStrategies(config.strategies, data.strategies as any),
    }
}

function loadAndMergeConfig(
    ctx: PluginInput,
    config: PluginConfig,
    configPath: string,
    configLabel: string,
    isProject: boolean,
): PluginConfig {
    const result = loadConfigFile(configPath)
    if (result.parseError) {
        setTimeout(() => {
            try {
                ctx.client.tui.showToast({
                    body: {
                        title: `DCP: Invalid ${configLabel}`,
                        message: `${configPath}\n${result.parseError}\nUsing ${isProject ? "global/" : ""}default values`,
                        variant: "warning",
                        duration: 7000,
                    },
                })
            } catch {}
        }, 7000)
    } else if (result.data) {
        showConfigValidationWarnings(ctx, configPath, result.data, isProject)
        return mergeConfigOverride(config, result.data)
    }
    return config
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    // Load and merge global config
    if (configPaths.global) {
        config = loadAndMergeConfig(ctx, config, configPaths.global, "config", false)
    } else {
        createDefaultConfig()
    }

    // Load and merge $OPENCODE_CONFIG_DIR/dcp.jsonc|json (overrides global)
    if (configPaths.configDir) {
        config = loadAndMergeConfig(ctx, config, configPaths.configDir, "configDir config", true)
    }

    // Load and merge project config (overrides global)
    if (configPaths.project) {
        config = loadAndMergeConfig(ctx, config, configPaths.project, "project config", true)
    }

    return config
}
