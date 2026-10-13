# Python bootstrap, following hosein135/recorder run.ps1:
# refresh Machine+User PATH, install a pinned Python with vfox when none is
# usable, pip-install requirements with that interpreter, then launch.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$pythonTargetVersion = "3.12.8"
$vfoxVersion = "0.6.2"
$vfoxPackageId = "version-fox.vfox"

function Write-Section([string]$Title) {
    Write-Host ""
    Write-Host ("=" * 64) -ForegroundColor DarkCyan
    Write-Host " $Title" -ForegroundColor Cyan
    Write-Host ("=" * 64) -ForegroundColor DarkCyan
}

function Refresh-SessionPath {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    $system32 = Join-Path $env:SystemRoot "System32"
    if ((Test-Path $system32) -and ($env:Path -notlike "*$system32*")) {
        $env:Path = "$system32;$env:Path"
    }

    foreach ($dir in @(
        "$env:LOCALAPPDATA\Microsoft\WindowsApps",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
        "$env:LOCALAPPDATA\vfox",
        "$env:USERPROFILE\.vfox",
        "$env:USERPROFILE\.version-fox"
    )) {
        if ((Test-Path $dir) -and ($env:Path -notlike "*$dir*")) {
            $env:Path = "$dir;$env:Path"
        }
    }

    $wingetPackages = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
    if (Test-Path $wingetPackages) {
        $vfox = Get-ChildItem -Path $wingetPackages -Recurse -Filter "vfox.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($vfox -and ($env:Path -notlike "*$($vfox.DirectoryName)*")) {
            $env:Path = "$($vfox.DirectoryName);$env:Path"
        }
    }

    foreach ($sdkRoot in @("$env:USERPROFILE\.vfox\sdks", "$env:USERPROFILE\.version-fox\sdks")) {
        if (-not (Test-Path $sdkRoot)) { continue }
        $python = Get-ChildItem -Path $sdkRoot -Recurse -Filter "python.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($python -and ($env:Path -notlike "*$($python.DirectoryName)*")) {
            $env:Path = "$($python.DirectoryName);$env:Path"
        }
    }
}

function Add-DirToPath {
    param([Parameter(Mandatory = $true)][string]$BinDir)
    if (-not (Test-Path $BinDir)) { return }
    foreach ($scope in @("Machine", "User")) {
        try {
            $current = [System.Environment]::GetEnvironmentVariable("Path", $scope)
            if ($current -and ($current -like "*$BinDir*")) { break }
            $joined = if ($current) { "$BinDir;$current" } else { $BinDir }
            [System.Environment]::SetEnvironmentVariable("Path", $joined, $scope)
            break
        } catch {
            continue
        }
    }
    if ($env:Path -notlike "*$BinDir*") { $env:Path = "$BinDir;$env:Path" }
}

function Test-UsableExe {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    try { return ((Get-Item -LiteralPath $Path).Length -gt 0) } catch { return $false }
}

function Find-WingetExe {
    $cmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($cmd -and (Test-UsableExe $cmd.Source)) { return $cmd.Source }

    foreach ($candidate in @(
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\winget.exe",
        "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"
    )) {
        if (Test-UsableExe $candidate) { return $candidate }
    }

    $pkg = Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($pkg -and $pkg.InstallLocation) {
        $pkgExe = Join-Path $pkg.InstallLocation "winget.exe"
        if (Test-UsableExe $pkgExe) { return $pkgExe }
    }
    return $null
}

function Download-File {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path $curl) {
        & $curl -L -# -o $Destination $Url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $Destination)) { return $true }
    }
    Invoke-WebRequest -Uri $Url -OutFile $Destination
    return (Test-Path $Destination)
}

function Ensure-Winget {
    Refresh-SessionPath
    $exe = Find-WingetExe
    if ($exe) {
        Write-Host "WinGet is already installed." -ForegroundColor Green
        Add-DirToPath -BinDir (Split-Path $exe -Parent)
        Refresh-SessionPath
        return
    }

    Write-Host "WinGet not found. Installing App Installer..." -ForegroundColor Yellow
    $installerPath = Join-Path $env:TEMP "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"
    if (-not ((Test-Path $installerPath) -and ((Get-Item $installerPath).Length -gt 1MB))) {
        if (-not (Download-File -Url "https://aka.ms/getwinget" -Destination $installerPath)) {
            throw "Failed to download WinGet."
        }
    }
    Add-AppxPackage -Path $installerPath
    Refresh-SessionPath
    if (-not (Find-WingetExe)) {
        throw "WinGet installed but winget.exe was not found."
    }
}

