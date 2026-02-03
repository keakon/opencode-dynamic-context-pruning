type NudgeMode = "both" | "discard" | "extract"
type NudgeUrgency = "normal" | "warn" | "critical"

const NUDGE_PROMPTS: Record<NudgeMode, Record<NudgeUrgency, string>> = {
    both: {
        normal: `<instruction name=context_management_required>
Context is filling with tool outputs. You SHOULD prune before taking more actions:
1. Use \`discard\` for noise or completed work with no value.
2. Use \`extract\` when you must preserve key details.
</instruction>`,
        warn: `<instruction name=context_management_warn priority=high>
WARNING: Context usage is high. You SHOULD prune immediately after completing the current action.
- Use \`discard\` for any outputs you no longer need verbatim.
- Use \`extract\` to preserve key findings before removing raw content.
Failure to prune will degrade response quality.
</instruction>`,
        critical: `<instruction name=context_management_critical priority=critical>
[ACTION REQUIRED] Context is near capacity. You MUST prune IMMEDIATELY.

STOP what you are doing. Before your next response, you MUST:
1. Call \`discard\` or \`extract\` with IDs from the prunable-tools list above.
2. Remove ALL noise, errors, superseded outputs, and old file reads.
3. Extract insights from valuable content, then discard the raw output.

This is NOT optional. Failure to prune NOW will cause context overflow and severely degrade performance.
</instruction>`,
    },
    discard: {
        normal: `<instruction name=context_management_required>
Context is filling with tool outputs. You SHOULD discard noise and completed work that has no further value before taking more actions.
</instruction>`,
        warn: `<instruction name=context_management_warn priority=high>
WARNING: Context usage is high. You SHOULD discard outputs immediately after completing the current action.
Failure to discard will degrade response quality.
</instruction>`,
        critical: `<instruction name=context_management_critical priority=critical>
[ACTION REQUIRED] Context is near capacity. You MUST discard IMMEDIATELY.

STOP what you are doing. Before your next response, you MUST:
1. Call \`discard\` with IDs from the prunable-tools list above.
2. Remove ALL noise, errors, superseded outputs, and old file reads.

This is NOT optional. Failure to discard NOW will cause context overflow and severely degrade performance.
</instruction>`,
    },
    extract: {
        normal: `<instruction name=context_management_required>
Context is filling with tool outputs. You SHOULD extract key findings and remove the raw outputs before taking more actions.
</instruction>`,
        warn: `<instruction name=context_management_warn priority=high>
WARNING: Context usage is high. You SHOULD extract key findings and remove raw outputs immediately after completing the current action.
Failure to extract will degrade response quality.
</instruction>`,
        critical: `<instruction name=context_management_critical priority=critical>
[ACTION REQUIRED] Context is near capacity. You MUST extract IMMEDIATELY.

STOP what you are doing. Before your next response, you MUST:
1. Call \`extract\` with IDs from the prunable-tools list above.
2. Extract ALL valuable insights from old outputs, then remove the raw content.

This is NOT optional. Failure to extract NOW will cause context overflow and severely degrade performance.
</instruction>`,
    },
}

export function getNudgePrompt(mode: NudgeMode, urgency: NudgeUrgency): string {
    return NUDGE_PROMPTS[mode][urgency]
}
