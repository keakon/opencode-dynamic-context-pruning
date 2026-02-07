type NudgeUrgency = "normal" | "warn" | "critical"

const NUDGE_PROMPTS: Record<NudgeUrgency, string> = {
    normal: `<context-hint>
Optional: prune older tool outputs using \`prune\` (discard/extract) based on the list above.
</context-hint>`,
    warn: `<context-hint priority=high>
Context usage is growing. Recommended: prune older outputs using \`prune\` (discard/extract).
</context-hint>`,
    critical: `<context-hint priority=critical>
Context is near capacity, which may degrade response quality.
Prune before continuing using \`prune\` (discard/extract) based on the list above.
</context-hint>`,
}

export function getNudgePrompt(urgency: NudgeUrgency): string {
    return NUDGE_PROMPTS[urgency]
}
