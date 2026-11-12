param(
    [int]$FakeParentPid,
    [int]$LifetimeSeconds = 6
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class PpidSpoof
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName, string commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory,
        ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    public static int Spawn(string commandLine, int fakeParentPid)
    {
        const uint PROCESS_CREATE_PROCESS = 0x0080;
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        const uint CREATE_NEW_CONSOLE = 0x00000010;
        const int PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = 0x00020000;

        IntPtr parent = OpenProcess(PROCESS_CREATE_PROCESS, false, fakeParentPid);
        if (parent == IntPtr.Zero)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributeList = Marshal.AllocHGlobal(size);
        IntPtr parentBuffer = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            Marshal.WriteIntPtr(parentBuffer, parent);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            if (!UpdateProcThreadAttribute(
                attributeList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                parentBuffer, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;

            PROCESS_INFORMATION info;
            if (!CreateProcess(
                null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_CONSOLE,
                IntPtr.Zero, null, ref startup, out info))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            return info.dwProcessId;
        }
        finally
        {
            Marshal.FreeHGlobal(attributeList);
            Marshal.FreeHGlobal(parentBuffer);
            CloseHandle(parent);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$parent = Get-Process -Id $FakeParentPid -ErrorAction Stop
$childPid = [PpidSpoof]::Spawn(
    "cmd.exe /d /s /c `"ping -n $LifetimeSeconds 127.0.0.1 >nul`"",
    $FakeParentPid
)

$observed = $null
for ($i = 0; $i -lt 20; $i++) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $childPid" -ErrorAction SilentlyContinue
    if ($process) {
        $observed = [int]$process.ParentProcessId
        break
    }
    Start-Sleep -Milliseconds 100
}

[ordered]@{
    spoofed = $true
    fake_parent_pid = $FakeParentPid
    fake_parent_name = $parent.ProcessName
    child_pid = $childPid
    observed_parent_pid = $observed
    parent_match = ($observed -eq $FakeParentPid)
    lifetime_seconds = $LifetimeSeconds
} | ConvertTo-Json -Compress
