#compdef astercaeser astercaeser-backup astercaeser-calendar astercaeser-contacts astercaeser-cookbook astercaeser-docs astercaeser-gallery astercaeser-mail astercaeser-mcp astercaeser-memory astercaeser-notes astercaeser-personal astercaeser-preset astercaeser-research astercaeser-sessions astercaeser-signature astercaeser-skills astercaeser-tasks astercaeser-theme astercaeser-webhook
# Zsh tab-completion for the astercaeser umbrella + sub-CLIs.
#
# Drop in any directory on $fpath, e.g.:
#     fpath=(/path/to/astercaeser-ui/scripts/_completion $fpath)
#     autoload -U compinit; compinit
#
# Then `astercaeser <tab>` completes subcommands; `astercaeser mail <tab>`
# completes mail subcommands; `astercaeser-mail <tab>` works the same.

_astercaeser_scripts_dir() {
    local self="${(%):-%x}"
    while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
    cd "${self:h}/.." && pwd
}

typeset -gA _astercaeser_subs

_astercaeser_refresh() {
    _astercaeser_subs=()
    local dir="$(_astercaeser_scripts_dir)"
    local py="$dir/../venv/bin/python"
    [[ -x "$py" ]] || py="$(command -v python3)"
    local f sub help_out commands
    for f in "$dir"/astercaeser-*; do
        [[ -x "$f" ]] || continue
        case "$f" in
            *.bak|*.pyc|*.pre-*) continue ;;
        esac
        sub="${${f:t}#astercaeser-}"
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _astercaeser_subs[$sub]="$commands"
    done
}

_astercaeser() {
    [[ ${#_astercaeser_subs} -eq 0 ]] && _astercaeser_refresh

    local cmd="${words[1]}"

    if [[ "$cmd" == "astercaeser" ]]; then
        if (( CURRENT == 2 )); then
            local -a subs=(${(k)_astercaeser_subs} help)
            _describe 'subcommand' subs
            return
        fi
        local sub="${words[2]}"
        if [[ "$sub" == "help" ]] && (( CURRENT == 3 )); then
            local -a subs=(${(k)_astercaeser_subs})
            _describe 'subcommand' subs
            return
        fi
        if (( CURRENT == 3 )); then
            local -a sc=(${(s/ /)_astercaeser_subs[$sub]})
            _describe 'command' sc
            return
        fi
        return
    fi

    # astercaeser-foo <tab>
    local sub="${cmd#astercaeser-}"
    if (( CURRENT == 2 )); then
        local -a sc=(${(s/ /)_astercaeser_subs[$sub]})
        _describe 'command' sc
        return
    fi
}

_astercaeser "$@"
