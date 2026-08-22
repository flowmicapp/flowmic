# Probe 3 - the PROPOSED sequence, so the fix is measured before it is written.
#   announce -> Ctrl+V -> HOLD the payload, serving renders, while polling a
#   read-back of the focused element -> restore as soon as read-back CONFIRMS
#   (or when the hold window expires) -> ask the target what it received.
# Run with -Legacy to replay the SHIPPED sequence instead (break at first
# receipt, restore immediately) - that is the RED half of the drill.
param([int]$HoldMs = 1500, [switch]$Legacy)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Diagnostics;using System.Text;
public static class P3{
 const int WM_RENDERFORMAT=0x0305,WM_RENDERALLFORMATS=0x0306;const uint CF=13;
 delegate IntPtr WP(IntPtr h,uint m,IntPtr w,IntPtr l);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [StructLayout(LayoutKind.Sequential)]struct WNDCLASS{public uint style;public IntPtr proc;public int a,b;public IntPtr i,ic,c,bg;[MarshalAs(UnmanagedType.LPWStr)]public string mn;[MarshalAs(UnmanagedType.LPWStr)]public string cn;}
 [StructLayout(LayoutKind.Sequential)]struct POINT{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct MSG{public IntPtr h;public uint m;public IntPtr w,l;public uint t;public POINT p;}
 [StructLayout(LayoutKind.Sequential)]struct KEYBDINPUT{public ushort vk,scan;public uint flags,time;public IntPtr extra;}
 [StructLayout(LayoutKind.Sequential)]struct INPUT{public uint type;public KEYBDINPUT ki;public int pad1,pad2;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern ushort RegisterClassW(ref WNDCLASS c);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateWindowExW(uint e,string c,string n,uint s,int x,int y,int w,int h,IntPtr p,IntPtr m,IntPtr i,IntPtr q);
 [DllImport("user32.dll")]static extern IntPtr DefWindowProcW(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool DestroyWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool PeekMessageW(out MSG m,IntPtr h,uint a,uint b,uint r);
 [DllImport("user32.dll")]static extern bool TranslateMessage(ref MSG m);
 [DllImport("user32.dll")]static extern IntPtr DispatchMessageW(ref MSG m);
 [DllImport("user32.dll",SetLastError=true)]static extern bool OpenClipboard(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)]static extern bool EmptyClipboard();
 [DllImport("user32.dll",SetLastError=true)]static extern bool CloseClipboard();
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetClipboardData(uint f,IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetClipboardOwner();
 [DllImport("kernel32.dll")]static extern IntPtr GlobalAlloc(uint f,UIntPtr n);
 [DllImport("kernel32.dll")]static extern IntPtr GlobalLock(IntPtr h);
 [DllImport("kernel32.dll")]static extern bool GlobalUnlock(IntPtr h);
 [DllImport("user32.dll")]static extern uint SendInput(uint n,INPUT[] i,int s);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")]static extern bool AttachThreadInput(uint a,uint b,bool at);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);

 public static List<string> log=new List<string>();static Stopwatch sw=new Stopwatch();static WP keep;
 static byte[] payload;public static bool rendered;static int renderCount;static IntPtr owner;

 static IntPtr Proc(IntPtr h,uint m,IntPtr w,IntPtr l){
  if(m==WM_RENDERFORMAT){renderCount++;
   log.Add(String.Format("t+{0,4}ms  WM_RENDERFORMAT #{1}",sw.ElapsedMilliseconds,renderCount));
   if((uint)w==CF){IntPtr g=Alloc(payload);if(SetClipboardData(CF,g)!=IntPtr.Zero)rendered=true;}}
  if(m==WM_RENDERALLFORMATS)log.Add(String.Format("t+{0,4}ms  WM_RENDERALLFORMATS",sw.ElapsedMilliseconds));
  return DefWindowProcW(h,m,w,l);}
 static IntPtr Alloc(byte[] b){IntPtr g=GlobalAlloc(0x0002,(UIntPtr)(uint)b.Length);IntPtr p=GlobalLock(g);Marshal.Copy(b,0,p,b.Length);GlobalUnlock(g);return g;}
 static byte[] Utf16z(string s){var b=new byte[(s.Length+1)*2];Encoding.Unicode.GetBytes(s,0,s.Length,b,0);return b;}
 public static string Title(IntPtr h){var sb=new StringBuilder(512);GetWindowTextW(h,sb,512);return sb.ToString();}
 public static IntPtr Find(string needle){IntPtr f=IntPtr.Zero;
  EnumWindows(delegate(IntPtr h,IntPtr l){if(IsWindowVisible(h)&&Title(h).Contains(needle)){f=h;return false;}return true;},IntPtr.Zero);return f;}
 public static void Pump(){MSG m;while(PeekMessageW(out m,owner,0,0,1)){TranslateMessage(ref m);DispatchMessageW(ref m);}}
 public static long Now(){return sw.ElapsedMilliseconds;}
 public static void Note(string s){log.Add(String.Format("t+{0,4}ms  {1}",sw.ElapsedMilliseconds,s));}

 public static bool ForceForeground(IntPtr h){uint pid;uint tgt=GetWindowThreadProcessId(h,out pid);uint cur=GetCurrentThreadId();
  uint fg=GetWindowThreadProcessId(GetForegroundWindow(),out pid);
  AttachThreadInput(cur,fg,true);AttachThreadInput(cur,tgt,true);
  ShowWindow(h,9);BringWindowToTop(h);SetForegroundWindow(h);System.Threading.Thread.Sleep(350);
  bool ok=GetForegroundWindow()==h;AttachThreadInput(cur,tgt,false);AttachThreadInput(cur,fg,false);return ok;}

 public static bool Begin(string oldText,string injected){
  keep=new WP(Proc);var wc=new WNDCLASS();wc.proc=Marshal.GetFunctionPointerForDelegate(keep);
  wc.cn="FlowMicP3_"+Process.GetCurrentProcess().Id;RegisterClassW(ref wc);
  owner=CreateWindowExW(0,wc.cn,null,0,0,0,0,0,(IntPtr)(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
  if(owner==IntPtr.Zero)return false;
  payload=Utf16z(injected);sw.Start();
  OpenClipboard(owner);EmptyClipboard();SetClipboardData(CF,Alloc(Utf16z(oldText)));CloseClipboard();
  Note("user clipboard seeded ("+oldText.Length+" chars)");
  OpenClipboard(owner);EmptyClipboard();SetClipboardData(CF,IntPtr.Zero);CloseClipboard();
  Note("announced DELAYED CF_UNICODETEXT");
  return true;}

 public static uint CtrlV(){var inp=new INPUT[4];for(int i=0;i<4;i++){inp[i].type=1;}
  inp[0].ki.vk=0x11;inp[1].ki.vk=0x56;inp[2].ki.vk=0x56;inp[2].ki.flags=2;inp[3].ki.vk=0x11;inp[3].ki.flags=2;
  return SendInput(4,inp,Marshal.SizeOf(typeof(INPUT)));}

 public static void Finish(string oldText){
  bool ours=GetClipboardOwner()==owner;OpenClipboard(owner);EmptyClipboard();CloseClipboard();DestroyWindow(owner);
  Note("withdrawn (ours="+ours+") + owner window destroyed");
  OpenClipboard(IntPtr.Zero);EmptyClipboard();SetClipboardData(CF,Alloc(Utf16z(oldText)));CloseClipboard();
  Note("USER CLIPBOARD RESTORED");}
}
'@

$old = 'OLDCLIP-' + ('x' * 40)
$inj = 'INJECTED-' + ('y' * 40)

$tgt = [P3]::Find('ClipProbeTarget')
if ($tgt -eq [IntPtr]::Zero) { Write-Host 'FATAL: probe target window not found'; exit 1 }
if (-not [P3]::ForceForeground($tgt)) { Write-Host 'ABORTED: target not foreground; no keystroke sent'; exit 1 }
if (-not [P3]::Begin($old, $inj)) { Write-Host 'FATAL: owner window'; exit 1 }
[P3]::Note("target foregrounded AND re-confirmed: " + [P3]::Title($tgt))

Start-Sleep -Milliseconds 80          # CLIPBOARD_SETTLE
$sent = [P3]::CtrlV()
[P3]::Note("Ctrl+V sent (events=$sent)")

$confirmedAt = -1
$deadline = [P3]::Now() + $(if ($Legacy) { 500 } else { $HoldMs })
while ([P3]::Now() -lt $deadline) {
  [P3]::Pump()
  if ($Legacy) {
    if ([P3]::rendered) { [P3]::Note("LEGACY: wait loop exited on the render receipt"); break }
  } else {
    # read-back: does the focused element now end with what we injected?
    try {
      $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
      $vp = $null
      if ($null -ne $fe -and $fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $v = $vp.Current.Value
        if ($v -and $v.EndsWith($inj)) { $confirmedAt = [P3]::Now(); [P3]::Note("READ-BACK CONFIRMED: focused element ends with the injected text (len=$($v.Length))"); break }
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 20
}
if ($confirmedAt -lt 0 -and -not $Legacy) { [P3]::Note("read-back never confirmed; held the full $HoldMs ms") }

[P3]::Finish($old)

for ($i = 0; $i -lt 16; $i++) {
  Start-Sleep -Milliseconds 250
  $t = [P3]::Title($tgt)
  if ($t.StartsWith('GOT[')) { [P3]::Note("TARGET REPORTS: $t"); break }
}
if (-not ([P3]::Title($tgt)).StartsWith('GOT[')) { [P3]::Note("TARGET REPORTS: (no paste event) " + [P3]::Title($tgt)) }

[P3]::log | ForEach-Object { Write-Host $_ }
