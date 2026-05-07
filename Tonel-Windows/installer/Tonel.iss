; Tonel for Windows — Inno Setup installer script
;
; Build pipeline (run on a Windows box; macOS / Linux can't compile WPF or
; run iscc.exe):
;
;   1. dotnet publish ../TonelWindows/TonelWindows.csproj -c Release
;        → produces ../TonelWindows/bin/Release/net8.0-windows/win-x64/publish/Tonel.exe
;          (self-contained, single file, ~70 MB with .NET 8 runtime baked in)
;   2. iscc Tonel.iss
;        → produces installer/output/Tonel-Setup-X.Y.Z.exe
;
; Or just run installer/build.ps1 which does both steps.
;
; Inno Setup 6.2+ required (https://jrsoftware.org/isdl.php — free,
; commercial use OK per its own license).

#define AppName        "Tonel"
#define AppPublisher   "Tonel"
#define AppExe         "Tonel.exe"
; v6.5.9: AppVersion is `iscc /DAppVersion=...`-overridable. Without
; the #ifndef guard, `#define` here would always reset the macro to
; "0.1.0" AFTER the command-line /D had set it, so the CI's
; `iscc /DAppVersion=6.5.8` ended up producing a v0.1.0 installer
; (and build.ps1 then errored "Setup not produced" looking for the
; expected versioned name). Guarded define lets local dev keep
; "0.1.0" as a fallback when no /D is passed.
#ifndef AppVersion
  #define AppVersion   "0.1.0"
#endif
#define AppId          "{{B7F6A140-3F7E-4D2C-9A92-1C8A4D3E5A21}"
#define AppURL         "https://api.tonel.io"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
OutputDir=output
; v6.5.4: align installer filename with the Tonel-(MacOS|Windows)-vX.Y.Z
; convention used by deploy/upload-r2.sh + download.tonel.io URL scheme.
; Was `Tonel-Setup-X.Y.Z.exe`; the new name lets the latest-alias step
; in deploy/upload-r2.sh and the GH-Actions R2 push step pattern-match
; without a separate rename.
OutputBaseFilename=Tonel-Windows-v{#AppVersion}
SetupIconFile=
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; Windows 10 1809 (WASAPI low-latency baseline). v6.5.7: comment moved
; off the value line — Inno Setup's [Setup] parser treats the whole RHS
; (including the ; and trailing text) as part of the value, which fails
; with `Parsing [Setup] section, line N` and ISCC exit code 2. Block
; comments only, never inline.
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no

; Uncomment after you have a code-signing certificate. The "$qWWWWW$q"
; quoting handles the embedded quotes Inno Setup needs around argv.
;SignTool=signtool
;SignedUninstaller=yes

[Languages]
Name: "english";  MessagesFile: "compiler:Default.isl"
; v6.5.8: dropped ChineseSimplified.isl — the .isl ships with the
; official Inno Setup installer's "Languages" subfolder but is NOT
; included by Chocolatey's `choco install innosetup` distribution
; that the CI runner uses, so iscc aborts with "couldn't open include
; file". Internal-distribution installer is English-only; the app
; itself is Chinese (UI is independent of the installer wizard's
; language). When we go public we'll either commit a copy of
; ChineseSimplified.isl into installer/ or switch CI to install
; Inno Setup from the official .exe instead of choco.

[Tasks]
Name: "desktopicon";   Description: "{cm:CreateDesktopIcon}";   GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; Self-contained published output. Putting Tonel.exe at the install root,
; everything else is bundled into it via PublishSingleFile.
Source: "..\TonelWindows\bin\Release\net8.0-windows\win-x64\publish\Tonel.exe"; DestDir: "{app}"; Flags: ignoreversion

; If publish ever produces side files (e.g. when single-file is off, or
; when native libs can't be embedded), uncomment to ship them too:
; Source: "..\TonelWindows\bin\Release\net8.0-windows\win-x64\publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; License + readme available in the install dir.
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{autoprograms}\{#AppName}";        Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}";         Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Identity / preferences live in %LOCALAPPDATA%\Tonel and HKCU\Software\Tonel.
; Leave them untouched on uninstall (per Windows convention — user data
; survives reinstall). The "Wipe identity" toggle inside the app handles
; the explicit-reset case.
Type: files; Name: "{app}\tonel-app.log"
