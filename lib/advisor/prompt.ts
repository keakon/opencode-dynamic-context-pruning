/**
 * Small Model Advisor - Prompt Generation
 *
 * Generates prompts for the small model to analyze pruning opportunities.
 * Aligned with docs/SMALL_MODEL_ADVISOR.md specification.
 */

import type { AnalysisContext } from "./types"
import type { SmallModelAdvisorConfig } from "../config"

/**
 * System prompt for the advisor model.
 * Instructs the model to analyze the FULL context including conversation and main model's reasoning.
 * Key principles:
 * - Understand what the main model is working on before suggesting pruning
 * - Be conservative: when in doubt, don't suggest pruning
 * - Respect protected items and turn protection
 * - Learn from feedback history
 */
export const ADVISOR_SYSTEM_PROMPT = `You are a context pruning advisor for a coding assistant.
Your job is to analyze the conversation context and suggest which tool outputs can be safely removed.

## Your Analysis Process

1. FIRST: Understand the current task
   - What is the user asking for?
   - What is the main model working on?
   - What multi-step operation might be in progress?

2. THEN: Evaluate each tool output
   - Is this output still relevant to the current task?
   - Might the main model need to reference this again?
   - Has the information been fully utilized or synthesized?

3. FINALLY: Make conservative suggestions
   - Only suggest pruning outputs you are CONFIDENT are no longer needed
   - When uncertain, do NOT suggest pruning

## Decision Criteria

### Safe to DISCARD (complete removal)
- Error outputs (file not found, syntax errors, failed commands)
- Superseded outputs (older version of same file, replaced by newer read)
- Confirmation outputs (git status after commit, build success, test passed)
- Content already synthesized into the main model's responses
- Outputs clearly unrelated to the current task

### Safe to EXTRACT (keep summary, remove raw content)
- Large file reads where only specific parts were used
- Search results where key findings have been noted in responses
- Documentation that has been referenced and understood
- Logs where the conclusion has been stated

### DO NOT suggest pruning (CRITICAL)
- Items marked [PROTECTED] - main model previously rejected pruning these
- Files that might be edited based on current task context
- Content the main model is actively reasoning about
- Context needed for ongoing multi-step operations
- Items younger than 2 turns (too fresh to judge)
- Outputs that inform the main model's current approach
- When uncertain about importance - KEEP IT

## Learning from Feedback (CRITICAL)

The "Recent Feedback" section shows how the main model responded to previous suggestions.
This is your primary source for improving future suggestions:

- "✓ Accepted" = your suggestion was helpful, continue similar suggestions
- "✗ Rejected" = the content was still needed, understand WHY:
  - If reason given: learn from it, avoid similar mistakes
  - If "kept for ongoing task": be more conservative about task-related content
  - If "original content preferred": extraction summaries may have been too aggressive
  
When you see rejection patterns (e.g., same paramKey pattern rejected multiple times),
STOP suggesting similar content until the task context clearly changes.

## Output Format

Respond with JSON only, no other text:
{
  "discardIds": ["1", "3"],
  "extractItems": [["2", "config.ts: defines API endpoints and auth keys"]],
  "reasoning": "Brief explanation based on your understanding of the current task"
}

If nothing should be pruned (this is a valid and common response):
{"discardIds": [], "extractItems": [], "reasoning": "All outputs are still relevant for the ongoing task"}

IMPORTANT:
- IDs must be strings (e.g., "1" not 1)
- extractItems is an array of [id, summary] tuples
- Keep summaries concise but informative (under 100 chars)
- Prefer returning empty suggestions over risking removal of needed content`

/**
 * Build the user prompt with FULL context information including conversation history.
 * This allows the small model to understand what the main model is working on.
 */
