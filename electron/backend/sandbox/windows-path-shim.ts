/**
 * Agent hooks registered by the Windows agent configuration read `node "C:/Users/me/.strideterm/hooks/notify.mjs" Stop`,
 * a command a Linux shell inside WSL cannot resolve. The sandbox's `node` is this wrapper: it rewrites an argument that
 * starts with a Windows drive (`C:/…`, `C:\…`) to its `/mnt/<drive>/…` form and runs the real `node`. The hook folders are
 * readable in the sandbox under that same notation, and nothing else about the command changes.
 */
export const WSL_NODE_SHIM = String.raw`#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
real=
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -z "$dir" ] && continue
  [ "$dir" = "$here" ] && continue
  if [ -x "$dir/node" ]; then real="$dir/node"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then echo "strIDEterm sandbox: node was not found" >&2; exit 127; fi
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  arg=$1
  shift
  case "$arg" in
    [A-Za-z]:/*|[A-Za-z]:\\*)
      drive=$(printf '%s' "$arg" | cut -c1 | tr 'A-Z' 'a-z')
      rest=$(printf '%s' "$arg" | cut -c3- | tr '\\' '/')
      arg="/mnt/$drive$rest"
      ;;
  esac
  set -- "$@" "$arg"
  i=$((i + 1))
done
exec "$real" "$@"
`;
