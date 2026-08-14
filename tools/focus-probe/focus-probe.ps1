<#
  SPEC-REF:
    docs/strategy/2026-08-02-0248-status-truth-analysis.md  §F1b + 「owner 2026-08-02 澄清」②
    docs/strategy/2026-08-02-f1b-universal-focus-probe-matrix.md   (the report this feeds)
    docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
    apps/desktop/src-tauri/src/caret.rs            (the caret predicate mirrored below)
    apps/desktop/src-tauri/src/inject/target_probe.rs (the focus evidence mirrored below)

  🔴 THIS IS NOT PRODUCT CODE. It is a read-only spike instrument. It is not built,
  not shipped, not imported by anything under apps/. It writes nothing but its own
  JSONL log. Do not wire it into the inject pipeline — if a criterion measured here
  ever becomes product, it gets reimplemented in Rust next to target_probe.rs.

  WHY A SEPARATE INSTRUMENT AND NOT A UNIT TEST
    The question is 「what does the OS say about somebody else's window」. No test
    harness can answer it: it needs a real desktop, a real foreground app, and a real
    token. So this runs for real and prints raw numbers, never conclusions.

  🔴 MEASUREMENT VALIDITY — the two things this spike exists to not get wrong
    (1) TOKEN. The dev shell is elevated (High Mandatory Level, Administrators
        enabled); the product is NOT. A probe that reads window state from an
        elevated process can see things the product physically cannot (UIPI). So
        `-Mode token` self-reports the token, EVERY sample line carries it, and the
        matrix is meant to be run twice: once here, once under
        `runas /trustlevel:0x20000` (restricted token). Two columns, never one.
    (2) OBSERVER EFFECT. Chromium builds its accessibility tree — and, historically,
        its system caret — only once an AT client asks. A probe that queries UIA in
        the same pass can therefore MANUFACTURE the caret it is trying to measure.
        Hence `-Uia off` is the default and `-Uia focused` is a separate run; the
        report compares them. (This is the RV-45 lesson restated: a number is only
        as hard as the mechanism that produced it.)

  USAGE (one line each)
    pwsh -NoProfile -File tools/focus-probe/focus-probe.ps1 -Mode token
    pwsh -NoProfile -File tools/focus-probe/focus-probe.ps1 -Mode watch -Seconds 30 -Json out.jsonl
    pwsh -NoProfile -File tools/focus-probe/focus-probe.ps1 -Mode watch -Seconds 30 -Attach -Json out.jsonl
    pwsh -NoProfile -File tools/focus-probe/focus-probe.ps1 -Mode summarize -Json out.jsonl
