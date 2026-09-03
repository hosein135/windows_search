#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# Bootstrap for the windows-search demo app:
#   winget -> vfox -> Node.js 22.2.0 -> MongoDB 8.0.4 -> Bun -> bun install
# Both Node.js and MongoDB are installed and pinned via vfox (version-fox).
# plus a host hardware inventory (GPU detection) like the render pipeline uses.

Set-Location $PSScriptRoot
Write-Host "Working directory set to: $PSScriptRoot" -ForegroundColor Cyan

$nodeTargetVersion = "22.2.0"
$mongoTargetVersion = "8.0.4"
$bunTargetVersion = "1.1.42"   # faster JS runtime for accelerated imports

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

    # Primary method: after `vfox use -g` + `vfox activate`, the exe is on the
    # session PATH. Use Get-Command to find its real location.
    $cmd = Get-Command $ExeName -ErrorAction SilentlyContinue
    $binDir = $null

    if ($cmd -and $cmd.Source) {
        $binDir = Split-Path $cmd.Source -Parent
    }

    # Fallback: search both vfox SDK roots (vfox < 1.0 uses ~/.vfox, vfox >= 1.0 uses ~/.version-fox)
    if (-not $binDir) {
        foreach ($root in @("$HOME\.vfox\sdks", "$HOME\.version-fox\sdks")) {
            if (Test-Path $root) {
                $exe = Get-ChildItem -Path $root -Recurse -Filter $ExeName -ErrorAction SilentlyContinue |
                    Select-Object -First 1
                if ($exe) { $binDir = $exe.DirectoryName; break }
            }
        }
    }

    if (-not $binDir) {
        Write-Host "  WARNING: $ExeName not found on PATH or in vfox SDK directories." -ForegroundColor Yellow
        return $false
    }

    # Check if already in Machine PATH (persists for all future terminals)
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -like "*$binDir*") {
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

function Invoke-Vfox {
    <# Wrapper that relaxes $ErrorActionPreference around vfox calls so stderr
       progress output doesn't throw under 'Stop'. Returns $LASTEXITCODE.
       NOTE: no 2>&1 redirect — stderr goes straight to the console. #>
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$VfoxArgs)
    $prevEAP = $ErrorActionPreference
    $prevNative = $null
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
        $prevNative = $PSNativeCommandUseErrorActionPreference
        $PSNativeCommandUseErrorActionPreference = $false
    }
    $ErrorActionPreference = 'Continue'
    # Do NOT use 2>&1 here — it makes PowerShell treat vfox's stderr progress
    # bar as error records. Let stderr flow to the console directly.
    $exe = (Get-Command vfox -ErrorAction SilentlyContinue).Source
    if (-not $exe) { $exe = 'vfox' }
    & $exe @VfoxArgs
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($null -ne $prevNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
    return $code
}

function Install-VfoxSdk {
    param(
        [Parameter(Mandatory = $true)][string]$Plugin,
        [Parameter(Mandatory = $true)][string]$Version
    )
    # vfox install returns non-zero when the version is already installed;
    # treat that as success, not failure.
    Write-Host "  Downloading and installing $Plugin@$Version via vfox..." -ForegroundColor Cyan
    Write-Host "  (vfox shows its own progress bar)" -ForegroundColor DarkGray
    $exitCode = Invoke-Vfox install "${Plugin}@${Version}"

    if ($exitCode -ne 0) {
        # Check if it's already installed (not a real failure)
        $list = Invoke-Vfox list $Plugin
        if ($list -match [regex]::Escape($Version)) {
            Write-Host "  $Plugin@$Version is already installed." -ForegroundColor Green
            return $true
        }
        Write-Host "  vfox install $Plugin@$Version failed (exit $exitCode)." -ForegroundColor Yellow
        return $false
    }
    Write-Host "  $Plugin@$Version installed." -ForegroundColor Green
    return $true
}

function Download-File {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$Label = "Downloading"
    )
    Write-Host "  $Label" -ForegroundColor Cyan
    Write-Host "  URL: $Url" -ForegroundColor DarkGray

    # Prefer curl.exe (Windows 10+) — shows a clean progress bar with speed
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & curl.exe -L -# -o "$Destination" "$Url"
        $curlExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($curlExit -eq 0 -and (Test-Path $Destination)) {
            $sizeMB = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
            Write-Host "  Done ($sizeMB MB)" -ForegroundColor Green
            return $true
        }
    }

    # Fallback: Invoke-WebRequest with PowerShell progress bar
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'Continue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination
        $sizeMB = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
        Write-Host "  Done ($sizeMB MB)" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    } finally {
        $ProgressPreference = $prevProgress
    }
}

