# PrintCheck vs built-in Windows printer tooling — a bounded comparison

Scope note: this comparison is built from Microsoft's own documentation
(fetched 2026-10-11; links at the bottom). It records differentiation and
limits only — no demand scores, no readiness claims, and no comparisons
against vendor tools beyond the Microsoft documentation.

## What the built-in Windows tooling does

1. **Settings › Bluetooth & devices › Printers & scanners** — interactive
   management UI. It is also where Windows protected print mode is enabled or
   disabled ("Set up" / "Turn Off"), per the WPP documentation.
2. **Print Management / PrintManagement PowerShell cmdlets** (`Get-Printer`,
   `Get-PrinterDriver`, `Get-PrinterPort`, …) — live querying and management,
   including remote machines (`-ComputerName`, `-CimSession`). `Get-Printer
   -Full` additionally returns rendering mode and permission SDDL.
3. **WMI classes** (e.g. `Win32_Printer`, `Win32_OperatingSystem`) — a
   scripting surface with management methods (set default printer, cancel
   jobs, and so on).
4. **Windows protected print mode (WPP)** — "exclusively uses Windows Ready
   Print"; enabled interactively via Settings or centrally via Group Policy /
   Intune ("Enabling Windows protected print mode as group policy", "Windows
   protected print mode Intune configuration").
5. **Windows Ready Print** — "Windows' preferred means of communicating to
   printers, including the Internet Printing Protocol (IPP), eSCL scanning,
   and Universal Print". WPP "is designed to work with Mopria certified
   printers".

## What PrintCheck adds

- **One versioned JSON evidence document** with per-source provenance
  (`api`, `status`, bounded `error`) instead of live UI state that cannot be
  archived or diffed.
- **Explicit unknown/not-tested states** for WPP state, Mopria certification,
  IPP/eSCL capability, print success, scan success, and readiness — queue,
  driver, and port metadata is never presented as capability.
- **Shareable reports by default**: identifiers are ordinalized
  (`Queue 1`, `Network 1`, `Host 1`, `Source file 1`), imported error/prose
  text is replaced with bounded canonical text in both export modes, and the
  HTML export is a self-contained, script-free file.
- **Read-only by construction**: the collector manages nothing — no
  install/remove of printers, drivers, or ports, no spooler or settings
  changes, no WPP toggles, no network probes.

## What PrintCheck deliberately does not do

- It **does not detect WPP state**. The WPP documentation describes enabling
  and disabling through Settings or policy; this tool uses no documented
  read-only interface for the state and reports it as `unknown` — check
  Windows Settings or your management policy on the target machine.
- It **cannot verify Mopria certification** (a third-party program; see the
  Mopria certified-products list).
- It **cannot verify IPP/eSCL capability**: those are not reported by the
  Windows APIs the collector uses.
- It is **not** a management or monitoring tool and makes no readiness or
  demand claims.

## Sources (Microsoft documentation)

- Windows protected print mode (overview) —
  https://learn.microsoft.com/en-us/windows/modern-print/windows-protected-print-mode/windows-protected-print-mode
- Windows protected print mode for enterprises —
  https://learn.microsoft.com/en-us/windows/modern-print/windows-protected-print-mode/windows-protected-print-mode-for-enterprises
- Discover Windows Ready Print —
  https://learn.microsoft.com/en-us/windows/modern-print/windows-ready-print
- PrintManagement cmdlets (Get-Printer, Get-PrinterDriver, Get-PrinterPort) —
  https://learn.microsoft.com/en-us/powershell/module/printmanagement/
- Win32_OperatingSystem class —
  https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem
