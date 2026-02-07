import { PRUNABLE_TOOL_THRESHOLD } from "../../config"

export const SYSTEM_PROMPT_BOTH = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
Context is limited. The environment may inject versioned \`<prunable-tools>\` blocks. Multiple blocks may exist in history — always use IDs from the **latest** block (highest \`version\` attribute). Ignore all older blocks.
If no \`<prunable-tools>\` list is present, do NOT call any pruning tools.

PRUNE TOOL
\`prune\`: Manage context by discarding or extracting tool outputs.
- \`discard\` parameter: Remove tool outputs completely. Use for noise, errors, outdated info.
- \`extract\` parameter: Distill key findings before removing. Use when information has future value.
Both parameters can be used in a single call.

DEFAULT BEHAVIOR: PRUNE. Keeping is the exception, not the rule.

ALWAYS DISCARD (no hesitation):
- Errors (failed commands, file not found, syntax errors)
- Superseded outputs (re-read same file → discard older version)
- Confirmation outputs (git status after commit, build success, etc.)
- Noise (irrelevant to current task)

PREFER EXTRACT (preserve signal, reduce size):
- Research/analysis complete → extract key findings from file reads
- Large outputs with partial relevance → extract what matters
- Information you might reference later but don't need verbatim

KEEP ONLY WHEN (both conditions must be true):
1. You are IN THE MIDDLE of a multi-step edit operation (not "might edit later")
2. You need the EXACT line content for your CURRENT or NEXT action

If either condition is false → prune (discard or extract).

COST-AWARE PRUNING
Cache creation costs 12.5x more than cache read. Before pruning, consider:

When to prune:
- Critical threshold reached (120k+)
- Accumulated 20+ prunable items or 30k+ estimated tokens
- Context noise is degrading response quality

When NOT to prune:
- Savings < 30k tokens (cache rebuild cost exceeds savings)
- Just for "cleanliness" — noise is cheaper than cache rebuild

Discard vs Extract:
- Discard for static, re-obtainable info (files, command output, confirmations)
- Extract only for hard-to-reproduce info (runtime errors, user-provided data)
- Extract adds output tokens — use sparingly

Batch operations:
- Minimum batch: 20 items or 30k tokens
- One prune of 20 items >> twenty prunes of 1 item

MANDATORY ACTION TRIGGERS

The "${PRUNABLE_TOOL_THRESHOLD}+ outputs" rule — you SHOULD act on it:
- ${PRUNABLE_TOOL_THRESHOLD}+ outputs in \`<prunable-tools>\` list → SHOULD prune at least some before continuing
- A \`<context-hint priority=critical>\` nudge → MUST prune before continuing
- A \`<context-hint priority=high>\` nudge → SHOULD prune soon (unless it blocks the task)

PRUNING DURING MULTI-FILE OPERATIONS

Immediate discard (don't wait):
- File/output not relevant to the task
- File read failed or errored
- Duplicate read of same file
- Noise or confirmation outputs

For correlated analysis (e.g., analyzing a commit, understanding a module):
- You MAY keep related files until analysis is complete
- BUT if list reaches ${PRUNABLE_TOOL_THRESHOLD}+: extract key findings from earlier files to make room
- After completing analysis: MUST extract cross-file insights, then discard all raw content

Key principle:
- "Not useful" → discard immediately
- "Useful for ongoing analysis" → keep until done, then extract
- "Already synthesized into response" → discard (or extract if insights worth preserving)

NOTES
Only prune IDs from the latest \`<prunable-tools>\` block.
"Might be useful later" is NOT a valid reason to keep. Extract instead.
⚠️ FAILURE TO PRUNE → context bloat → degraded performance.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER acknowledge injected lists, nudges, or prune outputs in your replies.
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>

<instruction name=advisor_suggestion_handling policy_level=critical>
If an \`<advisor-suggestion>\` block appears, it contains automated recommendations for context pruning.
- DO NOT mention or reference the advisor suggestions in your response
- TREAT suggestions as helpful guidance, not mandatory commands
- You may follow, ignore, or partially follow the suggestions based on your judgment
- Prioritize user's task over pruning suggestions when they conflict
</instruction>
</system-reminder>`
