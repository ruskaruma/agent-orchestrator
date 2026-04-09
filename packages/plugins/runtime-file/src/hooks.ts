/* eslint-disable no-useless-escape */

export const INBOX_READER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
INBOX_FILE="\${AO_INBOX_PATH:-}"
[[ -z "$INBOX_FILE" || ! -f "$INBOX_FILE" ]] && { echo '{}'; exit 0; }
CURSOR_FILE="\${INBOX_FILE}.hook-cursor"

cursor=0
if [[ -f "$CURSOR_FILE" ]]; then
  cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  [[ "$cursor" =~ ^[0-9]+$ ]] || cursor=0
else
  cursor=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)
  echo "$cursor" > "$CURSOR_FILE"; echo '{}'; exit 0
fi

file_size=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)
[[ "$file_size" -lt "$cursor" ]] && cursor=0
[[ "$file_size" -le "$cursor" ]] && { echo '{}'; exit 0; }

new_bytes=$(tail -c +$(( cursor + 1 )) "$INBOX_FILE" 2>/dev/null || echo "")
[[ -z "$new_bytes" ]] && { echo '{}'; exit 0; }

delivered_size=$file_size
if [[ \${#new_bytes} -gt 9500 ]]; then
  head_chunk="\${new_bytes:0:9500}"
  complete_lines="\${head_chunk%\$'\\n'*}"
  if [[ "$complete_lines" == "$head_chunk" || -z "$complete_lines" ]]; then
    new_bytes="\${new_bytes%%\$'\\n'*}"
  else
    new_bytes="$complete_lines
"
  fi
  delivered_size=$(( cursor + $(printf '%s' "$new_bytes" | wc -c | tr -d ' ') ))
fi

echo "$delivered_size" > "$CURSOR_FILE"
if command -v jq &>/dev/null; then
  escaped=$(echo "$new_bytes" | jq -Rs '.')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PostToolUse\\",\\"additionalContext\\":$escaped}}"
else
  escaped=$(echo "$new_bytes" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PostToolUse\\",\\"additionalContext\\":\\"$escaped\\"}}"
fi
`;

export const STOP_INBOX_CHECK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
INBOX_FILE="\${AO_INBOX_PATH:-}"
[[ -z "$INBOX_FILE" || ! -f "$INBOX_FILE" ]] && exit 0
CURSOR_FILE="\${INBOX_FILE}.hook-cursor"
BLOCK_COUNT_FILE="\${INBOX_FILE}.stop-blocks"

cursor=0
if [[ -f "$CURSOR_FILE" ]]; then
  cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  [[ "$cursor" =~ ^[0-9]+$ ]] || cursor=0
fi

file_size=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)
[[ "$file_size" -le "$cursor" ]] && { rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true; exit 0; }

block_count=0
[[ -f "$BLOCK_COUNT_FILE" ]] && block_count=$(cat "$BLOCK_COUNT_FILE" 2>/dev/null || echo 0)
block_count=$(( block_count + 1 ))
echo "$block_count" > "$BLOCK_COUNT_FILE"
[[ "$block_count" -ge 5 ]] && { rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true; exit 0; }

echo "You have unread messages ($(( file_size - cursor )) bytes) in your inbox at $INBOX_FILE. Read and process them before stopping." >&2
exit 2
`;

export const FILE_TRACKER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
input=$(cat 2>/dev/null || echo "{}")
FILE=""
command -v jq &>/dev/null && FILE=$(echo "$input" | jq -r '.tool_input.path // .tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
if [[ "$FILE" = /* ]]; then case "$FILE" in "\${PWD}"/*) FILE="\${FILE#\${PWD}/}" ;; esac; fi
mkdir -p .ao 2>/dev/null || true
echo "{\\"ts\\":$(date +%s000),\\"file\\":\\"$FILE\\"}" >> ".ao/working-files.jsonl"
`;

export const INBOX_WATCHER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
F="\${AO_INBOX_PATH:-}"
[[ -z "$F" || ! -f "$F" ]] && exit 0
command -v flock &>/dev/null || exit 0
exec 9>"\${F}.watcher-lock"; flock -n 9 || exit 0

new() {
  c=\$(grep -Eo '^[0-9]+' "\${F}.hook-cursor" 2>/dev/null || echo 0)
  s=\$(wc -c <"\$F" 2>/dev/null | tr -d ' ' || echo 0)
  (( s > c ))
}
wake() { .claude/ao-inbox-reader.sh; exit 2; }

new && wake
D=\$(( \$(date +%s) + 55 ))
if command -v inotifywait &>/dev/null; then
  while (( \$(date +%s) < D )); do
    r=\$(( D - \$(date +%s) )); (( r > 0 )) || break
    inotifywait -q -t "\$r" -e close_write,modify "\$F" 2>/dev/null || true
    new && wake
  done
elif command -v fswatch &>/dev/null; then
  while (( \$(date +%s) < D )); do
    r=\$(( D - \$(date +%s) )); (( r > 0 )) || break
    timeout "\$r" fswatch -1 --event Updated "\$F" 2>/dev/null || true
    new && wake
  done
else
  while (( \$(date +%s) < D )); do sleep 1; new && wake; done
fi
`;

const h = (cmd: string, timeout: number, extra?: Record<string, unknown>) =>
  ({ hooks: [{ type: "command" as const, command: cmd, timeout, ...extra }] });

export function getHookSettings(): Record<string, unknown> {
  return {
    hooks: {
      PostToolUse: [
        h(".claude/ao-inbox-reader.sh", 5000),
        h(".claude/ao-inbox-watcher.sh", 60000, { async: true, asyncRewake: true }),
        { matcher: "Write|Edit|MultiEdit", ...h(".claude/ao-file-tracker.sh", 3000) },
      ],
      Stop: [h(".claude/ao-stop-check.sh", 5000)],
      UserPromptSubmit: [{ matcher: "check inbox", ...h(".claude/ao-inbox-reader.sh", 5000) }],
    },
  };
}
