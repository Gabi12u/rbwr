; Windows installer for RBWR Demands (Inno Setup 6).
; Built by .github/workflows/release.yml after the app itself:
;   iscc /DAppVersion=1.1.0 installer\rbwr-demands.iss
; Installs for the current user only, so no administrator rights are needed.

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

[Setup]
AppId={{8055B7FD-8231-41EB-BB96-1E57DEF93E3D}
AppName=RBWR Demands
AppVersion={#AppVersion}
AppVerName=RBWR Demands {#AppVersion}
AppPublisher=RBWR Demands (fan project)
AppPublisherURL=https://github.com/Gabi12u/rbwr
AppSupportURL=https://github.com/Gabi12u/rbwr
DefaultDirName={autopf}\RBWR Demands
DefaultGroupName=RBWR Demands
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=RBWR-Demands-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\rbwr-demands.exe
UninstallDisplayName=RBWR Demands
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
CloseApplications=yes

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\target\x86_64-pc-windows-msvc\release\rbwr-demands.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\RBWR Demands"; Filename: "{app}\rbwr-demands.exe"
Name: "{autoprograms}\RBWR Demands (also on phone)"; Filename: "{app}\rbwr-demands.exe"; Parameters: "--lan"
Name: "{autodesktop}\RBWR Demands"; Filename: "{app}\rbwr-demands.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\rbwr-demands.exe"; Description: "{cm:LaunchProgram,RBWR Demands}"; Flags: nowait postinstall skipifsilent
