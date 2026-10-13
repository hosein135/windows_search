# Install a local Python environment and DuckDB.
# Double-click setup.cmd, or run:  powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-Python {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('py', 'python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and $cmd.Source -notlike '*\WindowsApps\*') {
            $candidates.Add($cmd.Source)
        }
    }
    foreach ($path in @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        'C:\Program Files\Cloudbase Solutions\Cloudbase-Init\Python\python.exe'
    )) {
        $candidates.Add($path)
    }

    foreach ($path in $candidates) {
        if (-not (Test-Path $path)) { continue }
        & $path -c "import sys, tkinter; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { return $path }
    }
    return $null
}

function Install-Python {
    $version = '3.12.10'
    $installer = Join-Path $env:TEMP "python-$version-amd64.exe"
    $url = "https://www.python.org/ftp/python/$version/python-$version-amd64.exe"
    Write-Host "Downloading Python $version..."
    Invoke-WebRequest -Uri $url -OutFile $installer
    Write-Host "Installing Python for the current user..."
    $proc = Start-Process -FilePath $installer -ArgumentList @(
        '/quiet', 'InstallAllUsers=0', 'PrependPath=1',
        'Include_pip=1', 'Include_test=0', 'Include_launcher=1', 'Include_tcltk=1'
    ) -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "Python installer exited with code $($proc.ExitCode)"
    }
    $target = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
    if (-not (Test-Path $target)) {
        throw "Python installed, but python.exe was not found at $target"
    }
    return $target
}

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$venvOk = $false
if (Test-Path $venvPython) {
    & $venvPython -c "import tkinter" 2>$null
    if ($LASTEXITCODE -eq 0) { $venvOk = $true }
}
if (-not $venvOk) {
    if (Test-Path (Join-Path $PSScriptRoot '.venv')) {
        Write-Host 'Recreating the virtual environment so Tkinter is available.'
        Remove-Item -Recurse -Force (Join-Path $PSScriptRoot '.venv')
    }
    $python = Find-Python
    if (-not $python) {
        $python = Install-Python
    }
    Write-Host "Creating virtual environment with $python"
    & $python -m venv (Join-Path $PSScriptRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create .venv' }
}

Write-Host 'Installing DuckDB...'
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

Write-Host ''
Write-Host 'Ready. Start the search window with gui.cmd'
