; Alex Link — per-user installer (no admin). Built by build.ps1:
;   ISCC /DAppVersion=1.0.0 /DDistDir=<PyInstaller onedir folder> AlexLink.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef DistDir
  #define DistDir "..\build\dist\AlexLink"
#endif

[Setup]
AppId={{E19B10A6-4FDD-44C1-ACF0-3C6B53489724}
AppName=Alex Link
AppVersion={#AppVersion}
AppVerName=Alex Link {#AppVersion}
AppPublisher=Alex Tasks
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\AlexLink
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Alex Link
UninstallDisplayName=Alex Link
UninstallDisplayIcon={app}\AlexLink.exe
SetupIconFile=..\icons\app.ico
OutputDir=..\build\out
OutputBaseFilename=AlexLink-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
CloseApplications=no
ShowLanguageDialog=auto
UsePreviousTasks=yes

[Languages]
Name: "hebrew"; MessagesFile: "compiler:Languages\Hebrew.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.AutoStart=Start Alex Link when I sign in to Windows
hebrew.AutoStart=הפעל את Alex Link בכל כניסה ל-Windows
english.StartNow=Start Alex Link now
hebrew.StartNow=הפעל את Alex Link עכשיו
english.StillRunning=Alex Link is running. Close it and continue?
hebrew.StillRunning=Alex Link פועל כעת. לסגור אותו ולהמשיך?
english.RemoveData=Also remove the settings and the connection to the server from this computer?
hebrew.RemoveData=להסיר גם את ההגדרות ואת החיבור לשרת מהמחשב הזה?

[Tasks]
Name: "autostart"; Description: "{cm:AutoStart}"

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; old bundled libraries from a previous version
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{userprograms}\Alex Link"; Filename: "{app}\AlexLink.exe"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AlexLink"; ValueData: """{app}\AlexLink.exe"""; Tasks: autostart; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "AlexLink"; ValueType: none; Tasks: not autostart; Flags: deletevalue

[Run]
Filename: "{app}\AlexLink.exe"; Description: "{cm:StartNow}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\AlexLink.exe"; Flags: nowait; Check: WizardSilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\AlexLink\updates"

[Code]
const
  AppMutexName = 'AlexLink';

function WaitForAppExit(Seconds: Integer): Boolean;
var
  i: Integer;
begin
  for i := 0 to Seconds * 4 do
  begin
    if not CheckForMutexes(AppMutexName) then
    begin
      Result := True;
      exit;
    end;
    Sleep(250);
  end;
  Result := not CheckForMutexes(AppMutexName);
end;

procedure KillApp;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AlexLink.exe /F', '', SW_HIDE,
       ewWaitUntilTerminated, Code);
  WaitForAppExit(10);
end;

{ The app quits by itself before a silent update; give it time, then make sure. }
function EnsureClosed(Silent: Boolean): Boolean;
begin
  Result := True;
  if not CheckForMutexes(AppMutexName) then exit;
  if Silent then
  begin
    if not WaitForAppExit(60) then KillApp;
  end
  else
  begin
    if MsgBox(CustomMessage('StillRunning'), mbConfirmation, MB_YESNO) = IDYES then
      KillApp
    else
      Result := False;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := EnsureClosed(WizardSilent);
end;

function InitializeUninstall(): Boolean;
begin
  Result := EnsureClosed(UninstallSilent);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
    if MsgBox(CustomMessage('RemoveData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{userappdata}\AlexLink'), True, True, True);
      DelTree(ExpandConstant('{localappdata}\AlexLink'), True, True, True);
    end;
end;
