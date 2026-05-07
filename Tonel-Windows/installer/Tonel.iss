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
#define AppVersion     "0.1.0"
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
MinVersion=10.0.17763   ; Windows 10 1809 (WASAPI low-latency baseline)
CloseApplications=yes
RestartApplications=no

; Uncomment after you have a code-signing certificate. The "$qWWWWW$q"
; quoting handles the embedded quotes Inno Setup needs around argv.
;SignTool=signtool
;SignedUninstaller=yes

[Languages]
Name: "english";  MessagesFile: "compiler:Default.isl"
Name: "chinese";  MessagesFile: "compiler:Languages\ChineseSimplified.isl"

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
