# Clipboard
# 
# See: https://github.com/microsoft/WSL/issues/4933#issuecomment-664471199
# Default clipboard using powershell that comes with Windows.

# Create pbcopy as binary
echo '#!/bin/sh' > ./pbcopy 
echo 'clip.exe' >> ./pbcopy

# Create pbpaste as binary
cat << 'EOF' > ./pbpaste
#!/bin/sh
# powershell.exe "(Get-Clipboard).TrimEnd()" | tr -d "\r" | sed '${/^$/d;}'
powershell.exe "(Get-Clipboard).TrimEnd()" | tr -d "\r" | sed -z 's/\n$//'
EOF
# (Get-Clipboard).TrimEnd() : Call `Get-Clipboard` and then remove trailing
# spaces and newlines. However, this command still leaves one newline by default.
# tr -d "\r" : Trim Windows-style `\r` to ensure Unix-style output
# sed '${/^$/d;}' : If the last line is empty, delete it

chmod +x pbcopy pbpaste 
mv pbcopy pbpaste "$DOTFILES/bin/"

# The following aliases were moved to zshrc to be used as executables instead of
# aliases. Search "clipboad" in zshrc.
# alias pbcopy="clip.exe"
# alias pbpaste="powershell.exe -Command 'Get-Clipboard' | head -n -1"

# Testing
# alias pbcopy="powershell.exe -Command \"\$input | Set-Clipboard\""
# alias pbcopy="powershell.exe -NoLogo -NoProfile -Command '[Console]::OpenStandardInput() | Set-Clipboard'"
# alias pbcopy="powershell.exe -Command \"Set-Clipboard -Value \\\$(\\\$input | Out-String)\""

# Replacement using Windows Power Shell v7.4
# https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows?view=powershell-7.4#install-powershell-using-winget-recommended
# Default command powershell that comes with Windows.
# 
# alias pwsh_exe="\"/mnt/c/Program Files/PowerShell/7/pwsh.exe\"" 
# alias pbpaste="pwsh_exe -Command 'Get-Clipboard' | head -n -1"
