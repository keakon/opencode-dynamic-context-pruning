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
CRITICAL: Context is near capacity. You MUST prune NOW before taking any other action.
- Discard all noise, errors, and superseded outputs immediately.
- Extract insights from any valuable content, then discard the raw output.
Do not ignore this warning. Context overflow will severely impact performance.
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
CRITICAL: Context is near capacity. You MUST discard NOW before taking any other action.
Discard all noise, errors, and superseded outputs immediately.
Do not ignore this warning. Context overflow will severely impact performance.
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
CRITICAL: Context is near capacity. You MUST extract NOW before taking any other action.
Extract all valuable insights, then remove the raw outputs.
Do not ignore this warning. Context overflow will severely impact performance.
</instruction>`,
    },
}

export function getNudgePrompt(mode: NudgeMode, urgency: NudgeUrgency): string {
    return NUDGE_PROMPTS[mode][urgency]
}
