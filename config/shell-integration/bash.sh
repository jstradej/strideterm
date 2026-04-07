# strIDEterm shell integration for Bash
# Emits OSC 133 sequences so the terminal can detect command boundaries.
# Sourced automatically when STRIDETERM_SHELL_INTEGRATION=1.

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

# Install hooks via PROMPT_COMMAND (precmd equivalent in Bash)
if [[ -z "$__strideterm_prompt_installed" ]]; then
  __strideterm_prompt_installed=1

  # Wrap existing PROMPT_COMMAND so we don't clobber it
  if [[ -n "$PROMPT_COMMAND" ]]; then
    __strideterm_original_prompt_command="$PROMPT_COMMAND"
    PROMPT_COMMAND='__strideterm_precmd; eval "$__strideterm_original_prompt_command"'
  else
    PROMPT_COMMAND='__strideterm_precmd'
  fi

  # Bash 5.1+ supports PS0 for preexec-like behavior
  if [[ "${BASH_VERSINFO[0]}" -ge 5 ]] && [[ "${BASH_VERSINFO[1]}" -ge 1 || "${BASH_VERSINFO[0]}" -ge 6 ]]; then
    PS0='$(__strideterm_preexec)\'"${PS0:-}"
  fi

  # Emit initial prompt-start on first load
  printf '\e]133;A\a'
fi