#>
[CmdletBinding()]
param(
  [ValidateSet('token', 'watch', 'summarize', 'query', 'launch', 'foreground', 'fgnow', 'activate')] [string]$Mode = 'watch',
  [int]$TargetPid = 0,
  [long]$Hwnd = 0,
  # Lower our own mandatory label to Medium before doing anything. THE 「非提权」 COLUMN.
  # Also used with -Mode launch so the TARGET app starts at Medium too — an elevated
  # target would make the product's own reads fail for a reason unrelated to the app.
  [switch]$DropToMedium,
  [string]$QueryProcess = '',
  [string]$Exe = '',
  [string]$ExeArgs = '',
  # Launch the target on a private desktop — see the note in the C# block.
  [string]$Desktop = '',
  [string]$Out = '',
  [int]$Seconds = 20,
  [int]$IntervalMs = 200,
  # AttachThreadInput to the foreground thread before reading. Costs a shared input
  # queue (and a hang risk) — measured, not recommended by default.
  [switch]$Attach,
  # 'focused' also asks UIA for the focused element. SEPARATE RUN ON PURPOSE.
  [ValidateSet('off', 'focused')] [string]$Uia = 'off',
  [string]$Json,
  # Free text stamped on every sample (which app / which run).
  [string]$Label = '',
  # Only keep samples whose foreground window title contains this marker. Used by the
  # scenario page, which names its own phase in the title — so the LABEL COMES FROM
  # THE TARGET, not from my assumption about what was focused when.
  [string]$RequireTitle = '',
  # 🔴 NOT the production path. Read the thread of the window carrying -RequireTitle
  # instead of the foreground thread. Only for sessions that have no foreground
  # window at all; every sample it produces is stamped followed=true.
  [switch]$Follow,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class FocusProbeNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
  [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", SetLastError = true)] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetFocus();
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetCaretPos(out POINT p);
  [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr h, IntPtr himc);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);

  public class Snap {
    public string ts;
    /// true = this reading did NOT come from the foreground thread (see Sample).
    public bool followed;
    public string fgTitle = "", fgClass = "", fgProc = "";
    public long fgHwnd; public uint fgPid, fgTid;
    // GetGUIThreadInfo
    public bool guiOk; public int guiErr; public uint flags;
    public long hwndActive, hwndFocus, hwndCaret, hwndMenuOwner, hwndMoveSize, hwndCapture;
    public string focusClass = "", caretClass = "", focusProc = "";
    public int caretL, caretT, caretR, caretB;
    // the product's own two predicates, computed here so nobody re-derives them wrong
    public bool caretHwndNonNull;      // target_probe.rs records this raw
    public bool caretUsable;           // caret.rs foreground_caret(): hwnd + non-zero rect + h>0
    public long immContext = -1;       // -1 = never asked
    // attach-only extras
    public bool attached; public long attachFocus; public bool caretPosOk; public int caretPosX, caretPosY;
    // observer-effect columns (only filled when -Uia focused)
    public string uiaFramework = "", uiaControl = "", uiaName = "", uiaErr = "";
    public int uiaKeyboardFocusable = -1, uiaHasValue = -1, uiaHasText = -1, uiaReadOnly = -1;
  }

  static string ClassOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(256); int n = GetClassNameW(h, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : "";
  }
  static string TitleOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(512); int n = GetWindowTextW(h, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : "";
  }
  static string ProcOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "(pid " + pid + ")"; }
  }

  /// One reading. `attach` = also AttachThreadInput to the read thread and take the
  /// same reading again (plus GetFocus/GetCaretPos, which are attach-only APIs).
  /// `followMarker` non-empty = read the thread of the window whose title carries
  /// that marker INSTEAD of the foreground thread. That is not the production path
  /// (production reads the foreground) and every sample says so via `followed`.
  public static Snap Sample(bool attach) { return Sample(attach, null); }
  public static Snap Sample(bool attach, string followMarker) {
    var s = new Snap();
    s.ts = DateTime.Now.ToString("HH:mm:ss.fff");
    IntPtr fg = GetForegroundWindow();
    if (!string.IsNullOrEmpty(followMarker)) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, p) => {
        if (!IsWindowVisible(h)) return true;
        var t = TitleOf(h);
        if (t.IndexOf(followMarker, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
        return true;
      }, IntPtr.Zero);
      s.followed = true;
      fg = found;
    }
    s.fgHwnd = fg.ToInt64();
    if (fg == IntPtr.Zero) return s;                 // locked / no foreground at all
    uint pid; uint tid = GetWindowThreadProcessId(fg, out pid);
    s.fgPid = pid; s.fgTid = tid;
    s.fgTitle = TitleOf(fg); s.fgClass = ClassOf(fg);
    try { s.fgProc = Process.GetProcessById((int)pid).ProcessName; } catch { s.fgProc = "(denied)"; }
    if (tid == 0) return s;

    if (attach) {
      // 🔴 The cost: our input queue is welded to theirs until we detach. If they
      // hang, we hang. Measured here precisely so the report can price it.
      s.attached = AttachThreadInput(GetCurrentThreadId(), tid, true);
    }

    var gui = new GUITHREADINFO(); gui.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(tid, ref gui)) {
      s.guiErr = Marshal.GetLastWin32Error();        // 5 = ACCESS_DENIED (elevated target)
    } else {
      s.guiOk = true;
      s.flags = gui.flags;
      s.hwndActive = gui.hwndActive.ToInt64();
      s.hwndFocus = gui.hwndFocus.ToInt64();
      s.hwndCaret = gui.hwndCaret.ToInt64();
      s.hwndMenuOwner = gui.hwndMenuOwner.ToInt64();
      s.hwndMoveSize = gui.hwndMoveSize.ToInt64();
      s.hwndCapture = gui.hwndCapture.ToInt64();
      s.focusClass = ClassOf(gui.hwndFocus);
      s.focusProc = ProcOf(gui.hwndFocus);
      s.caretClass = ClassOf(gui.hwndCaret);
      s.caretL = gui.rcCaret.left; s.caretT = gui.rcCaret.top;
      s.caretR = gui.rcCaret.right; s.caretB = gui.rcCaret.bottom;

      s.caretHwndNonNull = gui.hwndCaret != IntPtr.Zero;
      bool zeroRect = gui.rcCaret.left == 0 && gui.rcCaret.top == 0 && gui.rcCaret.right == 0 && gui.rcCaret.bottom == 0;
      int h = gui.rcCaret.bottom - gui.rcCaret.top, w = gui.rcCaret.right - gui.rcCaret.left;
      s.caretUsable = s.caretHwndNonNull && !zeroRect && h > 0 && w >= 0;   // == caret.rs

      if (gui.hwndFocus != IntPtr.Zero) {
        IntPtr himc = ImmGetContext(gui.hwndFocus);
        s.immContext = himc.ToInt64();
        if (himc != IntPtr.Zero) ImmReleaseContext(gui.hwndFocus, himc);
      }
    }

    if (s.attached) {
      s.attachFocus = GetFocus().ToInt64();
      POINT p; s.caretPosOk = GetCaretPos(out p);
      s.caretPosX = p.x; s.caretPosY = p.y;
      AttachThreadInput(GetCurrentThreadId(), tid, false);
    }
    return s;
  }

  // .NET's WindowsIdentity.Groups does NOT carry the integrity label, so the SID has
  // to come from the token itself. TokenIntegrityLevel = 25.
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool IsTokenRestricted(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr h, int cls, IntPtr buf, int len);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

  /// 🔴 MEASURED, NOT ASSUMED: `runas /trustlevel:0x20000` only strips the admin
  /// GROUP — it leaves the token at HIGH integrity, and UIPI keys off INTEGRITY, not
  /// group membership. So the 「非提权」 column has to be produced by actually lowering
  /// the mandatory label (a token may always be lowered, never raised). After this
  /// call the process is physically incapable of the cross-integrity reads the
  /// product is also incapable of — which is the whole point.
  public static bool DropToMedium() {
    IntPtr sid;
    if (!ConvertStringSidToSidW("S-1-16-8192", out sid)) return false;
    var lab = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 /* SE_GROUP_INTEGRITY */ };
    int sz = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr buf = Marshal.AllocHGlobal(sz);
    try {
      Marshal.StructureToPtr(lab, buf, false);
      return SetTokenInformation(WindowsIdentity.GetCurrent().Token, 25, buf, sz);
    } finally { Marshal.FreeHGlobal(buf); }
  }

  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);

  /// Bring the window this spike just opened to the front, and NOTHING else. The
  /// classic AttachThreadInput dance is needed because a headless launcher has no
  /// foreground right of its own, so its child window opens behind the owner's work.
  /// Used only on windows this script started (and, at the end, to hand the
  /// foreground back to whatever had it before).
  public static string ForceForeground(int pid) {
    IntPtr h = IntPtr.Zero;
    try {
      var proc = Process.GetProcessById(pid);
      h = proc.MainWindowHandle;
    } catch { return "no such pid"; }
    if (h == IntPtr.Zero) return "pid has no main window yet";
    return ForceForegroundHwnd(h.ToInt64());
  }
  public static string ForceForegroundHwnd(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (h == IntPtr.Zero) return "null hwnd";
    if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgTid = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
    uint me = GetCurrentThreadId();
    bool att = false;
    if (fgTid != 0 && fgTid != me) att = AttachThreadInput(me, fgTid, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (att) AttachThreadInput(me, fgTid, false);
    return "setForeground=" + ok + " attached=" + att + " now=0x" + GetForegroundWindow().ToInt64().ToString("x");
  }
  // ── PRIVATE DESKTOP ────────────────────────────────────────────────────────
  // 🔴 WHY THIS EXISTS, AND WHAT IT COSTS THE MEASUREMENT
  // Measured 2026-08-02 on this machine: the interactive session (RDP #0, state
  // Active) has NO foreground window at all — GetForegroundWindow() == 0,
  // GetGUIThreadInfo(0) fails, and SetForegroundWindow() returns false even with
  // AllowSetForegroundWindow + the ALT-key trick. Per-thread GUI state is still
  // readable, but nothing can be activated, and an unactivated window never gets a
  // caret. So the whole scenario matrix is unrunnable on the input desktop.
  // A desktop created here has its own activation/foreground state and does work.
  // THE COST: it is NOT the desktop the product runs on. Every number taken here is
  // 【实测·私有桌面】 and needs one confirmation pass on the real desktop — which is
  // why the report ships an owner checklist. The internal control against 「the
  // private desktop broke the instrument」 is the WinForms target: real EDIT controls
  // whose caret behaviour is known, measured in the same run.
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, uint flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
  const uint GENERIC_ALL = 0x10000000;

  static IntPtr _desk = IntPtr.Zero;
  public static string UseDesktop(string name) {
    IntPtr ws = OpenWindowStationW("WinSta0", false, GENERIC_ALL);
    if (ws != IntPtr.Zero) SetProcessWindowStation(ws);
    IntPtr d = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (d == IntPtr.Zero) return "CreateDesktop failed err=" + Marshal.GetLastWin32Error();
    bool ok = SetThreadDesktop(d);
    if (!ok) return "SetThreadDesktop failed err=" + Marshal.GetLastWin32Error();
    _desk = d;
    return "desktop=" + name + " ok";
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFOW {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);

  /// Launch on a named desktop. lpDesktop is set EXPLICITLY rather than relying on
  /// inheritance, so 「which desktop did the target actually land on」 is not a guess.
  public static int LaunchOnDesktop(string exe, string argstr, string desktop) {
    // 🔴 The desktop must EXIST before CreateProcess names it, and it only stays
    // alive while somebody holds a handle or runs a thread on it. Naming a desktop
    // that does not exist does NOT fail CreateProcess — the child is created and
    // then dies during session attach, silently, with no output (measured: a cmd.exe
    // that should have written one line wrote nothing). So: create it here, hold the
    // handle, and let the caller sleep until the child has attached.
    if (!string.IsNullOrEmpty(desktop) && _desk == IntPtr.Zero) {
      IntPtr ws = OpenWindowStationW("WinSta0", false, GENERIC_ALL);
      if (ws != IntPtr.Zero) SetProcessWindowStation(ws);
      _desk = CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
      if (_desk == IntPtr.Zero) throw new Exception("CreateDesktop failed err=" + Marshal.GetLastWin32Error());
    }
    var si = new STARTUPINFOW();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
    si.lpDesktop = string.IsNullOrEmpty(desktop) ? null : ("WinSta0\\" + desktop);
    var cmd = new StringBuilder("\"" + exe + "\" " + argstr);
    PROCESS_INFORMATION pi;
    // CREATE_NEW_CONSOLE(0x10) is REQUIRED, not cosmetic: a console cannot be shared
    // across desktops, so a console child that tries to inherit ours dies instantly
    // and silently (measured — two processes vanished with no output at all).
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref si, out pi))
      throw new Exception("CreateProcess failed err=" + Marshal.GetLastWin32Error());
    return pi.dwProcessId;
  }

  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  /// Find the top-level window whose title carries the scenario marker and活 it.
  /// Keyed on the TITLE (which the scenario page/app writes itself) rather than on a
  /// pid, because a browser may hand the window to a different process than the one
  /// we started.
  public static string ActivateByTitle(string marker) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var t = TitleOf(h);
      if (t.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "notfound";
    return "hwnd=0x" + found.ToInt64().ToString("x") + " " + ForceForegroundHwnd(found.ToInt64());
  }

  public static long ForegroundHwnd() { return GetForegroundWindow().ToInt64(); }
  public static string ForegroundTitle() { return TitleOf(GetForegroundWindow()); }

  /// Read GUITHREADINFO for a named process's main window WITHOUT touching the
  /// foreground — the only way to ask 「could the product even query this app?」 about
  /// a window the owner is using, without stealing it.
  public static string QueryProcess(string name) {
    var sb = new StringBuilder();
    foreach (var p in Process.GetProcessesByName(name)) {
      IntPtr h = p.MainWindowHandle;
      if (h == IntPtr.Zero) continue;
      uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
      var gui = new GUITHREADINFO(); gui.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
      bool ok = GetGUIThreadInfo(tid, ref gui);
      int err = ok ? 0 : Marshal.GetLastWin32Error();
      sb.AppendLine(string.Format(
        "proc={0} pid={1} hwnd=0x{2:x} class={3} guiOk={4} err={5} focus=0x{6:x} caret=0x{7:x} rect={8},{9},{10},{11} title={12}",
        p.ProcessName, p.Id, h.ToInt64(), ClassOf(h), ok, err,
        gui.hwndFocus.ToInt64(), gui.hwndCaret.ToInt64(),
        gui.rcCaret.left, gui.rcCaret.top, gui.rcCaret.right, gui.rcCaret.bottom, TitleOf(h)));
    }
    if (sb.Length == 0) sb.AppendLine("(no windowed process named " + name + ")");
    return sb.ToString();
  }

  public static string IntegritySid() {
    IntPtr tok = WindowsIdentity.GetCurrent().Token;
    int need; GetTokenInformation(tok, 25, IntPtr.Zero, 0, out need);
    IntPtr buf = Marshal.AllocHGlobal(need);
    try {
      if (!GetTokenInformation(tok, 25, buf, need, out need)) return "(query failed)";
      IntPtr sid = Marshal.ReadIntPtr(buf);   // TOKEN_MANDATORY_LABEL.Label.Sid
      IntPtr str;
      if (!ConvertSidToStringSidW(sid, out str)) return "(sid failed)";
      string v = Marshal.PtrToStringUni(str); LocalFree(str);
      return v;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static string IntegrityShort() {
    switch (IntegritySid()) {
      case "S-1-16-4096": return "Low";
      case "S-1-16-8192": return "Medium";
      case "S-1-16-8448": return "MediumPlus";
      case "S-1-16-12288": return "High";
      case "S-1-16-16384": return "System";
      default: return "unknown";
    }
  }
  public static string TokenLine() {
    var id = WindowsIdentity.GetCurrent();
    var pr = new WindowsPrincipal(id);
    bool restricted = false;
    try { restricted = IsTokenRestricted(id.Token); } catch { }
    return "user=" + id.Name
      + " integrity=" + IntegritySid() + " (" + IntegrityShort() + ")"
      + " isAdminRole=" + pr.IsInRole(WindowsBuiltInRole.Administrator)
      + " restrictedToken=" + restricted
      + " pid=" + Process.GetCurrentProcess().Id;
  }
}
'@ -Language CSharp

function Get-UiaFocused {
  param($snap)
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { $snap.uiaErr = 'FocusedElement=null'; return }
    $c = $el.Current
    $snap.uiaFramework = [string]$c.FrameworkId
    $snap.uiaControl = [string]$c.ControlType.ProgrammaticName
    $snap.uiaName = [string]$c.Name
    $snap.uiaKeyboardFocusable = [int][bool]$c.IsKeyboardFocusable
    $vp = $null
    $snap.uiaHasValue = [int]$el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)
    if ($snap.uiaHasValue -eq 1 -and $vp) { $snap.uiaReadOnly = [int][bool]$vp.Current.IsReadOnly }
    $tp = $null
    $snap.uiaHasText = [int]$el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)
  } catch {
    $snap.uiaErr = $_.Exception.Message
  }
}

