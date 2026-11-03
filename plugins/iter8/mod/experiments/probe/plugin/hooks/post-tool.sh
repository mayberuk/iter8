#!/usr/bin/env bash
set -uo pipefail

POINTER=$'Review round R5 from larkspur · 1 note — run `iter8 show R5`'
ROOT=${CLAUDE_PLUGIN_ROOT:?}

input=$(cat)
if [[ -f $ROOT/armed ]]; then armed=true; else armed=false; fi
has_agent=$(jq -r 'has("agent_id")' <<< "$input" 2>/dev/null || echo false)
tool=$(jq -r '.tool_name // ""' <<< "$input" 2>/dev/null || true)

jq -cn --argjson hasAgentId "$has_agent" --argjson armed "$armed" --arg tool "$tool" \
  '{hasAgentId: $hasAgentId, armed: $armed, tool: $tool}' >> "$ROOT/post-tool-hook.jsonl"

if [[ $armed == true && $has_agent == false ]]; then
  jq -cn --arg context "$POINTER" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $context}}'
fi
exit 0
