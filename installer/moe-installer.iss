[Setup]
AppName=Moe
AppVersion=0.1.0
AppId={{1D3A4E9B-2B35-4DD0-9D71-60C7D55D2B0A}}
DefaultDirName={pf}\Moe
DefaultGroupName=Moe
OutputDir=installer\output
OutputBaseFilename=moe-setup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes

[Files]
Source: "installer\assets\moe-daemon\*"; DestDir: "{app}\moe-daemon"; Flags: recursesubdirs createallsubdirs
Source: "installer\assets\moe-proxy\*"; DestDir: "{app}\moe-proxy"; Flags: recursesubdirs createallsubdirs
Source: "installer\assets\moe-jetbrains.zip"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Environment]
Name: "MOE_DAEMON_COMMAND"; Value: """{app}\moe-daemon\start-daemon.cmd"""; Flags: preservestringtype

[Code]
function GetPyCharmConfigDir(): string;
var
  Root: string;
  FindRec: TFindRec;
  Best: string;
begin
  Root := ExpandConstant('{userappdata}') + '\\JetBrains';
  if DirExists(Root + '\\PyCharm2025.2') then begin
    Result := Root + '\\PyCharm2025.2';
    exit;
  end;

  Best := '';
  if FindFirst(Root + '\\PyCharm*', FindRec) then begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin
          if (Best = '') or (CompareText(FindRec.Name, Best) > 0) then
            Best := FindRec.Name;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;

  if Best <> '' then
    Result := Root + '\\' + Best
  else
    Result := Root + '\\PyCharm2025.2';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ZipPath: string;
  PluginsDir: string;
begin
  if CurStep = ssPostInstall then begin
    ZipPath := ExpandConstant('{tmp}\\moe-jetbrains.zip');
    PluginsDir := GetPyCharmConfigDir() + '\\plugins';
    if FileExists(ZipPath) then begin
      ForceDirectories(PluginsDir);
      Exec('powershell', '-ExecutionPolicy Bypass -Command "Expand-Archive -Path \"' + ZipPath + '\" -DestinationPath \"' + PluginsDir + '\\moe-jetbrains\" -Force"', '', SW_HIDE, ewWaitUntilTerminated, CurStep);
    end;
  end;
end;
