# strIDEterm shell integration for PowerShell
# Emits OSC 133 sequences so the terminal can detect command boundaries.
# Sourced automatically when STRIDETERM_SHELL_INTEGRATION=1.

if ($env:__strideterm_integrated -eq '1') { return }
$env:__strideterm_integrated = '1'

# Save original prompt function
$__stridetermOriginalPrompt = $function:prompt

function prompt {
    $exitCode = if ($?) { 0 } else { 1 }
    # D — command finished (carries exit code)
    [Console]::Write("`e]133;D;$exitCode`a")
    # A — prompt start
    [Console]::Write("`e]133;A`a")

    # Call original prompt to get the prompt string
    $result = & $__stridetermOriginalPrompt

    # B — prompt end / command start (after prompt is drawn)
    [Console]::Write("`e]133;B`a")
    return $result
}

# Register preexec via PSReadLine if available
if (Get-Module -Name PSReadLine -ErrorAction SilentlyContinue) {
    $__stridetermExistingHandler = (Get-PSReadLineKeyHandler -Key Enter -ErrorAction SilentlyContinue).Function
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        # C — command executed (user pressed Enter)
        [Console]::Write("`e]133;C`a")
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# Emit initial prompt-start
[Console]::Write("`e]133;A`a")
