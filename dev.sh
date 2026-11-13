#!/bin/sh
# macOS/Linux equivalent of dev.ps1; resolve paths relative to this checkout.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/scripts/dev-unix.mjs" "$@"
