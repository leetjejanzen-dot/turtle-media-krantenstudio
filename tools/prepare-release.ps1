param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$resolvedInstaller = (Resolve-Path -LiteralPath $Installer).Path
$hash = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$resolvedInstaller.sha256"
Set-Content -LiteralPath $checksumPath -Value "$hash  $([System.IO.Path]::GetFileName($resolvedInstaller))" -Encoding ascii
Write-Output $checksumPath