# Shared with Show-PipelineInvolvement so the plan is computed from what was
# actually detected (runtime detection - nothing about the machine is hardcoded).
$script:HostInventory = @{
    CpuName = "Unknown"; CpuVendor = "Unknown"; CpuClass = "Other"
    Cores = 0; Threads = 1; MemoryGB = 0
    Adapters = @(); HardwareGpuCount = 0; Luids = @(); NvidiaSmi = $false
}

function Get-AdapterLuids {
    <# DXGI adapter LUIDs from the "GPU Adapter Memory" performance counters.
       Instance names look like: luid_0x00000000_0x0000D3E9_phys_0
       The app pins one hidden helper Electron process per extra adapter with
       --use-adapter-luid=<high>,<low>, so this is what makes multi-GPU possible. #>
    $luids = @()
    try {
        $counter = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop
        foreach ($s in $counter.CounterSamples) {
            if ($s.InstanceName -match 'luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})') {
                $hex = "0x$($Matches[1])_0x$($Matches[2])".ToUpper().Replace("0X", "0x")
                if ($luids -notcontains $hex) { $luids += $hex }
            }
        }
    } catch {
        # Perf counters missing (Server Core / stripped VMs): helpers run unpinned.
    }
    return $luids
}

function Show-HostHardwareInventory {
    Write-Section "Host hardware inventory (Windows)"

    try {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $cs = Get-CimInstance Win32_ComputerSystem
        $cpuName = if ($cpu) { $cpu.Name.Trim() } else { "Unknown" }
        $cpuVendor = if ($cpu) { $cpu.Manufacturer } else { "Unknown" }
        $cores = 0
        foreach ($p in @(Get-CimInstance Win32_Processor)) { $cores += [int]$p.NumberOfCores }
        $logical = [int]$cs.NumberOfLogicalProcessors
        if ($logical -lt 1) { $logical = [Environment]::ProcessorCount }
        $memGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)

        $cpuClass = "Other"
        $classColor = "Yellow"
        if ($cpuName -match '(?i)intel' -or $cpuVendor -match '(?i)intel') { $cpuClass = "Intel"; $classColor = "Green" }
        elseif ($cpuName -match '(?i)amd|ryzen|epyc' -or $cpuVendor -match '(?i)amd') { $cpuClass = "AMD"; $classColor = "Green" }
        elseif ($cpuName -match '(?i)arm|snapdragon|qualcomm') { $cpuClass = "ARM"; $classColor = "Cyan" }

        $script:HostInventory.CpuName = $cpuName
        $script:HostInventory.CpuVendor = $cpuVendor
        $script:HostInventory.CpuClass = $cpuClass
        $script:HostInventory.Cores = $cores
        $script:HostInventory.Threads = $logical
        $script:HostInventory.MemoryGB = $memGB

        Write-Host "  CPU name   : $cpuName" -ForegroundColor White
        Write-Host "  CPU vendor : $cpuVendor" -ForegroundColor Gray
        Write-Host "  Cores      : $cores physical / $logical logical threads" -ForegroundColor Gray
        Write-Host "  RAM        : ~$memGB GB" -ForegroundColor Gray
        Write-Host "  Class      : $cpuClass CPU - every logical thread becomes one import worker" -ForegroundColor $classColor
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

    $hwCount = 0
    if (-not $adapters -or $adapters.Count -eq 0) {
        Write-Host "  (none reported by Win32_VideoController)" -ForegroundColor Yellow
    } else {
        foreach ($gpu in $adapters) {
            $name = $gpu.Name
            $ramMB = if ($gpu.AdapterRAM -and $gpu.AdapterRAM -gt 0) { [math]::Round($gpu.AdapterRAM / 1MB) } else { $null }
            $kind = "Other GPU"; $color = "Gray"; $isHardware = $true
            if ($name -match '(?i)nvidia|geforce|quadro|rtx |gtx ') {
                $kind = "External / discrete NVIDIA GPU"; $color = "Green"
            } elseif ($name -match '(?i)intel') {
                $kind = "Internal Intel GPU (iGPU / Arc)"; $color = "Cyan"
            } elseif ($name -match '(?i)amd|radeon') {
                $kind = "AMD GPU"; $color = "Yellow"
            } elseif ($name -match '(?i)basic display|basic render|remote display|virtual|vmware|virtualbox|hyper-v|qxl|parallels') {
                $kind = "Basic / virtual display adapter (no WebGPU)"; $color = "DarkGray"; $isHardware = $false
            }
            if ($isHardware) { $hwCount++ }
            $ramText = if ($null -ne $ramMB) { " | reported VRAM ~${ramMB} MB" } else { "" }
            $drvText = if ($gpu.DriverVersion) { " | driver $($gpu.DriverVersion)" } else { "" }
            Write-Host "   - [$kind] $name$ramText$drvText" -ForegroundColor $color
        }
    }
    $script:HostInventory.Adapters = $adapters
    $script:HostInventory.HardwareGpuCount = $hwCount

    $luids = @(Get-AdapterLuids)
    $script:HostInventory.Luids = $luids
    if ($luids.Count -gt 0) {
        Write-Host "  DXGI adapter LUIDs : $($luids -join ', ')  (helpers pin to these)" -ForegroundColor Gray
    } else {
        Write-Host "  DXGI adapter LUIDs : unavailable (GPU perf counters missing) - extra GPUs get an unpinned helper" -ForegroundColor Yellow
    }

    Write-Host ""
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        Write-Host "  nvidia-smi:" -ForegroundColor White
        & nvidia-smi -L 2>$null
        if ($LASTEXITCODE -eq 0) { $script:HostInventory.NvidiaSmi = $true }
        else { Write-Host "  nvidia-smi present but -L failed (driver issue?)" -ForegroundColor Yellow }
    } else {
        Write-Host "  nvidia-smi: not on PATH - no CUDA; the app uses WebGPU (any vendor) and falls back to the CPU pool" -ForegroundColor Yellow
    }
}

