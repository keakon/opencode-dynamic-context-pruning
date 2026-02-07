export const PRUNE_TOOL_SPEC = `Prunes tool outputs from context. Supports two modes: discard (remove entirely) and extract (distill key findings then remove).

## The Prunable List
Multiple \`<prunable-tools>\` blocks may appear in conversation history. Always use IDs from the **latest** block (highest \`version\` attribute). Ignore all older blocks.
If no \`<prunable-tools>\` list is present, do NOT call this tool.

## When to Use discard
- Noise: Irrelevant or superseded outputs
- Task done: No valuable info to preserve

## When to Use extract
- Task done and you want to preserve key findings
- Raw output too large but contains valuable details

## When NOT to Use
- Output contains useful info you'll need later (use extract instead of discard)
- You need exact content for your CURRENT or NEXT action (e.g., editing a file)

## Format
- \`discard\`: Array of numeric ID strings from the latest \`<prunable-tools>\` to discard
- \`extract\`: Array of [id, distillation] tuples. Each tuple pairs a numeric ID with its distilled content.
At least one of \`discard\` or \`extract\` must be provided. An ID must not appear in both.

## Examples
[Discard only: prune with discard: ["5", "20", "21"]]
[Extract only: prune with extract: [["10", "auth.ts: validateToken(token) -> User|null, checks cache (5min TTL)"], ["11", "user.ts: User { id, email, permissions, status }"]]]
[Both: prune with discard: ["5", "20"], extract: [["10", "auth.ts: validateToken..."]]]`
