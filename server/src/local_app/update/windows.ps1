param([string]$Mode, [string]$Path, [int]$ProcessId=0, [long]$StartedAfter=0)
$ErrorActionPreference='Stop'
# A desktop started by pwsh can inherit Core-only modules. Use the system
# modules belonging to this Windows PowerShell process for CIM and signatures.
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function NormalPath([string]$Value) {
  if([string]::IsNullOrEmpty($Value)){return ''}
  if($Value.StartsWith('\\?\UNC\')){return '\\'+$Value.Substring(8)}
  if($Value.StartsWith('\\?\')){return $Value.Substring(4)}
  return $Value
}
$Path=NormalPath $Path
try {
  if($Mode -eq 'signature') {
    $signature=Get-AuthenticodeSignature -LiteralPath $Path
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne 'Anysphere, Inc.') { throw 'Cursor installer signature is invalid or its publisher is not Anysphere, Inc.' }
    @{valid=$true} | ConvertTo-Json -Compress
    exit 0
  }
  if($Mode -eq 'installer-running') {
    $processes=if($ProcessId -gt 0){@(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)}else{@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Path)) -ErrorAction SilentlyContinue)}
    $running=@($processes|Where-Object {(NormalPath $_.Path) -ieq $Path -and ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() -ge $StartedAfter}).Count -gt 0
    @{running=[bool]$running} | ConvertTo-Json -Compress
    exit 0
  }
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CursorUpdateWindows {
  public delegate bool Callback(IntPtr window,IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb,IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static IntPtr[] Windows(uint target) {
    var result=new List<IntPtr>();
    EnumWindows((window,state)=>{uint id;GetWindowThreadProcessId(window,out id);var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);if(id==target&&name.ToString().StartsWith("Chrome_WidgetWin_"))result.Add(window);return true;},IntPtr.Zero);
    return result.ToArray();
  }
  public static void Close(uint target) {foreach(var window in Windows(target)){uint owner;GetWindowThreadProcessId(window,out owner);if(owner==target&&!PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero)&&IsWindow(window))throw new InvalidOperationException("Could not request Cursor to close.");}}
  public static string[] Arguments(string command) {
    int count;var memory=CommandLineToArgvW(command,out count);if(memory==IntPtr.Zero)throw new InvalidOperationException("Cannot read Cursor launch arguments.");
    try{var args=new string[Math.Max(0,count-1)];for(int i=1;i<count;i++)args[i-1]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));return args;}finally{LocalFree(memory);}
  }
}
'@
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  function Processes {
    foreach($entry in Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'") {
      if((NormalPath $entry.ExecutablePath) -ine $Path){continue}
      try {
        if((Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid).Sid -eq $owner){$entry}
      } catch {
        $remaining=Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if(-not $remaining -or $remaining.HasExited -or (NormalPath $remaining.Path) -ine $Path){continue}
        throw
      }
    }
  }
  $processes=@(Processes)
  if($Mode -eq 'running') { @{running=[bool]$processes.Count} | ConvertTo-Json -Compress;exit 0 }
  if($Mode -ne 'close') {throw 'Unsupported Cursor process action.'}
  # Renderer/utility processes can own Chrome helper windows too. Exclude their
  # command-line roles before considering window handles, and keep Node workers
  # (including extension servers without a .js suffix) out of the launch list.
  $workerPattern='(?i)--type=|--node-ipc|--ms-enable-electron-run-as-node|[\\/]native-agent[\\/]install\.mjs|[\\/]resources[\\/]app[\\/].*\.m?js(?:[\s"]|$)'
  $roots=@($processes | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch $workerPattern })
  if($roots.Count -gt 1){throw 'Multiple Cursor profiles are running. Close all but one before updating.'}
  $arguments=@()
  if($roots.Count -eq 1){$arguments=@([CursorUpdateWindows]::Arguments($roots[0].CommandLine))}
  $requested=@{}
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  while($processes.Count -gt 0) {
    foreach($process in $processes) {
      if($roots.ProcessId -contains $process.ProcessId -and -not $requested.ContainsKey($process.ProcessId) -and [CursorUpdateWindows]::Windows([uint32]$process.ProcessId).Count -gt 0) {
        [CursorUpdateWindows]::Close([uint32]$process.ProcessId);$requested[$process.ProcessId]=$true
      }
    }
    if([DateTime]::UtcNow -ge $deadline){throw 'Cursor did not exit. Save your work or cancel its pending dialog, then retry the update.'}
    Start-Sleep -Milliseconds 250
    $processes=@(Processes)
  }
  @{args=@($arguments)} | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message);exit 1 }
