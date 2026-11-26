<#
.SYNOPSIS
  Registers the Cast to Sonos Native Messaging host for Firefox on Windows.
  Once installed, Firefox can automatically launch the local Sonos bridge on demand.
#>

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath = (Get-Command node).Source
$WrapperBat = Join-Path $ProjectDir 'bridge\native-host.bat'
$ManifestPath = Join-Path $ProjectDir 'bridge\cast_to_sonos_firefox.json'

# Create .bat wrapper so Firefox can invoke node cleanly on Windows
$batContent = "@echo off`r`n`"$NodePath`" `"$ProjectDir\bridge\native-host.js`""
Set-Content -Path $WrapperBat -Value $batContent -Encoding ASCII

# Write Firefox Native Messaging host manifest
$manifest = @{
  name = 'cast_to_sonos_firefox'
  description = 'Auto-launch helper for Cast to Sonos for Firefox local audio bridge'
  path = $WrapperBat
  type = 'stdio'
  allowed_extensions = @('cast-to-sonos@firefox.local')
} | ConvertTo-Json -Depth 4

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8

# Register under HKCU (no admin privileges required)
$RegPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\cast_to_sonos_firefox'
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name '(Default)' -Value $ManifestPath

Write-Host "Installed Firefox Native Messaging host successfully!" -ForegroundColor Green
Write-Host "Manifest: $ManifestPath"
Write-Host "Registry: $RegPath"
