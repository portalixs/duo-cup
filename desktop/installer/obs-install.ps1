[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$asset = 'OBS-Studio-33.0.1-Windows-x64-Installer.exe'
$expectedHash = '37ECDE4D9A28E8AEEB07623C8469B5D558EB264E02CCF435BB859891C401758B'
$downloadUrl = "https://github.com/obsproject/obs-studio/releases/download/33.0.1/$asset"
$installer = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString() + '-' + $asset)

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $installer -TimeoutSec 300
    } catch {
        Invoke-WebRequest -UseBasicParsing -Uri "https://cdn-fastly.obsproject.com/downloads/$asset" -OutFile $installer -TimeoutSec 300
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash -ne $expectedHash) {
        throw 'OBS Studio installer checksum does not match the official release.'
    }
    $setup = Start-Process -FilePath $installer -PassThru -Wait
    exit $setup.ExitCode
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
}
