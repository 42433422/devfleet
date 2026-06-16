# DevFleet Computer Use: open Trae workspace, trigger New Task, paste prompt.
# Requires an interactive Windows user session (UI Automation / SendKeys).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [Parameter(Mandatory = $false)]
    [string]$PromptPath,

    [Parameter(Mandatory = $false)]
    [string]$Prompt,

    [Parameter(Mandatory = $false)]
    [string]$TraeExe
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DevFleetWin32 {
    public const int SW_RESTORE = 9;
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$NewTaskButtonNames = @('新任务', 'New Task', '新建任务', 'Create Task')
$NewTaskShortcuts = @('^+n', '^%n', '^+t')

function Write-DevFleetError {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Get-PromptText {
    if ($PromptPath) {
        if (-not (Test-Path -LiteralPath $PromptPath)) {
            Write-DevFleetError "Prompt file not found: $PromptPath"
        }
        return [System.IO.File]::ReadAllText($PromptPath)
    }
    if ($null -ne $Prompt) {
        return $Prompt
    }
    Write-DevFleetError 'Either -PromptPath or -Prompt is required.'
}

function Find-TraeExecutable {
    if ($TraeExe -and (Test-Path -LiteralPath $TraeExe)) {
        return (Resolve-Path -LiteralPath $TraeExe).Path
    }

    $command = Get-Command trae -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $command.Source
    }

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $programFiles = ${env:ProgramFiles}
    $candidates = @(
        (Join-Path $localAppData 'Programs\Trae\Trae.exe'),
        (Join-Path $localAppData 'Programs\trae\Trae.exe'),
        (Join-Path $programFiles 'Trae\Trae.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Start-TraeWorkspace {
    param(
        [string]$Executable,
        [string]$Workspace
    )

    if (-not (Test-Path -LiteralPath $Workspace)) {
        Write-DevFleetError "Workspace not found: $Workspace"
    }

    Start-Process -FilePath $Executable -ArgumentList @($Workspace) | Out-Null
}

function Get-TraeProcess {
    $processes = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match '^(Trae|TRAE)$' -or $_.ProcessName -match '^Trae'
    }
    foreach ($process in ($processes | Sort-Object StartTime -Descending)) {
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            return $process
        }
    }
    return $null
}

function Wait-TraeMainWindow {
    param([int]$TimeoutSeconds = 15)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $process = Get-TraeProcess
        if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
            return $process
        }
        Start-Sleep -Milliseconds 400
    }

    Write-DevFleetError 'Timed out waiting for Trae main window. Ensure Trae is installed and the user session is interactive.'
}

function Focus-TraeWindow {
    param($Process)

    $handle = $Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) {
        Write-DevFleetError 'Trae main window handle is unavailable.'
    }

    [DevFleetWin32]::ShowWindow($handle, [DevFleetWin32]::SW_RESTORE) | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not [DevFleetWin32]::SetForegroundWindow($handle)) {
        Start-Sleep -Milliseconds 500
        [DevFleetWin32]::SetForegroundWindow($handle) | Out-Null
    }
    Start-Sleep -Milliseconds 800
}

function Find-UiElementByNames {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string[]]$Names,
        [System.Windows.Automation.ControlType[]]$ControlTypes
    )

    if ($null -eq $Root) {
        return $null
    }

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $Names[0]
    )

    foreach ($name in $Names) {
        $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $name
        )
        foreach ($controlType in $ControlTypes) {
            $typeCondition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                $controlType
            )
            $and = New-Object System.Windows.Automation.AndCondition($typeCondition, $nameCondition)
            $element = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
            if ($element) {
                return $element
            }
        }
    }

    return $null
}

function Invoke-NewTaskShortcut {
    foreach ($shortcut in $NewTaskShortcuts) {
        try {
            [System.Windows.Forms.SendKeys]::SendWait($shortcut)
            Start-Sleep -Milliseconds 900
            return $true
        } catch {
            continue
        }
    }
    return $false
}

function Invoke-NewTaskButton {
    param($Process)

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    if (-not $root) {
        return $false
    }

    $controlTypes = @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::MenuItem,
        [System.Windows.Automation.ControlType]::Hyperlink
    )

    $button = Find-UiElementByNames -Root $root -Names $NewTaskButtonNames -ControlTypes $controlTypes
    if (-not $button) {
        return $false
    }

    $invokePattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invokePattern) {
        $invokePattern.Invoke()
        Start-Sleep -Milliseconds 900
        return $true
    }

    return $false
}

function Save-ClipboardText {
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            return [System.Windows.Forms.Clipboard]::GetText()
        }
    } catch {
        return $null
    }
    return $null
}

function Restore-ClipboardText {
    param([string]$OldText)

    try {
        if ($null -ne $OldText) {
            [System.Windows.Forms.Clipboard]::SetText($OldText)
        }
    } catch {
        # Best effort restore.
    }
}

function Submit-Prompt {
    param([string]$Text)

    $oldClipboard = Save-ClipboardText
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 400
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Start-Sleep -Milliseconds 200
    } finally {
        Restore-ClipboardText -OldText $oldClipboard
    }
}

function Invoke-NewTaskFlow {
    param($Process)

    Focus-TraeWindow -Process $Process

    $triggered = Invoke-NewTaskShortcut
    if (-not $triggered) {
        $triggered = Invoke-NewTaskButton -Process $Process
    }
    if (-not $triggered) {
        Write-DevFleetError 'Failed to trigger Trae New Task via shortcut or UI Automation. Ensure Trae is focused and the UI language matches 新任务 / New Task.'
    }
}

$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$promptText = Get-PromptText
$traeExecutable = Find-TraeExecutable
if (-not $traeExecutable) {
    Write-DevFleetError 'Trae executable not found. Install Trae or pass -TraeExe.'
}

Start-TraeWorkspace -Executable $traeExecutable -Workspace $workspace
$traeProcess = Wait-TraeMainWindow
Invoke-NewTaskFlow -Process $traeProcess
Submit-Prompt -Text $promptText
