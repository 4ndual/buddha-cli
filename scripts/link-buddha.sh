#!/bin/sh
# Install the dev `buddha` wrapper into Bun's global bin directory.
#
# Replaces the bun-shebang symlink that `bun --cwd=packages/coding-agent link`
# creates with the safe wrapper at `packages/coding-agent/scripts/buddha`.
#
# We resolve Bun's global bin path defensively because `bun pm -g bin` aborts
# (`No package.json was found for directory "$HOME/.bun/install/global"`) on
# fresh hosts where the global install has not been initialized. Falling
# through that error would expand `$(bun pm -g bin)/buddha` to `/buddha` and try to
# write under `/`.
set -e

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
target=$repo_root/packages/coding-agent/scripts/buddha

if [ ! -x "$target" ]; then
	echo "link-buddha: target wrapper not found or not executable: $target" >&2
	exit 1
fi

global_bin=$(bun pm -g bin 2>/dev/null || true)
if [ -z "$global_bin" ]; then
	global_bin=${BUN_INSTALL:-$HOME/.bun}/bin
fi

mkdir -p "$global_bin"
ln -sfn "$target" "$global_bin/buddha"
echo "link-buddha: linked $global_bin/buddha -> $target"