function Invoke-Vfox {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$VfoxArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exe = "vfox"
    $cmd = Get-Command vfox -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $exe = $cmd.Source }
    & $exe @VfoxArgs
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return $code
}

function Install-VfoxPython {
    Write-Section "Bootstrap: vfox + Python"
    Ensure-Winget
    Refresh-SessionPath

    if (-not (Get-Command vfox -ErrorAction SilentlyContinue)) {
        Write-Host "Installing vfox $vfoxVersion..." -ForegroundColor Yellow
        winget install --id $vfoxPackageId --version $vfoxVersion --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "Failed to install vfox $vfoxVersion." }
        Refresh-SessionPath
    } else {
        Write-Host "vfox is already installed." -ForegroundColor Green
    }

    if (Get-Command vfox -ErrorAction SilentlyContinue) {
        Invoke-Expression "$(vfox activate pwsh)"
    } else {
        throw "vfox executable could not be resolved."
    }

    Write-Host "Installing Python $pythonTargetVersion..." -ForegroundColor Yellow
    Invoke-Vfox add python | Out-Null
    $installed = Invoke-Vfox install "python@$pythonTargetVersion"
    if ($installed -ne 0) {
        Write-Host "vfox install python@$pythonTargetVersion exited $installed; continuing if it is already present." -ForegroundColor Yellow
    }
    Invoke-Vfox use -g "python@$pythonTargetVersion" | Out-Null
    Invoke-Vfox use -p "python@$pythonTargetVersion" | Out-Null
    Invoke-Expression "$(vfox activate pwsh)"

    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCmd) { throw "Python executable could not be resolved after vfox install." }
    $binDir = Split-Path $pythonCmd.Source -Parent
    Add-DirToPath -BinDir $binDir
    Refresh-SessionPath
}

function Resolve-PythonExe {
    param([string]$PythonCmd)
    if ($PythonCmd) {
        try {
            $probe = & $PythonCmd -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $probe) {
                $exe = ($probe | Select-Object -Last 1).ToString().Trim()
                if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
            }
        } catch { }
        $cmd = Get-Command $PythonCmd -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    }

    foreach ($candidate in @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    foreach ($sdkRoot in @("$env:USERPROFILE\.vfox\sdks", "$env:USERPROFILE\.version-fox\sdks")) {
        if (-not (Test-Path $sdkRoot)) { continue }
        $python = Get-ChildItem -Path $sdkRoot -Recurse -Filter "python.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($python) { return $python.FullName }
    }
    return $null
}

function Test-TkPython {
    param([string]$PythonExe)
    if (-not (Test-UsableExe $PythonExe)) { return $false }
    & $PythonExe -c "import tkinter" 2>$null
    return ($LASTEXITCODE -eq 0)
}

Refresh-SessionPath
Write-Section "Python"
$pythonExe = Resolve-PythonExe -PythonCmd "python"
if (-not (Test-TkPython $pythonExe)) {
    $pythonExe = Resolve-PythonExe -PythonCmd "python3"
}
if (-not (Test-TkPython $pythonExe)) {
    Install-VfoxPython
    Refresh-SessionPath
    $pythonExe = Resolve-PythonExe -PythonCmd "python"
}
if (-not (Test-TkPython $pythonExe)) {
    throw "Python with Tk was not found. Install failed."
}

Write-Host "Python: $pythonExe" -ForegroundColor Green
& $pythonExe --version

Write-Section "Python packages"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$req = Join-Path $PSScriptRoot "requirements.txt"
& $pythonExe -m pip install --disable-pip-version-check -r $req
if ($LASTEXITCODE -ne 0) { throw "pip install failed." }

$setupOnly = $AppArgs -and $AppArgs.Count -gt 0 -and $AppArgs[0] -eq "setup"
if ($setupOnly) {
    Write-Section "Done"
    Write-Host "Setup finished. Run search.cmd to open the window." -ForegroundColor Green
    exit 0
}

if ($AppArgs -and $AppArgs.Count -gt 0) {
    Write-Section "Search"
    & $pythonExe -m searchapp search @AppArgs
    exit $LASTEXITCODE
}

Write-Section "Launch GUI"
& $pythonExe -m searchapp
if ($LASTEXITCODE -ne 0) { throw "Search window exited with code $LASTEXITCODE." }
