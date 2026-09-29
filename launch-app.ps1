<#
.SYNOPSIS
  Launch the OpenAI Codex desktop app with a Chrome DevTools Protocol port open.

.DESCRIPTION
  The Codex desktop app is an MSIX package that embeds the full ChatGPT UI.
  To drive that UI over CDP we have to start it with --remote-debugging-port.
  Two constraints shape how:

    1. It must be started through its AUMID, not by running ChatGPT.exe directly.
       Launching the .exe by path strips the package identity, which changes the
       virtualised APPDATA, which loses the ChatGPT login.

    2. Any already-running instance must be closed first, otherwise Electron's
       single-instance lock makes the new process exit before the port opens.

  IApplicationActivationManager::ActivateApplication is the only documented way
  to hand arguments to a packaged app, so we go through COM. PowerShell will not
  cast the returned __ComObject to a [ComImport] interface inline, so the call
  itself is wrapped in a small C# helper.

.EXAMPLE
  powershell -File launch-app.ps1
  powershell -File launch-app.ps1 -Port 9333
#>
param(
  [int]$Port = 9222,
  [switch]$KeepExisting
)

$ErrorActionPreference = 'Stop'
$Aumid = 'OpenAI.Codex_2p2nqsd0c76g0!App'

if (-not $KeepExisting) {
  $running = Get-Process ChatGPT -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "closing $($running.Count) ChatGPT.exe process(es) so the debug port can bind..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public enum ActivateOptions { None = 0, DesignMode = 1, NoErrorUI = 2, NoSplashScreen = 4 }

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] ActivateOptions options, [Out] out uint processId);
    [PreserveSig] int ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray, [In] string verb, [Out] out uint processId);
    [PreserveSig] int ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
}

public static class AamLauncher {
    public static int Activate(string aumid, string args, out uint pid) {
        pid = 0;
        Type t = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
        object o = Activator.CreateInstance(t);
        IApplicationActivationManager mgr = (IApplicationActivationManager)o;
        return mgr.ActivateApplication(aumid, args, ActivateOptions.None, out pid);
    }
}
'@

$arguments = "--remote-debugging-port=$Port --remote-allow-origins=* --remote-debugging-address=127.0.0.1"
$procId = [uint32]0
$hr = [AamLauncher]::Activate($Aumid, $arguments, [ref]$procId)
Write-Host ("ActivateApplication -> HRESULT 0x{0:X8}, pid {1}" -f $hr, $procId)

for ($i = 1; $i -le 25; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    Write-Host "CDP is up on port $Port ($($v.Browser))"
    exit 0
  } catch { }
}

Write-Error "CDP endpoint never came up on port $Port"
exit 1
