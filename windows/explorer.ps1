# windows/explorer.ps1

$ErrorActionPreference = "Stop"

Write-Host "Configuring Windows Explorer..."

# Use the classic/full context menu by default.
#   On newer Windows 11 PCs, right clicking a file in the explorer opens requires 
#   selecting "Show more options" to access setting I often need. Ihe code below 
#   gives the classic experience from prior to Windows 11 defaults.
$classicContextMenuKey =
    "HKCU:\Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32"

if (-not (Test-Path $classicContextMenuKey)) {
    New-Item -Path $classicContextMenuKey -Force | Out-Null
}

# The default value must exist and be empty.
Set-Item -Path $classicContextMenuKey -Value ""

Write-Host "Explorer configuration applied."

# Restart Explorer so the setting takes effect immediately.
Stop-Process -Name explorer -Force
