# Interactive keybindings for Windows PowerShell and PowerShell 7.
Import-Module PSReadLine -MinimumVersion 2.0 -ErrorAction SilentlyContinue
if (Get-Module PSReadLine) {
    Set-PSReadLineOption -EditMode Windows -HistorySaveStyle SaveIncrementally `
        -HistoryNoDuplicates -HistorySearchCursorMovesToEnd -BellStyle None

    Set-PSReadLineKeyHandler -Chord Ctrl+r -Function ReverseSearchHistory
    Set-PSReadLineKeyHandler -Chord UpArrow -Function HistorySearchBackward
    Set-PSReadLineKeyHandler -Chord DownArrow -Function HistorySearchForward
    Set-PSReadLineKeyHandler -Chord Tab -Function MenuComplete
    Set-PSReadLineKeyHandler -Chord Shift+Tab -Function TabCompletePrevious
    Set-PSReadLineKeyHandler -Chord Ctrl+a -Function BeginningOfLine
    Set-PSReadLineKeyHandler -Chord Ctrl+e -Function EndOfLine
    Set-PSReadLineKeyHandler -Chord Ctrl+w -Function BackwardKillWord
    Set-PSReadLineKeyHandler -Chord Ctrl+u -Function BackwardKillLine
    Set-PSReadLineKeyHandler -Chord Ctrl+l -Function ClearScreen
}
