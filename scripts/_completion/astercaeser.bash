#!/usr/bin/env bash
# Tab-completion for the `astercaeser` umbrella + every `astercaeser-*` CLI.
#
# Source from your shell rc:
#     source /path/to/astercaeser-ui/scripts/_completion/astercaeser.bash
#
# Or wire it once per machine:
#     sudo install -m 644 astercaeser.bash /etc/bash_completion.d/astercaeser
#
# What it does:
#   - On the first word after `astercaeser`, complete with the list of
#     subcommands (`mail`, `calendar`, ...).
#   - On subsequent words, complete with the subcommand's first-token
#     subcommands (`list`, `show`, ...) which we cache by parsing the
#     tool's own --help output. Updates lazily; refresh by running
#     `_astercaeser_refresh_cache`.
#   - Same completion works for the individual `astercaeser-foo` scripts.

_astercaeser_scripts_dir() {
    # Resolve the scripts/ dir from the script that sources us. We assume
    # the user sourced the file directly out of scripts/_completion/.
    local self="${BASH_SOURCE[0]}"
    while [ -L "$self" ]; do self=$(readlink "$self"); done
    cd "$(dirname "$self")/.." && pwd
}

declare -A _ASTERCAESER_SUBS_CACHE=()

_astercaeser_refresh_cache() {
    local dir="$(_astercaeser_scripts_dir)"
    _ASTERCAESER_SUBS_CACHE=()
    # Prefer the project venv's Python so deps (bcrypt, sqlalchemy, ...)
    # resolve. Falls back to system `python3` for container installs.
    local py="$dir/../venv/bin/python"
    [ -x "$py" ] || py="$(command -v python3)"
    local f
    for f in "$dir"/astercaeser-*; do
        [ -x "$f" ] || continue
        case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
        local name="$(basename "$f")"
        local sub="${name#astercaeser-}"
        local help_out
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        local commands
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _ASTERCAESER_SUBS_CACHE[$sub]="$commands"
    done
}

_astercaeser_complete() {
    [ ${#_ASTERCAESER_SUBS_CACHE[@]} -eq 0 ] && _astercaeser_refresh_cache

    local cur="${COMP_WORDS[COMP_CWORD]}"
    local cmd="${COMP_WORDS[0]}"

    # `astercaeser <tab>` → list every subcommand
    if [ "$cmd" = "astercaeser" ]; then
        if [ "$COMP_CWORD" -eq 1 ]; then
            local subs="${!_ASTERCAESER_SUBS_CACHE[@]} help"
            COMPREPLY=($(compgen -W "$subs" -- "$cur"))
            return 0
        fi
        # `astercaeser foo <tab>` — complete with foo's own subcommands
        local sub="${COMP_WORDS[1]}"
        # `astercaeser help <tab>` lists every subcommand
        if [ "$sub" = "help" ] && [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${!_ASTERCAESER_SUBS_CACHE[*]}" -- "$cur"))
            return 0
        fi
        if [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${_ASTERCAESER_SUBS_CACHE[$sub]}" -- "$cur"))
            return 0
        fi
        return 0
    fi

    # Direct `astercaeser-foo <tab>` (no umbrella)
    local sub="${cmd#astercaeser-}"
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=($(compgen -W "${_ASTERCAESER_SUBS_CACHE[$sub]}" -- "$cur"))
        return 0
    fi
}

# Register the completion for every astercaeser-* script + the umbrella.
complete -F _astercaeser_complete astercaeser
for f in "$(_astercaeser_scripts_dir)"/astercaeser-*; do
    [ -x "$f" ] || continue
    case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
    complete -F _astercaeser_complete "$(basename "$f")"
done