function Show-PipelineInvolvement {
    Write-Section "Pipeline involvement (NVIDIA / Intel GPU / CPU)"
    Write-Host "  What this run will use, computed from the inventory above, and why unused devices are skipped." -ForegroundColor DarkGray
    Write-Host "  (The GUI Hardware tab -> Compute plan shows the live version of this after WebGPU handshakes.)" -ForegroundColor DarkGray
    Write-Host ""

    $threads = [int]$script:HostInventory.Threads
    if ($threads -lt 1) { $threads = 1 }
    $hwGpus = [int]$script:HostInventory.HardwareGpuCount
    $luidCount = @($script:HostInventory.Luids).Count
    # A basic/virtual display adapter has a LUID too, so LUIDs only count once
    # at least one real adapter exists.
    $gpuProcesses = 0
    if ($hwGpus -gt 0) { $gpuProcesses = [math]::Max($hwGpus, $luidCount) }

    $adapters = @($script:HostInventory.Adapters)
    $nvidia = @($adapters | Where-Object { $_.Name -match '(?i)nvidia|geforce|quadro|rtx |gtx ' })
    $intel  = @($adapters | Where-Object { $_.Name -match '(?i)intel' })
    $amd    = @($adapters | Where-Object { $_.Name -match '(?i)amd|radeon' })

    Write-Host "  GPU processes:" -ForegroundColor White
    if ($gpuProcesses -eq 0) {
        Write-Host "   - none: no hardware adapter -> WebGPU unavailable; the CPU worker pool ranks and the CPU folds text" -ForegroundColor Yellow
        Write-Host "     (a software adapter such as SwiftShader/WARP is detected but skipped: slower than JS; --gpu-allow-software forces it)" -ForegroundColor DarkGray
    } else {
        Write-Host "   - main window  : --force-high-performance-gpu -> Chromium binds it to the fastest adapter" -ForegroundColor Green
        if ($nvidia.Count -gt 0) {
            Write-Host "                    expected: $($nvidia[0].Name) (discrete NVIDIA, weight 4)" -ForegroundColor Green
        } elseif ($amd.Count -gt 0) {
            Write-Host "                    expected: $($amd[0].Name)" -ForegroundColor Yellow
        } elseif ($intel.Count -gt 0) {
            Write-Host "                    expected: $($intel[0].Name)" -ForegroundColor Cyan
        }
        if ($gpuProcesses -ge 2) {
            $extra = $gpuProcesses - 1
            if ($luidCount -ge 2) {
                Write-Host "   - $extra helper(s)  : hidden Electron process per remaining DXGI LUID (--use-adapter-luid); the one that" -ForegroundColor Cyan
                Write-Host "                    lands on the main window's adapter is detected by the WebGPU handshake and shut down" -ForegroundColor DarkGray
            } else {
                Write-Host "   - 1 helper     : $hwGpus adapters but no LUIDs -> one unpinned helper, kept only if Chromium gives it a different GPU" -ForegroundColor Cyan
            }
            if ($intel.Count -gt 0 -and $nvidia.Count -gt 0) {
                Write-Host "                    expected: $($intel[0].Name) (integrated Intel, weight 1) alongside the NVIDIA main window" -ForegroundColor Cyan
            }
            Write-Host "   - sharding     : search ranking + import text folding split across all GPU processes by weight," -ForegroundColor White
            Write-Host "                    re-tuned from measured throughput so the iGPU never stalls the dGPU" -ForegroundColor DarkGray
        } else {
            Write-Host "   - helpers      : none - a single GPU adapter; nothing to pin a second process to" -ForegroundColor DarkGray
        }
        Write-Host "   - every GPU process runs the same WGSL kernels and self-tests them against the JS reference at start;" -ForegroundColor DarkGray
        Write-Host "     a device that fails validation or returns wrong results is retired and the CPU pool takes its shard" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "  CPU ($($script:HostInventory.CpuClass), $threads logical threads):" -ForegroundColor White
    Write-Host "   - import       : $threads worker threads (one per logical CPU); every CSV is split into byte-range chunks so" -ForegroundColor Cyan
    Write-Host "                    even one huge file keeps all cores busy; each worker writes to MongoDB with 2 bulkWrites" -ForegroundColor Cyan
    Write-Host "                    in flight ($($threads * 2) concurrent) while it parses the next batch" -ForegroundColor Cyan
    Write-Host "   - search       : $([math]::Max(1, $threads - 1)) rank worker(s) - idle while a GPU ranks, take over instantly on GPU failure" -ForegroundColor Cyan
    Write-Host "   - main thread  : orchestration only (IPC, progress, GPU brokering)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  MongoDB (mongod)  : one document per person; indexes narrow candidates before GPU ranking;" -ForegroundColor White
    Write-Host "                      its own threads absorb the $($threads * 2) concurrent bulk writes." -ForegroundColor DarkGray
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
        Write-Host "  (winget shows its own progress bar)" -ForegroundColor DarkGray
        winget install --id $Id --version $Version --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Host "$Name $Version unavailable; trying latest $Id..." -ForegroundColor Yellow
            winget install --id $Id --accept-source-agreements --accept-package-agreements
        }
    } else {
        Write-Host "$Name not found. Installing latest via winget ($Id)..." -ForegroundColor Yellow
        Write-Host "  (winget shows its own progress bar)" -ForegroundColor DarkGray
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

    $installUrl = "https://aka.ms/getwinget"
    $installerPath = "$env:TEMP\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"

    $downloaded = Download-File -Url $installUrl -Destination $installerPath -Label "Downloading WinGet (App Installer)"
    if (-not $downloaded) { throw "Failed to download WinGet." }

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
    Write-Host "  (winget shows its own progress bar)" -ForegroundColor DarkGray
    winget install --id $vfoxPackageId --version $vfoxVersion --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Failed to install vfox $vfoxVersion." }
    Write-Host "vfox $vfoxVersion installed." -ForegroundColor Green
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
Invoke-Vfox add nodejs | Out-Null

Write-Host "Installing Node.js version $nodeTargetVersion..." -ForegroundColor Yellow
Install-VfoxSdk -Plugin "nodejs" -Version $nodeTargetVersion | Out-Null

Write-Host "Activating Node.js $nodeTargetVersion globally and for the current session..." -ForegroundColor Yellow
Invoke-Vfox use -g "nodejs@$nodeTargetVersion" | Out-Null
Invoke-Vfox use -p "nodejs@$nodeTargetVersion" | Out-Null

# Activate so Get-Command can find node.exe in this session
if (Get-Command vfox -ErrorAction SilentlyContinue) {
    Invoke-Expression "$(vfox activate pwsh)"
}

# Ensure node and npm are permanently on the system PATH for all future terminals
Add-VfoxSdkToMachinePath -ExeName "node.exe"

## 6. INSTALL AND APPLY MONGODB $mongoTargetVersion LOCALLY & GLOBALLY (via vfox)
Write-Section "Bootstrap: MongoDB (vfox)"
Write-Host "Adding mongo plugin to vfox..." -ForegroundColor Yellow
# Uses the 'mongo' plugin (yeshan333/vfox-mongo), NOT 'mongod' (echocat/vfox-mongod).
# The 'mongo' plugin resolves versions via jsdelivr CDN (not GitHub API), so it
# works in regions where GitHub/CloudFront returns 403. It also auto-installs mongosh.
Invoke-Vfox add mongo | Out-Null

Write-Host "Installing MongoDB version $mongoTargetVersion..." -ForegroundColor Yellow
$mongoInstalled = Install-VfoxSdk -Plugin "mongo" -Version $mongoTargetVersion

if ($mongoInstalled) {
    Write-Host "Activating MongoDB $mongoTargetVersion globally and for the current session..." -ForegroundColor Yellow
    Invoke-Vfox use -g "mongo@$mongoTargetVersion" | Out-Null
    Invoke-Vfox use -p "mongo@$mongoTargetVersion" | Out-Null
    if (Get-Command vfox -ErrorAction SilentlyContinue) {
        Invoke-Expression "$(vfox activate pwsh)"
    }
}

# Ensure mongod is permanently on the system PATH for all future terminals
Add-VfoxSdkToMachinePath -ExeName "mongod.exe"

# vfox installs are per-user (not a Windows service), so we start mongod
# manually as a background process on the default port 27017.
# Data is stored in .\mongo\ so the user can see exactly where MongoDB keeps its files.
$mongoDataDir = Join-Path $PSScriptRoot "mongo"
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
        Write-Host "MongoDB may still be starting; check with: mongod --dbpath mongo" -ForegroundColor Yellow
    }
} else {
    Write-Host "mongod not found on PATH after vfox install. Open a new admin PowerShell and re-run." -ForegroundColor Yellow
}