export function buildAdvisorPrompt(
    context: AnalysisContext,
    config: SmallModelAdvisorConfig,
): string {
    const lines: string[] = []

    // Section 1: Current task context (from recent conversation)
    lines.push("## Current Task Context")
    lines.push("")
    if (context.conversationSummary) {
        lines.push(context.conversationSummary)
    } else {
        lines.push("(No conversation context available)")
    }
    lines.push("")

    // Section 2: Main model's recent activity/reasoning
    if (context.recentAssistantActivity) {
        lines.push("## Main Model's Recent Activity")
        lines.push("")
        lines.push(context.recentAssistantActivity)
        lines.push("")
    }

    // Section 3: Token status
    lines.push("## Context Status")
    lines.push(`Current prunable tokens: ${context.currentTokens}`)
    lines.push(`Thresholds: warn=${context.warnThreshold}, critical=${context.criticalThreshold}`)
    lines.push(`Current turn: ${context.currentTurn}`)
    lines.push("")

    // Section 4: Feedback history (for learning from main model's decisions)
    if (context.feedbackSummary) {
        lines.push("## Recent Feedback (learn from main model's decisions)")
        lines.push(
            "Use this to calibrate your suggestions - rejection reasons are especially important:",
        )
        lines.push(context.feedbackSummary)
        lines.push("")
    }

    // Section 5: Tool outputs to analyze
    lines.push("## Tool Outputs to Analyze")
    lines.push("(sorted by priority = tokens × age, showing top candidates)")
    lines.push("")

    // Limit tools to maxToolsInPrompt
    const toolsToInclude = context.tools.slice(0, config.maxToolsInPrompt)

    // Format each tool entry
    for (const tool of toolsToInclude) {
        const turnAge = context.currentTurn - tool.turn
        const errorTag = tool.isError ? " [ERROR]" : ""
        const ageTag = turnAge > 1 ? ` [${turnAge} turns ago]` : " [recent]"
        const protectedTag = tool.isProtected ? " [PROTECTED]" : ""
        const scoreTag = ` (score: ${tool.priorityScore})`

        lines.push(
            `[${tool.id}] ${tool.tool}: ${tool.paramKey}${errorTag}${ageTag}${protectedTag}${scoreTag}`,
        )
        lines.push(`    Tokens: ${tool.tokens}`)

        // Include preview if enabled
        if (config.sendContentPreview && tool.outputPreview) {
            // Truncate and clean preview
            let preview = tool.outputPreview
            if (preview.length > config.contentPreviewLength) {
                preview = preview.substring(0, config.contentPreviewLength) + "..."
            }
            preview = preview.replace(/\n/g, " ").replace(/\s+/g, " ")
            lines.push(`    Preview: ${preview}`)
        }

        lines.push("")
    }

    if (context.tools.length > toolsToInclude.length) {
        lines.push(`(${context.tools.length - toolsToInclude.length} more tools not shown)`)
        lines.push("")
    }

    // Section 6: Instructions
    lines.push("## Your Task")
    lines.push("")
    lines.push("Based on the current task context and main model's activity:")
    lines.push("1. Identify which tool outputs are NO LONGER needed for the current task")
    lines.push("2. Only suggest pruning outputs you are CONFIDENT about")
    lines.push("3. Return JSON with discardIds, extractItems, and reasoning")
    lines.push("")
    lines.push(
        "Remember: When uncertain, return empty suggestions. It's better to keep too much than remove something needed.",
    )

    return lines.join("\n")
}

/**
 * Calculate approximate token count for the prompt.
 * Uses a simple heuristic of ~4 chars per token.
 */
export function estimatePromptTokens(
    context: AnalysisContext,
    config?: Pick<SmallModelAdvisorConfig, "maxToolsInPrompt">,
): number {
    // Estimate without actually building the prompt to save computation
    // System prompt is constant
    const systemTokens = Math.ceil(ADVISOR_SYSTEM_PROMPT.length / 4)

    // Estimate user prompt: headers (~200 chars) + feedback (~100 chars) + tools
    const headerTokens = 75
    const feedbackTokens = context.feedbackSummary
        ? Math.ceil(context.feedbackSummary.length / 4)
        : 0

    // Each tool contributes: header line (~80 chars) + token line (~20 chars) + preview (~200 chars)
    const perToolTokens = 75
    const maxToolsInPrompt = config?.maxToolsInPrompt ?? context.tools.length
    const toolsInPrompt = Math.min(context.tools.length, maxToolsInPrompt)
    const toolTokens = toolsInPrompt * perToolTokens

    return systemTokens + headerTokens + feedbackTokens + toolTokens
}