# Drop AFTER Add-Type (the compiler needs the original token to write its temp
# assembly) and BEFORE anything is measured or launched.
if ($DropToMedium) {
  $ok = [FocusProbeNative]::DropToMedium()
  if (-not $ok) { throw "DropToMedium failed — refusing to report a 「非提权」 column produced by an elevated probe" }
  if ([FocusProbeNative]::IntegrityShort() -ne 'Medium') {
    throw "DropToMedium claimed success but the label is still $([FocusProbeNative]::IntegrityShort())"
  }
}

# 🔴 A desktop is chosen at PROCESS CREATION, never mid-flight: SetThreadDesktop
# fails with ERROR_BUSY(170) on any thread that already owns a window or a message
# queue, which a running PowerShell always does (measured 2026-08-02). So `-Desktop`
# is meaningful only for `-Mode launch`, and every probe that must live on that
# desktop is itself started through `-Mode launch -Desktop <name>`.
# `-Out` exists for the same reason: a process on another desktop still shares the
# filesystem, but its console is not ours to read.
function Write-Out { param([string]$s) if ($Out) { Add-Content -LiteralPath $Out -Value $s -Encoding utf8 } else { Write-Host $s } }

switch ($Mode) {

  'token' {
    [FocusProbeNative]::TokenLine()
    exit 0
  }

  'fgnow' {
    # Who has the foreground right now (used to hand it back afterwards).
    Write-Out ("hwnd={0} title={1}" -f [FocusProbeNative]::ForegroundHwnd(), [FocusProbeNative]::ForegroundTitle())
    exit 0
  }

  'activate' {
    if (-not $RequireTitle) { throw "-RequireTitle <marker> required" }
    Write-Out ([FocusProbeNative]::ActivateByTitle($RequireTitle))
    Write-Out ("fg=" + [FocusProbeNative]::ForegroundTitle())
    exit 0
  }

  'foreground' {
    if ($Hwnd -ne 0) { [FocusProbeNative]::ForceForegroundHwnd($Hwnd) }
    elseif ($TargetPid -ne 0) { [FocusProbeNative]::ForceForeground($TargetPid) }
    else { throw "-TargetPid <id> or -Hwnd <n> required" }
    exit 0
  }

  'query' {
    if (-not $QueryProcess) { throw "-QueryProcess <name> required" }
    Write-Host ("# probe token: " + [FocusProbeNative]::TokenLine())
    [FocusProbeNative]::QueryProcess($QueryProcess)
    exit 0
  }

  'launch' {
    if (-not $Exe) { throw "-Exe <path> required" }
    Write-Host ("# launcher token: " + [FocusProbeNative]::TokenLine())
    $launched = if ($Desktop) {
      [FocusProbeNative]::LaunchOnDesktop($Exe, $ExeArgs, $Desktop)
    } else {
      $p = if ($ExeArgs) { Start-Process -FilePath $Exe -ArgumentList $ExeArgs -PassThru }
      else { Start-Process -FilePath $Exe -PassThru }
      $p.Id
    }
    # The caller needs the pid to clean up ONLY the window this spike opened.
    Write-Host ("LAUNCHED_PID=" + $launched)
    # Hold the desktop handle open until the child has attached to it, otherwise the
    # desktop is destroyed the moment this launcher exits.
    if ($Desktop) { Start-Sleep -Seconds 4 }
    exit 0
  }

  'watch' {
    $il = [FocusProbeNative]::IntegrityShort()
    if (-not $Quiet) {
      Write-Host ("# probe token: " + [FocusProbeNative]::TokenLine())
      Write-Host ("# attach=$Attach uia=$Uia label='$Label' requireTitle='$RequireTitle'")
    }
    if ($Json) {
      $dir = Split-Path -Parent $Json
      if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
      if (Test-Path $Json) { Remove-Item $Json -Force }
    }
    $deadline = (Get-Date).AddSeconds($Seconds)
    $n = 0; $kept = 0
    while ((Get-Date) -lt $deadline) {
      $s = if ($Follow) { [FocusProbeNative]::Sample([bool]$Attach, $RequireTitle) }
      else { [FocusProbeNative]::Sample([bool]$Attach) }
      if ($Uia -eq 'focused') { Get-UiaFocused -snap $s }
      $n++
      $keep = $true
      if ($RequireTitle -and ($s.fgTitle -notlike "*$RequireTitle*")) { $keep = $false }
      if ($keep) {
        $kept++
        $row = [ordered]@{
          ts = $s.ts; label = $Label; integrity = $il; attach = [bool]$Attach; uiaMode = $Uia
          followed = $s.followed
          fgProc = $s.fgProc; fgClass = $s.fgClass; fgTitle = $s.fgTitle; fgHwnd = $s.fgHwnd
          guiOk = $s.guiOk; guiErr = $s.guiErr; flags = $s.flags
          hwndFocus = $s.hwndFocus; focusClass = $s.focusClass; focusProc = $s.focusProc
          hwndCaret = $s.hwndCaret; caretClass = $s.caretClass
          caretRect = "$($s.caretL),$($s.caretT),$($s.caretR),$($s.caretB)"
          caretHwndNonNull = $s.caretHwndNonNull; caretUsable = $s.caretUsable
          immContext = $s.immContext
          attached = $s.attached; attachFocus = $s.attachFocus
          caretPosOk = $s.caretPosOk; caretPos = "$($s.caretPosX),$($s.caretPosY)"
          uiaFramework = $s.uiaFramework; uiaControl = $s.uiaControl; uiaName = $s.uiaName
          uiaKeyboardFocusable = $s.uiaKeyboardFocusable; uiaHasValue = $s.uiaHasValue
          uiaHasText = $s.uiaHasText; uiaReadOnly = $s.uiaReadOnly; uiaErr = $s.uiaErr
        }
        if ($Json) { ($row | ConvertTo-Json -Compress -Depth 3) | Add-Content -LiteralPath $Json -Encoding utf8 }
        if (-not $Quiet) {
          '{0} {1,-14} caretHwnd=0x{2:x} usable={3,-5} rect={4,-20} focusCls={5,-24} flags=0x{6:x} guiOk={7} title={8}' -f `
            $s.ts, $s.fgProc, $s.hwndCaret, $s.caretUsable, $row.caretRect, $s.focusClass, $s.flags, $s.guiOk, $s.fgTitle | Write-Host
        }
      }
      Start-Sleep -Milliseconds $IntervalMs
    }
    if (-not $Quiet) { Write-Host "# sampled=$n kept=$kept" }
    exit 0
  }

  'summarize' {
    if (-not $Json -or -not (Test-Path $Json)) { throw "-Json <existing jsonl> required" }
    $rows = Get-Content -LiteralPath $Json | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }
    # Bucket by (label, phase-from-title). The phase is whatever the TARGET put in its
    # own title — see the header note on self-labelling.
    $groups = $rows | Group-Object -Property { "$($_.label)|$(if ($_.fgTitle -match 'PHASE:([A-Za-z0-9_-]+)') { $Matches[1] } else { '(no-phase)' })" }
    foreach ($g in $groups | Sort-Object Name) {
      $items = $g.Group
      $yes = @($items | Where-Object { $_.caretUsable }).Count
      $no = $items.Count - $yes
      $flips = 0
      for ($i = 1; $i -lt $items.Count; $i++) { if ($items[$i].caretUsable -ne $items[$i - 1].caretUsable) { $flips++ } }
      $hwndYes = @($items | Where-Object { $_.caretHwndNonNull }).Count
      $guiFail = @($items | Where-Object { -not $_.guiOk }).Count
      $foll = @($items | Where-Object { $_.followed }).Count
      $classes = ($items | ForEach-Object { $_.focusClass } | Sort-Object -Unique) -join ','
      $rects = ($items | ForEach-Object { $_.caretRect } | Sort-Object -Unique)
      $fw = ($items | ForEach-Object { $_.uiaFramework } | Where-Object { $_ } | Sort-Object -Unique) -join ','
      $ro = ($items | ForEach-Object { $_.uiaReadOnly } | Sort-Object -Unique) -join ','
      '{0,-40} n={1,-4} usable=(yes {2} / no {3}) flips={4,-3} hwndNonNull={5,-4} guiFail={6,-3} followed={7,-4} rects={8} focusCls={9} uiaFw={10} uiaRO={11}' -f `
        $g.Name, $items.Count, $yes, $no, $flips, $hwndYes, $guiFail, $foll, ($rects -join ' '), $classes, $fw, $ro | Write-Host
    }
    exit 0
  }
}
