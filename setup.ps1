#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# Bootstrap for the windows-search demo app:
#   winget -> vfox -> Node.js 22.2.0 -> MongoDB 8.0.4 -> npm install
# Both Node.js and MongoDB are installed and pinned via vfox (version-fox).
# plus a host hardware inventory (GPU detection) like the render pipeline uses.

Set-Location $PSScriptRoot
Write-Host "Working directory set to: $PSScriptRoot" -ForegroundColor Cyan

$nodeTargetVersion = "22.2.0"
$mongoTargetVersion = "8.0.4"   # used only as a hint; falls back to latest if unavailable

function Write-Section([string]$Title) {
    Write-Host ""
    Write-Host ("=" * 64) -ForegroundColor DarkCyan
    Write-Host " $Title" -ForegroundColor Cyan
    Write-Host ("=" * 64) -ForegroundColor DarkCyan
}

function Refresh-SessionPath {
    param([string]$WingetPackagesRoot)

    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    if ($WingetPackagesRoot -and (Test-Path $WingetPackagesRoot)) {
        foreach ($exeName in @("vfox.exe")) {
            $exe = Get-ChildItem -Path $WingetPackagesRoot -Recurse -Filter $exeName -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($exe -and ($env:Path -notlike "*$($exe.DirectoryName)*")) {
                $env:Path = "$($exe.DirectoryName);$env:Path"
            }
        }
    }

    # vfox installs SDKs under ~/.vfox/sdks (vfox < 1.0) or ~/.version-fox/sdks (vfox >= 1.0)
    # Add any node.exe / mongod.exe found there to the current session PATH.
    foreach ($sdkRoot in @("$HOME\.vfox\sdks", "$HOME\.version-fox\sdks")) {
        if (-not (Test-Path $sdkRoot)) { continue }
        foreach ($exeName in @("node.exe", "mongod.exe")) {
            $exe = Get-ChildItem -Path $sdkRoot -Recurse -Filter $exeName -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($exe -and ($env:Path -notlike "*$($exe.DirectoryName)*")) {
                $env:Path = "$($exe.DirectoryName);$env:Path"
            }
        }
    }

    $vfoxHome = "$HOME\.vfox"
    if ((Test-Path $vfoxHome) -and ($env:Path -notlike "*$vfoxHome*")) {
        $env:Path = "$vfoxHome;$env:Path"
    }
}

function Add-VfoxSdkToMachinePath {
    param([Parameter(Mandatory = $true)][string]$ExeName)

    # Search both vfox SDK roots (vfox < 1.0 uses ~/.vfox, vfox >= 1.0 uses ~/.version-fox)
    $exe = $null
    foreach ($root in @("$HOME\.vfox\sdks", "$HOME\.version-fox\sdks")) {
        if (Test-Path $root) {
            $exe = Get-ChildItem -Path $root -Recurse -Filter $ExeName -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($exe) { break }
        }
    }
    if (-not $exe) {
        Write-Host "  WARNING: $ExeName not found in vfox SDK directories." -ForegroundColor Yellow
        return $false
    }

    $binDir = $exe.DirectoryName

    # Check if already in Machine PATH (persists for all future terminals)
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -like "*$binDir*") {
        # Already permanent; just make sure current session has it
        if ($env:Path -notlike "*$binDir*") { $env:Path = "$binDir;$env:Path" }
        return $true
    }

    # Add to Machine PATH permanently so new CMD / PowerShell windows find it
    $newMachinePath = "$binDir;$machinePath"
    [System.Environment]::SetEnvironmentVariable("Path", $newMachinePath, "Machine")

    # Update current session immediately
    if ($env:Path -notlike "*$binDir*") {
        $env:Path = "$binDir;$env:Path"
    }

    Write-Host "  Added $binDir to system PATH (permanent)" -ForegroundColor Green
    return $true
}

function Show-HostHardwareInventory {
    Write-Section "Host hardware inventory (Windows)"

    try {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $cpuName = if ($cpu) { $cpu.Name.Trim() } else { "Unknown" }
        $logical = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
        Write-Host "  CPU name : $cpuName" -ForegroundColor White
        Write-Host "  Threads  : $logical" -ForegroundColor Gray
    } catch {
        Write-Host "  CPU query failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  Display adapters:" -ForegroundColor White
    $adapters = @()
    try {
        $adapters = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name })
    } catch {
        Write-Host "  Adapter query failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    if (-not $adapters -or $adapters.Count -eq 0) {
        Write-Host "  (none reported by Win32_VideoController)" -ForegroundColor Yellow
    } else {
        foreach ($gpu in $adapters) {
            $name = $gpu.Name
            $kind = "Other GPU"; $color = "Gray"
            if ($name -match '(?i)nvidia|geforce|quadro|rtx |gtx ') {
                $kind = "External / discrete NVIDIA GPU"; $color = "Green"
            } elseif ($name -match '(?i)intel') {
                $kind = "Internal Intel GPU (iGPU / Arc)"; $color = "Cyan"
            } elseif ($name -match '(?i)amd|radeon') {
                $kind = "AMD GPU"; $color = "Yellow"
            }
            Write-Host "   - [$kind] $name" -ForegroundColor $color
        }
    }

    Write-Host ""
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        Write-Host "  nvidia-smi:" -ForegroundColor White
        & nvidia-smi -L 2>$null
    } else {
        Write-Host "  nvidia-smi: not on PATH - CUDA path unavailable; app will use WebGPU (any vendor) or CPU" -ForegroundColor Yellow
    }
}

