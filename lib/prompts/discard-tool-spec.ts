export const DISCARD_TOOL_SPEC = `Discards tool outputs from context.

## The Prunable List
A \`<prunable-tools>\` list shows available IDs. Format: \`ID: tool, parameter\`. Only use IDs from this list.

## When to Use
- Noise: Irrelevant or superseded outputs
- Task done: No valuable info to preserve

## When NOT to Use
- Output contains useful info you'll need later
- You plan to edit the file

## Format
- \`ids\`: Array of numeric ID strings from \`<prunable-tools>\`

## Example
[Uses discard with ids: ["5", "20", "21"]]`
