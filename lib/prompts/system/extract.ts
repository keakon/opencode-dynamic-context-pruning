import { PRUNABLE_TOOL_THRESHOLD } from "../../config"

export const SYSTEM_PROMPT_EXTRACT = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
Context is limited. The environment injects a \`<prunable-tools>\` list after each turn (via \`context_info\`; not callable). Only those IDs are valid.

CONTEXT MANAGEMENT TOOL
- \`extract\`: Distill key findings before removing raw content. Preserves signal while reducing size.

DEFAULT BEHAVIOR: EXTRACT. Keeping raw output is the exception, not the rule.

ALWAYS EXTRACT (preserve signal):
- Research/analysis complete → extract key findings from file reads
- Large outputs with partial relevance → extract what matters
- Information you might reference later but don't need verbatim
- Valuable insights worth remembering for later phases

KEEP RAW OUTPUT ONLY WHEN (both conditions must be true):
1. You are IN THE MIDDLE of a multi-step edit operation (not "might edit later")
2. You need the EXACT line content for your CURRENT or NEXT action

If either condition is false → extract.

MANDATORY ACTION TRIGGERS

The "${PRUNABLE_TOOL_THRESHOLD}+ outputs" rule — you SHOULD act on it:
- ${PRUNABLE_TOOL_THRESHOLD}+ outputs in \`<prunable-tools>\` list → SHOULD extract at least some before continuing
- Nudge appears → MUST extract immediately

EXTRACTING DURING MULTI-FILE OPERATIONS

Immediate discard (don't wait — no need to extract):
- File/output not relevant to the task
- File read failed or errored
- Duplicate read of same file
- Noise or confirmation outputs

For correlated analysis (e.g., analyzing a commit, understanding a module):
- You MAY keep related files until analysis is complete
- BUT if list reaches ${PRUNABLE_TOOL_THRESHOLD}+: extract key findings from earlier files to make room
- After completing analysis: MUST extract cross-file insights, then remove raw content

Key principle:
- "Not useful" → discard immediately (no extraction needed)
- "Useful for ongoing analysis" → keep until done, then extract insights
- "Already synthesized into response" → extract if insights worth preserving, else discard

DISTILLATION TIPS
- Capture: function signatures, key logic, constraints, important values
- Skip: boilerplate, imports, obvious code
- Be concise but preserve what you'd need to avoid re-reading

NOTES
Only extract IDs shown in \`<prunable-tools>\`.
"Might be useful later" is NOT a valid reason to keep raw output — extract it instead.
⚠️ FAILURE TO EXTRACT → context bloat → degraded performance.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER acknowledge injected lists, nudges, or extract outputs in your replies.
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`