function Show-PipelineInvolvement {
    Write-Section "Pipeline involvement (NVIDIA / Intel GPU / CPU)"
    Write-Host "  What this app uses each device for, and why idle devices are skipped." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  NVIDIA / AMD / Intel GPU  : ranks + highlights search results in the GUI via WebGPU" -ForegroundColor Green
    Write-Host "                              compute shaders (WGSL); optional GPU text normalization on import." -ForegroundColor DarkGray
    Write-Host "  CPU                       : orchestration, CSV streaming/parse, MongoDB bulk writes," -ForegroundColor Cyan
    Write-Host "                              and the fallback ranker when WebGPU is unavailable." -ForegroundColor DarkGray
    Write-Host "  MongoDB (mongod)          : storage + indexed candidate selection; one document per person." -ForegroundColor White
}

function Ensure-WingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$CommandName,
        [string]$Version,
        [Parameter(Mandatory = $true)][string]$WingetPackagesRoot
    )

    Refresh-SessionPath -WingetPackagesRoot $WingetPackagesRoot

    if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
        Write-Host "$Name is already installed; skipping download." -ForegroundColor Green
        return
    }

    if ($Version) {
        Write-Host "$Name not found. Installing version $Version via winget ($Id)..." -ForegroundColor Yellow
        winget install --id $Id --version $Version --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Host "$Name $Version unavailable; trying latest $Id..." -ForegroundColor Yellow
            winget install --id $Id --accept-source-agreements --accept-package-agreements
        }
    } else {
        Write-Host "$Name not found. Installing latest via winget ($Id)..." -ForegroundColor Yellow
        winget install --id $Id --accept-source-agreements --accept-package-agreements
    }

    Refresh-SessionPath -WingetPackagesRoot $WingetPackagesRoot

    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "$Name installed but '$CommandName' is not on PATH. Open a new admin PowerShell and re-run."
    }
    Write-Host "$Name is ready." -ForegroundColor Green
}

## 1. INSTALL WINGET (if not already available)
Write-Section "Bootstrap: WinGet"
if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "WinGet not found. Installing WinGet and App Installer dependencies..." -ForegroundColor Yellow

    $progressPreference = 'silentlyContinue'
    $installUrl = "https://aka.ms/getwinget"
    $installerPath = "$env:TEMP\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"

    Invoke-WebRequest -Uri $installUrl -OutFile $installerPath
    Add-AppxPackage -Path $installerPath
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue

    Write-Host "WinGet installed successfully." -ForegroundColor Green
} else {
    Write-Host "WinGet is already installed." -ForegroundColor Green
}

## 2. REFRESH PATH SO WINGET IS USABLE IN CURRENT SESSION
$wingetPackagesRoot = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
Refresh-SessionPath -WingetPackagesRoot $wingetPackagesRoot

## 3. INSTALL VFOX (VERSION FOX) WITH EXACT PACKAGE ID
Write-Section "Bootstrap: vfox"
$vfoxVersion = "0.6.2"
$vfoxPackageId = "version-fox.vfox"

if (!(Get-Command vfox -ErrorAction SilentlyContinue)) {
    Write-Host "Installing vfox version $vfoxVersion via winget..." -ForegroundColor Yellow
    winget install --id $vfoxPackageId --version $vfoxVersion --exact --accept-source-agreements --accept-package-agreements
} else {
    Write-Host "vfox is already installed." -ForegroundColor Green
}

## 4. DYNAMICALLY RESOLVE AND APPEND VFOX PATH TO CURRENT SESSION
Refresh-SessionPath -WingetPackagesRoot $wingetPackagesRoot

$fallbackPaths = @(
    "$env:LOCALAPPDATA\vfox",
    "$HOME\AppData\Local\vfox",
    "$env:ProgramFiles\vfox"
)
foreach ($p in $fallbackPaths) {
    if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
        $env:Path = "$p;$env:Path"
    }
}

