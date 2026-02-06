type NudgeUrgency = "normal" | "warn" | "critical"

const NUDGE_PROMPTS: Record<NudgeUrgency, string> = {
    normal: `<context-hint>
Some tool outputs may no longer be needed. You can review the list above and decide whether to prune:
- Use \`prune\` with \`discard\` to remove outputs that have no further value
- Use \`prune\` with \`extract\` to distill key findings before removing
This is optional — use your judgment based on the current task.
</context-hint>`,
    warn: `<context-hint priority=high>
Context usage is growing. Consider pruning older outputs to maintain response quality:
- Use \`prune\` with \`discard\` for outputs you no longer need verbatim
- Use \`prune\` with \`extract\` to preserve key findings before removing raw content
Pruning is recommended but not mandatory — prioritize your current task.
</context-hint>`,
    critical: `<context-hint priority=critical>
Context is near capacity, which may degrade response quality.
Strongly consider pruning before continuing:
1. Review the prunable-tools list above
2. Use \`prune\` with \`discard\` for noise, errors, superseded outputs, and old file reads
3. Use \`prune\` with \`extract\` to preserve insights from valuable content before removing

Use your judgment — but be aware that context overflow will impact performance.
</context-hint>`,
}

export function getNudgePrompt(urgency: NudgeUrgency): string {
    return NUDGE_PROMPTS[urgency]
}
