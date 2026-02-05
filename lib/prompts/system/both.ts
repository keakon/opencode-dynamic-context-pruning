import { PRUNABLE_TOOL_THRESHOLD } from "../../config"

export const SYSTEM_PROMPT_BOTH = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
Context is limited. The environment may inject a \`<prunable-tools>\` list when pruning is needed (via \`context_info\`; not callable). Only those IDs are valid.

TWO TOOLS FOR CONTEXT MANAGEMENT
- \`discard\`: Remove tool outputs completely. Use for noise, errors, outdated info.
- \`extract\`: Distill key findings before removing. Use when information has future value.

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

MANDATORY ACTION TRIGGERS

The "${PRUNABLE_TOOL_THRESHOLD}+ outputs" rule — you SHOULD act on it:
- ${PRUNABLE_TOOL_THRESHOLD}+ outputs in \`<prunable-tools>\` list → SHOULD prune at least some before continuing
- Nudge appears → MUST prune immediately

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
Only prune IDs shown in \`<prunable-tools>\`.
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