## 7. INSTALL BUN (optional faster runtime for accelerated imports)
Write-Section "Bootstrap: Bun (optional, faster imports)"
Write-Host "Adding bun plugin to vfox..." -ForegroundColor Yellow
Invoke-Vfox add bun | Out-Null

Write-Host "Installing Bun version $bunTargetVersion..." -ForegroundColor Yellow
$bunInstalled = Install-VfoxSdk -Plugin "bun" -Version $bunTargetVersion

if ($bunInstalled) {
    Write-Host "Activating Bun $bunTargetVersion globally..." -ForegroundColor Yellow
    Invoke-Vfox use -g "bun@$bunTargetVersion" | Out-Null
    Invoke-Vfox use -p "bun@$bunTargetVersion" | Out-Null
    if (Get-Command vfox -ErrorAction SilentlyContinue) {
        Invoke-Expression "$(vfox activate pwsh)"
    }
    Add-VfoxSdkToMachinePath -ExeName "bun.exe"
} else {
    Write-Host "Bun install failed (CLI scripts expect bun; Node.js is still used by Electron)." -ForegroundColor Yellow
}

## 8. FINAL PATH & ENVIRONMENT REFRESH FOR NODE / NPM / BUN
Refresh-SessionPath -WingetPackagesRoot $wingetPackagesRoot
if (Get-Command vfox -ErrorAction SilentlyContinue) {
    Invoke-Expression "$(vfox activate pwsh)"
}

