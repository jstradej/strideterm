# strIDEterm shell integration for Zsh
# Emits OSC 133 sequences so the terminal can detect command boundaries.
# Auto-loaded via precmd_functions when STRIDETERM_SHELL_INTEGRATION=1.

if [[ -n "$__strideterm_integrated" ]]; then
  return 0
fi
__strideterm_integrated=1

__strideterm_precmd() {
  local exit_code=$?
  # D — command finished (carries exit code)
  printf '\e]133;D;%s\a' "$exit_code"
  # A — prompt start
  printf '\e]133;A\a'
}

__strideterm_preexec() {
  # C — command executed (user pressed Enter)
  printf '\e]133;C\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __strideterm_precmd
add-zsh-hook preexec __strideterm_preexec

# Emit initial prompt-start on first load
printf '\e]133;A\a'

# Self-cleanup: remove the loader from precmd if it exists
precmd_functions=("${(@)precmd_functions:#__strideterm_loader}")
