<#
.SYNOPSIS
    Aktiviert den OpenSSH Server auf Windows 10/11 fuer den ClaudeMC Remote-Zugriff.

.DESCRIPTION
    Installiert OpenSSH.Server, startet den Dienst (Autostart), legt die Firewall-Regel an
    und hinterlegt optional einen Public-Key fuer passwortlosen Login. Idempotent: kann
    mehrfach ausgefuehrt werden. MUSS in einer PowerShell ALS ADMINISTRATOR laufen.

.PARAMETER PublicKey
    Dein Mac-Public-Key (Inhalt von ~/.ssh/id_ed25519.pub). Wird automatisch am richtigen
    Ort hinterlegt - bei Admin-Usern in administrators_authorized_keys mit korrekten ACLs.

.PARAMETER SetPowerShellDefault
    Setzt die OpenSSH-Default-Shell auf PowerShell statt cmd.exe.

.PARAMETER Port
    SSH-Port (Default 22).

.EXAMPLE
    .\setup-windows-openssh.ps1

.EXAMPLE
    .\setup-windows-openssh.ps1 -PublicKey "ssh-ed25519 AAAA... timon@mac" -SetPowerShellDefault
#>

[CmdletBinding()]
param(
    [string]$PublicKey,
    [switch]$SetPowerShellDefault,
    [int]$Port = 22
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    [--] $msg" -ForegroundColor DarkGray }

# --- Admin-Check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Dieses Script muss ALS ADMINISTRATOR laufen. PowerShell rechts-klicken -> 'Als Administrator ausfuehren'."
    exit 1
}

# --- 1. OpenSSH Server installieren -------------------------------------
Write-Step "OpenSSH Server installieren"
$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($cap.State -eq 'Installed') {
    Write-Skip "OpenSSH.Server bereits installiert"
} else {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    Write-Ok "OpenSSH.Server installiert"
}

# --- 2. Dienst starten + Autostart --------------------------------------
Write-Step "sshd-Dienst starten und auf Autostart setzen"
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') {
    Start-Service sshd
    Write-Ok "sshd gestartet"
} else {
    Write-Skip "sshd laeuft bereits"
}
Write-Ok "Autostart aktiviert"

# --- 3. Firewall-Regel --------------------------------------------------
Write-Step "Firewall-Regel fuer Port $Port"
$ruleName = "ClaudeMC-OpenSSH-$Port"
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Write-Skip "Firewall-Regel '$ruleName' existiert bereits"
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName "OpenSSH Server (sshd) Port $Port" `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort $Port | Out-Null
    Write-Ok "Firewall-Regel '$ruleName' angelegt"
}

# --- 3b. Nicht-Standard-Port in sshd_config -----------------------------
if ($Port -ne 22) {
    Write-Step "Port $Port in sshd_config eintragen"
    $cfg = 'C:\ProgramData\ssh\sshd_config'
    if (Test-Path $cfg) {
        $content = Get-Content $cfg
        if ($content -notmatch "^\s*Port\s+$Port\s*$") {
            Add-Content -Path $cfg -Value "`nPort $Port"
            Restart-Service sshd
            Write-Ok "Port $Port gesetzt, sshd neugestartet"
        } else {
            Write-Skip "Port $Port bereits konfiguriert"
        }
    } else {
        Write-Skip "sshd_config noch nicht vorhanden (erster Start?) - Port manuell pruefen"
    }
}

# --- 4. Public-Key hinterlegen ------------------------------------------
if ($PublicKey) {
    Write-Step "Public-Key fuer passwortlosen Login hinterlegen"
    $PublicKey = $PublicKey.Trim()

    $currentUser = $env:USERNAME
    $isUserAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent() `
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isUserAdmin) {
        # Admin-User: OpenSSH liest NUR administrators_authorized_keys, mit strikten ACLs
        $authFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
        $existing = if (Test-Path $authFile) { Get-Content $authFile -ErrorAction SilentlyContinue } else { @() }
        if ($existing -contains $PublicKey) {
            Write-Skip "Key bereits in administrators_authorized_keys"
        } else {
            Add-Content -Path $authFile -Value $PublicKey
            Write-Ok "Key in administrators_authorized_keys ergaenzt"
        }
        # ACLs MUSS: nur Administrators + SYSTEM, sonst ignoriert sshd die Datei
        icacls $authFile /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
        Write-Ok "ACLs gesetzt (Administrators + SYSTEM)"
    } else {
        # Normaler User: ~/.ssh/authorized_keys
        $sshDir = Join-Path $env:USERPROFILE '.ssh'
        $authFile = Join-Path $sshDir 'authorized_keys'
        if (-not (Test-Path $sshDir)) {
            New-Item -ItemType Directory -Path $sshDir | Out-Null
        }
        $existing = if (Test-Path $authFile) { Get-Content $authFile -ErrorAction SilentlyContinue } else { @() }
        if ($existing -contains $PublicKey) {
            Write-Skip "Key bereits in authorized_keys"
        } else {
            Add-Content -Path $authFile -Value $PublicKey
            Write-Ok "Key in $authFile ergaenzt"
        }
    }
} else {
    Write-Step "Public-Key"
    Write-Skip "Kein -PublicKey uebergeben -> Login nur per Passwort moeglich"
}

# --- 5. Default-Shell optional auf PowerShell ---------------------------
if ($SetPowerShellDefault) {
    Write-Step "Default-Shell auf PowerShell setzen"
    $psPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
        -Value $psPath -PropertyType String -Force | Out-Null
    Write-Ok "Default-Shell = PowerShell"
}

# --- Zusammenfassung ----------------------------------------------------
Write-Step "Fertig"
$ips = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    ).IPAddress -join ', '
Write-Host "    Hostname : $env:COMPUTERNAME"
Write-Host "    User     : $env:USERNAME"
Write-Host "    IP(s)    : $ips"
Write-Host "    Port     : $Port"
Write-Host ""
Write-Host "    Test vom Mac:  ssh $env:USERNAME@<ip> -p $Port" -ForegroundColor Yellow