Write-Host "Verifying versions..." -ForegroundColor Cyan
node -v
npm -v
if (Get-Command mongod -ErrorAction SilentlyContinue) { mongod --version | Select-Object -First 1 }
if (Get-Command bun -ErrorAction SilentlyContinue) { bun --version } else { Write-Host "bun: not installed (optional)" -ForegroundColor DarkGray }

## 9. HARDWARE INVENTORY + INVOLVEMENT
Show-HostHardwareInventory
Show-PipelineInvolvement

## 10. INSTALL DEPENDENCIES (bun install, npm fallback)
Write-Section "Bootstrap: bun install"
if (Test-Path "package.json") {
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Host "Found package.json. Running 'bun install'..." -ForegroundColor Yellow
        bun install
        if ($LASTEXITCODE -eq 0) {
            Write-Host "bun install completed successfully!" -ForegroundColor Green
        } else {
            Write-Host "bun install failed (exit $LASTEXITCODE)." -ForegroundColor Red
        }
    } else {
        Write-Host "bun not on PATH; falling back to 'npm install'..." -ForegroundColor Yellow
        npm install
        if ($LASTEXITCODE -eq 0) {
            Write-Host "npm install completed successfully!" -ForegroundColor Green
        } else {
            Write-Host "npm install failed (exit $LASTEXITCODE)." -ForegroundColor Red
        }
    }
} else {
    Write-Host "No package.json found in $PSScriptRoot. Skipping install." -ForegroundColor Yellow
}

