# Builds build\out\AlexLink-Setup-<version>.exe (PyInstaller onedir + Inno Setup).
# Needs: Python 3.13 with pywin32, requests, pyinstaller; Inno Setup 6.
#   .\build.ps1                          build and test
#   .\build.ps1 -SignKey <keyfile>       also write AlexLink-Setup-<version>.exe.sig
# The signing key is kept offline (never on the server, never in the repository);
# the app installs an update only if its signature checks out.
param(
    [string]$SignKey = "",
    [string]$Iscc = ""
)
$ErrorActionPreference = "Continue"  # native tools write progress to stderr; exit codes are checked
$here = $PSScriptRoot
Set-Location $here

$version = (Select-String -Path "src\alexconn\version.py" -Pattern '^VERSION = "([^"]+)"').Matches[0].Groups[1].Value
Write-Host "Alex Link $version"

python -m unittest discover -s tests
if ($LASTEXITCODE) { throw "tests failed" }

$build = Join-Path $here "build"
Remove-Item (Join-Path $build "dist"), (Join-Path $build "work") -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $build -Force | Out-Null

# Windows version resource for AlexLink.exe
$v4 = (($version.Split(".") + @("0", "0", "0", "0"))[0..3] | ForEach-Object { [int]$_ }) -join ", "
$versionFile = Join-Path $build "version_info.txt"
@"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($v4), prodvers=($v4), mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Alex Tasks'),
      StringStruct('FileDescription', 'Alex Link - connects Outlook to Alex Tasks'),
      StringStruct('FileVersion', '$version'),
      StringStruct('InternalName', 'AlexLink'),
      StringStruct('LegalCopyright', 'Alex Tasks'),
      StringStruct('OriginalFilename', 'AlexLink.exe'),
      StringStruct('ProductName', 'Alex Link'),
      StringStruct('ProductVersion', '$version')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@ | Set-Content $versionFile -Encoding utf8

# Bootloader: PyInstaller is installed from source with a locally compiled bootloader
# (fewer antivirus false positives than the prebuilt one):
#   (in a "x64 Native Tools" prompt) set PYINSTALLER_COMPILE_BOOTLOADER=1
#   python -m pip install --user --force-reinstall --no-deps --no-binary pyinstaller pyinstaller==<ver>
python -m PyInstaller --noconfirm --clean --onedir --noconsole --noupx --name AlexLink `
    --version-file $versionFile `
    --manifest (Join-Path $here "installer\AlexLink.manifest") `
    --icon (Join-Path $here "icons\app.ico") `
    --add-data "$(Join-Path $here 'icons');icons" `
    --paths (Join-Path $here "src") `
    --hidden-import win32timezone `
    --distpath (Join-Path $build "dist") --workpath (Join-Path $build "work") --specpath $build `
    (Join-Path $here "src\AlexLink.py")
if ($LASTEXITCODE) { throw "PyInstaller failed" }

if (-not $Iscc) {
    $Iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
              "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
              "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Iscc) { throw "Inno Setup 6 (ISCC.exe) not found" }
& $Iscc /Q "/DAppVersion=$version" "/DDistDir=$(Join-Path $build 'dist\AlexLink')" (Join-Path $here "installer\AlexLink.iss")
if ($LASTEXITCODE) { throw "ISCC failed" }

$setup = Join-Path $build "out\AlexLink-Setup-$version.exe"
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
Write-Host "$setup"
Write-Host "size   $((Get-Item $setup).Length)"
Write-Host "sha256 $hash"

if ($SignKey) {
    python (Join-Path $here "tools\update_signing.py") sign $SignKey $setup $version
    if ($LASTEXITCODE) { throw "signing failed" }
}