if (Get-Command vfox -ErrorAction SilentlyContinue) {
    Write-Host "vfox successfully located. Activating session environment..." -ForegroundColor Green
    Invoke-Expression "$(vfox activate pwsh)"
} else {
    throw "vfox executable could not be resolved. Please verify package availability."
}

## 5. INSTALL AND APPLY NODE.JS $nodeTargetVersion LOCALLY & GLOBALLY
Write-Host "Adding Node.js plugin to vfox..." -ForegroundColor Yellow
vfox add nodejs

Write-Host "Installing Node.js version $nodeTargetVersion..." -ForegroundColor Yellow
vfox install "nodejs@$nodeTargetVersion"

Write-Host "Activating Node.js $nodeTargetVersion globally and for the current session..." -ForegroundColor Yellow
vfox use -g "nodejs@$nodeTargetVersion"
vfox use -p "nodejs@$nodeTargetVersion"

# Ensure node and npm are permanently on the system PATH for all future terminals
Add-VfoxSdkToMachinePath -ExeName "node.exe"

## 6. INSTALL AND APPLY MONGODB $mongoTargetVersion LOCALLY & GLOBALLY (via vfox)
Write-Section "Bootstrap: MongoDB (vfox)"
Write-Host "Adding mongod plugin to vfox..." -ForegroundColor Yellow
vfox add mongod

Write-Host "Installing MongoDB version $mongoTargetVersion..." -ForegroundColor Yellow
vfox install "mongod@$mongoTargetVersion" -y

Write-Host "Activating MongoDB $mongoTargetVersion globally and for the current session..." -ForegroundColor Yellow
vfox use -g "mongod@$mongoTargetVersion"
vfox use -p "mongod@$mongoTargetVersion"

# Ensure mongod is permanently on the system PATH for all future terminals
Add-VfoxSdkToMachinePath -ExeName "mongod.exe"

# vfox installs are per-user (not a Windows service), so we start mongod
# manually as a background process on the default port 27017.
$mongoDataDir = Join-Path $PSScriptRoot "data\db"
New-Item -ItemType Directory -Force -Path $mongoDataDir | Out-Null

Refresh-SessionPath -WingetPackagesRoot $wingetPackagesRoot
if (Get-Command vfox -ErrorAction SilentlyContinue) {
    Invoke-Expression "$(vfox activate pwsh)"
}

if (Get-Command mongod -ErrorAction SilentlyContinue) {
    # Start mongod if port 27017 is not already listening
    $listener = Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        Write-Host "Starting mongod on port 27017 (dbpath: $mongoDataDir)..." -ForegroundColor Yellow
        Start-Process -FilePath "mongod" -ArgumentList "--dbpath", $mongoDataDir, "--port", "27017", "--bind_ip", "127.0.0.1" -WindowStyle Hidden
        Start-Sleep -Seconds 4
    }
    $listener = Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "MongoDB is listening on port 27017." -ForegroundColor Green
    } else {
        Write-Host "MongoDB may still be starting; check with: mongod --dbpath data\db" -ForegroundColor Yellow
    }
} else {
    Write-Host "mongod not found on PATH after vfox install. Open a new admin PowerShell and re-run." -ForegroundColor Yellow
}

## 7. FINAL PATH & ENVIRONMENT REFRESH FOR NODE / NPM
Refresh-SessionPath -WingetPackagesRoot $wingetPackagesRoot
if (Get-Command vfox -ErrorAction SilentlyContinue) {
    Invoke-Expression "$(vfox activate pwsh)"
}

Write-Host "Verifying versions..." -ForegroundColor Cyan
node -v
npm -v
if (Get-Command mongod -ErrorAction SilentlyContinue) { mongod --version | Select-Object -First 1 }

## 8. HARDWARE INVENTORY + INVOLVEMENT
Show-HostHardwareInventory
Show-PipelineInvolvement

## 9. RUN NPM INSTALL IN THE SCRIPT'S DIRECTORY
Write-Section "Bootstrap: npm install"
if (Test-Path "package.json") {
    Write-Host "Found package.json. Running 'npm install'..." -ForegroundColor Yellow
    npm install
    Write-Host "npm install completed successfully!" -ForegroundColor Green
} else {
    Write-Host "No package.json found in $PSScriptRoot. Skipping 'npm install'." -ForegroundColor Yellow
}

Write-Section "Done"
Write-Host "==> Next steps:" -ForegroundColor Green
Write-Host "  1. Drop the CSV dump folders into .\databases\   (bank mellat, bank melli, ...)" -ForegroundColor White
Write-Host "  2. Optional demo data:  npm run make-sample" -ForegroundColor White
Write-Host "  3. Headless import:     npm run import" -ForegroundColor White
Write-Host "  4. Start the GUI:       npm start" -ForegroundColor White
