# Interactive keybindings for Windows PowerShell and PowerShell 7.
Import-Module PSReadLine -MinimumVersion 2.0 -ErrorAction SilentlyContinue
if (Get-Module PSReadLine) {
    Set-PSReadLineOption -EditMode Vi -ViModeIndicator Cursor -HistorySaveStyle SaveIncrementally `
        -HistoryNoDuplicates -HistorySearchCursorMovesToEnd -BellStyle None

    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+r -Function ReverseSearchHistory
    Set-PSReadLineKeyHandler -ViMode Insert -Chord UpArrow -Function HistorySearchBackward
    Set-PSReadLineKeyHandler -ViMode Insert -Chord DownArrow -Function HistorySearchForward
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Tab -Function MenuComplete
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Shift+Tab -Function TabCompletePrevious
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+a -Function BeginningOfLine
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+e -Function EndOfLine
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+w -Function BackwardKillWord
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+u -Function BackwardKillLine
    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+l -Function ClearScreen
}

# Terminal may still have the PATH it inherited before WinGet installed zoxide.
$zoxideCommand = Get-Command zoxide.exe -CommandType Application -ErrorAction SilentlyContinue
if (!$zoxideCommand) {
    $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    if (Test-Path -LiteralPath (Join-Path $wingetLinks 'zoxide.exe') -PathType Leaf) {
        $env:PATH += ";$wingetLinks"
        $zoxideCommand = Get-Command zoxide.exe -CommandType Application -ErrorAction SilentlyContinue
    }
}
if ($zoxideCommand) {
    $zoxideInit = & $zoxideCommand.Source init powershell | Out-String
    if ($LASTEXITCODE -eq 0 -and $zoxideInit) { Invoke-Expression $zoxideInit }
}
