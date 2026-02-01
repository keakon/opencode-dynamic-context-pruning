export const NUDGE_BOTH = `<instruction name=context_management_required>
Context is filling with tool outputs. After the current atomic step, clean up:
1. Use \`discard\` for noise or completed work with no value.
2. Use \`extract\` when you must preserve key details.
</instruction>`
