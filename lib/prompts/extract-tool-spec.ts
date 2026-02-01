export const EXTRACT_TOOL_SPEC = `Extracts key findings from tool outputs into distilled knowledge, then removes raw outputs.

## The Prunable List
A \`<prunable-tools>\` list shows available IDs. Format: \`ID: tool, parameter\`. Only use IDs from this list.

## When to Use
- Task done and you want to preserve key findings
- Raw output too large but contains valuable details

## When NOT to Use
- You need exact content for your CURRENT or NEXT action (e.g., editing a file, grepping for strings)

## Format
- \`ids\`: Array of numeric ID strings from \`<prunable-tools>\`
- \`distillation\`: Array of strings, one per ID (positional: distillation[0] for ids[0])

Each distillation should capture essential info: signatures, logic, constraints, values.

## Example
[Uses extract with:
  ids: ["10", "11"],
  distillation: [
    "auth.ts: validateToken(token) -> User|null, checks cache (5min TTL) then OIDC. bcrypt 12 rounds. Tokens 128+ chars.",
    "user.ts: User { id: string; email: string; permissions: ('read'|'write'|'admin')[]; status: 'active'|'suspended' }"
  ]
]`
