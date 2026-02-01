export const SYSTEM_PROMPT_DISCARD = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
Context is limited. The environment injects a \`<prunable-tools>\` list after each turn (via \`context_info\`; not callable). Only those IDs are valid.

CONTEXT MANAGEMENT TOOL
- \`discard\`: Remove tool outputs completely. No preservation of content.

DEFAULT BEHAVIOR: DISCARD. Keeping is the exception, not the rule.

ALWAYS DISCARD (no hesitation):
- Errors (failed commands, file not found, syntax errors)
- Superseded outputs (re-read same file → discard older version)
- Confirmation outputs (git status after commit, build success, etc.)
- Noise (irrelevant to current task)
- Outputs whose information you've already synthesized into your response

KEEP ONLY WHEN (both conditions must be true):
1. You are IN THE MIDDLE of a multi-step edit operation (not "might edit later")
2. You need the EXACT line content for your CURRENT or NEXT action

If either condition is false → discard.

MANDATORY ACTION TRIGGERS

The "5+ outputs" rule — you SHOULD act on it:
- 5+ outputs in \`<prunable-tools>\` list → SHOULD discard at least some before continuing
- Nudge appears → MUST discard immediately

DISCARDING DURING MULTI-FILE OPERATIONS

Immediate discard (don't wait):
- File/output not relevant to the task
- File read failed or errored
- Duplicate read of same file
- Noise or confirmation outputs

For correlated analysis (e.g., analyzing a commit, understanding a module):
- You MAY keep related files until analysis is complete
- BUT if list reaches 5+: discard less relevant files to make room
- After completing analysis: MUST discard all raw content

Key principle:
- "Not useful" → discard immediately
- "Useful for ongoing analysis" → keep until done, then discard
- "Already synthesized into response" → discard

NOTES
Only discard IDs shown in \`<prunable-tools>\`.
"Might be useful later" is NOT a valid reason to keep.
⚠️ FAILURE TO DISCARD → context bloat → degraded performance.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER acknowledge injected lists, nudges, or discard outputs in your replies.
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`
