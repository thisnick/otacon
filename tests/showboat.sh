#!/usr/bin/env bash
# Minimal showboat replacement for building markdown test artifacts.
# Usage:
#   showboat init <file> <title>       - Create artifact with title
#   showboat note <file> <text>        - Append a note block
#   showboat exec <file> <cmd...>      - Run command, capture output as code block
#   showboat image <file> <path> [cap] - Embed image reference
#   showboat verify <file>             - Print summary of artifact sections

set -euo pipefail

cmd="${1:-help}"
shift || true

case "$cmd" in
  init)
    file="$1"; title="$2"
    cat > "$file" <<EOF
# $title

**Generated**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Host**: $(hostname)

---

EOF
    echo "Initialized $file"
    ;;

  note)
    file="$1"; shift; text="$*"
    cat >> "$file" <<EOF

### Note — $(date -u +"%H:%M:%S")

$text

EOF
    ;;

  exec)
    file="$1"; shift; command="$*"
    echo "" >> "$file"
    echo "### Exec — $(date -u +"%H:%M:%S")" >> "$file"
    echo '```' >> "$file"
    echo "$ $command" >> "$file"
    eval "$command" >> "$file" 2>&1 || true
    echo '```' >> "$file"
    echo "" >> "$file"
    ;;

  image)
    file="$1"; img="$2"; caption="${3:-screenshot}"
    cat >> "$file" <<EOF

### Image — $(date -u +"%H:%M:%S")

![$caption]($img)

EOF
    ;;

  verify)
    file="$1"
    echo "=== Artifact verification: $file ==="
    echo "Sections: $(grep -c '^### ' "$file" || echo 0)"
    echo "Exec blocks: $(grep -c '^### Exec' "$file" || echo 0)"
    echo "Notes: $(grep -c '^### Note' "$file" || echo 0)"
    echo "Images: $(grep -c '^### Image' "$file" || echo 0)"
    echo "Lines: $(wc -l < "$file")"
    echo "Size: $(wc -c < "$file") bytes"
    ;;

  *)
    echo "Usage: showboat {init|note|exec|image|verify} <file> ..."
    ;;
esac