## 11. RUNTIME HARDWARE REPORT FROM THE APP ITSELF (same detection the GUI uses - not hardcoded)
Write-Section "App runtime detection (scripts\hardware-cli.js)"
$hwCli = Join-Path $PSScriptRoot "scripts\hardware-cli.js"
$hwRunner = $null
if (Get-Command bun -ErrorAction SilentlyContinue) { $hwRunner = "bun" }
elseif (Get-Command node -ErrorAction SilentlyContinue) { $hwRunner = "node" }
if ((Test-Path -LiteralPath $hwCli) -and $hwRunner) {
    $prevNative = $null
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
        $prevNative = $PSNativeCommandUseErrorActionPreference
        $PSNativeCommandUseErrorActionPreference = $false
    }
    try {
        & $hwRunner $hwCli
        if ($LASTEXITCODE -ne 0) { Write-Host "  Runtime report failed (exit $LASTEXITCODE)." -ForegroundColor Yellow }
    } catch {
        Write-Host "  Runtime report error: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        if ($null -ne $prevNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
    }
} else {
    Write-Host "  Skipped (bun/node or scripts\hardware-cli.js missing)." -ForegroundColor Yellow
}

Write-Section "Done"
$planThreads = [int]$script:HostInventory.Threads
if ($planThreads -lt 1) { $planThreads = [Environment]::ProcessorCount }
$planGpus = 0
if ([int]$script:HostInventory.HardwareGpuCount -gt 0) {
    $planGpus = [math]::Max([int]$script:HostInventory.HardwareGpuCount, @($script:HostInventory.Luids).Count)
}

Write-Host "==> Recommended commands for THIS machine ($planThreads threads, $planGpus hardware GPU adapter(s)):" -ForegroundColor Green
Write-Host "  1. Drop the CSV dump folders into .\databases\   (bank mellat, bank melli, ...)" -ForegroundColor White
Write-Host "  2. Optional demo data:   bun run make-sample" -ForegroundColor White
Write-Host "  3. All-core import:      bun scripts/import-cli.js --parallel --workers $planThreads --inflight 2" -ForegroundColor White
Write-Host "     (chunked by byte range; add --chunk-mb 64 to tune, --no-split for whole files)" -ForegroundColor DarkGray
Write-Host "  4. Start the GUI:        bun run start" -ForegroundColor White
if ($planGpus -ge 2) {
    Write-Host "     -> main window on the high-performance GPU + $($planGpus - 1) pinned helper process(es) on the other adapter(s);" -ForegroundColor DarkGray
    Write-Host "        the GUI import panel folds text on every GPU and ranks searches on every GPU" -ForegroundColor DarkGray
} elseif ($planGpus -eq 1) {
    Write-Host "     -> single GPU: WebGPU ranking + import folding on it, CPU pool as fallback" -ForegroundColor DarkGray
} else {
    Write-Host "     -> no hardware GPU here: CPU worker pool ranks; import folds on the CPU" -ForegroundColor DarkGray
}
Write-Host "  5. GPU blocklisted / WebGPU missing in the GUI?   bun run start:gpu-unsafe" -ForegroundColor White
Write-Host "  6. Debug on one GPU only:                         bun run start:no-helpers" -ForegroundColor White
Write-Host "  7. Re-print this hardware plan any time:          bun run hardware" -ForegroundColor White
Write-Host ""
Write-Host "Legend:" -ForegroundColor DarkGray
Write-Host "  NVIDIA / AMD dGPU = discrete GPU: main window's WebGPU device (--force-high-performance-gpu), weight 4 in sharding" -ForegroundColor DarkGray
Write-Host "  Intel GPU         = internal iGPU / Arc: gets its own helper process pinned by DXGI LUID, weight 1 (re-tuned live)" -ForegroundColor DarkGray
Write-Host "  Software adapter  = SwiftShader / WARP: detected, skipped by default (slower than JS); --gpu-allow-software forces it" -ForegroundColor DarkGray
Write-Host "  CPU               = always involved: orchestration, all-core chunked CSV import, MongoDB writes, rank fallback pool" -ForegroundColor DarkGray
Write-Host "  MongoDB           = storage + indexed candidate selection (mongod on 127.0.0.1:27017)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "MongoDB data files are stored in .\mongo\" -ForegroundColor DarkGray
