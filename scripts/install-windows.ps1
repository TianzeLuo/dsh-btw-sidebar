# install-windows.ps1 - install dsh-btw-sidebar into a dsh profile on Windows.
#
# WHY THIS EXISTS
# `dsh plugin --profile <name> add <absolute path>` is unsafe on Windows whenever
# the plugin checkout and $DSH_HOME sit on DIFFERENT DRIVES (checkout on F:, the
# default profile on C:). pnpm records the dependency as `link:F:/...`, and every
# later run that recreates that link resolves the absolute spec as if it were
# RELATIVE, so the junction ends up pointing at
#
#     C:\Users\<you>\.dsh\profiles\web\F:\project\...\dsh-btw-sidebar
#     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ the profile dir glued onto an absolute path
#
# That path does not exist, the package cannot be resolved, `dsh plugin` fails to
# register the bundle and reports it with a misleading warning ("declares no
# dsh.bundle") while still exiting 0 - the plugin silently never loads.
#
# Worse, an already-working install breaks the same way: pnpm stores the link in
# pnpm-lock.yaml as `version: link:F:/...` (it cannot express a cross-drive target
# as a relative path), and the next `pnpm install` - which `dsh plugin add` and
# `dsh plugin install` both run - resolves that entry as a relative path and
# re-creates the broken junction. A profile that works today can therefore lose
# its plugins on the next install command, or `dsh plugin add` can fail outright:
#
#     Error: dsh: cannot resolve profile bundle "..." from the dsh installation or ...
#
# THE FIX USED HERE: a same-drive MIRROR of the checkout.
# A junction living on the profile's drive
#
#     <DSH_HOME>\plugin-mirrors\<pkg>  ->  <plugin checkout on F:>
#
# lets the dependency be recorded as `link:C:/.../plugin-mirrors/<pkg>`, which
# pnpm stores in the lockfile as a plain relative path
# (`version: link:../../plugin-mirrors/<pkg>`) and resolves correctly on every
# later install. Verified with pnpm 10.20.0 under both nodeLinker hoisted and
# isolated. Node follows the junction chain to the real files, so edits in the
# checkout still take effect live - the dev loop is kept.
#
# What this script does:
#   1. creates/repairs the mirror junction for this checkout;
#   2. optionally runs the normal `dsh plugin --profile <name> add <mirror>`;
#   3. repairs EVERY cross-drive `link:` dependency in the profile (not just this
#      package): mirror junction, rewritten spec and re-created node_modules link;
#   4. regenerates pnpm-lock.yaml when it still holds an unresolvable absolute
#      `link:` version, so future installs stay correct;
#   5. registers this package in dsh.profile.bundles when it is missing (dsh drops
#      it whenever the link was broken during an install);
#   6. verifies with `node require.resolve` and `dsh --profile <name> --dump-config`.
#
# THIS FILE MUST STAY PURE ASCII: Windows PowerShell 5.1 reads a .ps1 without a BOM
# using the ANSI code page, so any non-ASCII literal corrupts the parse.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   ... -Profile web
#   ... -SkipInstall      (repair only: never runs `dsh plugin add`)
#   ... -WhatIfOnly       (report what would change, change nothing)

param(
  [string]$Profile = 'web',
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [string]$MirrorRoot = '',
  [switch]$SkipInstall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host $m }
function Step($m) { Write-Host ''; Write-Host ('== ' + $m) }
function Fail($m) { throw $m }

if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'package.json'))) {
  Fail ('not a plugin checkout (no package.json): ' + $PluginDir)
}
$ownManifest = Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
$pkgName = $ownManifest.name
if (-not $pkgName) { Fail ('package.json has no name: ' + $PluginDir) }
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ('profiles\' + $Profile)
$profileManifestPath = Join-Path $profileDir 'package.json'
$projectLockPath = Join-Path $profileDir 'pnpm-lock.yaml'
$virtualLockPath = Join-Path $profileDir 'node_modules\.pnpm\lock.yaml'
if ($MirrorRoot -eq '') { $MirrorRoot = Join-Path $dshHome 'plugin-mirrors' }
$profileRoot = [System.IO.Path]::GetPathRoot($profileDir)

Info ('plugin     : ' + $PluginDir)
Info ('package    : ' + $pkgName)
Info ('dsh home   : ' + $dshHome)
Info ('profile    : ' + $Profile + '  (' + $profileDir + ')')
Info ('mirror root: ' + $MirrorRoot)
if (-not (Test-Path -LiteralPath $profileManifestPath)) {
  Fail ('profile manifest missing: ' + $profileManifestPath)
}

# Write a manifest the way dsh itself does: JSON.stringify(value, undefined, 2).
# PowerShell 5.1's ConvertTo-Json uses its own (ugly) spacing, so normalise with node.
function Write-Manifest([string]$Path, $Value) {
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12))
  # NOTE: the JS below uses SINGLE quotes on purpose. Windows PowerShell 5.1 strips
  # embedded DOUBLE quotes from arguments handed to native commands, which would
  # turn require("fs") into require(fs) and silently break the normalisation.
  $normalise = 'const fs=require(''fs'');const p=process.argv[1];' +
    'fs.writeFileSync(p,JSON.stringify(JSON.parse(fs.readFileSync(p,''utf8'')),null,2)+''\n'')'
  & node -e $normalise $Path
  if ($LASTEXITCODE -ne 0) { Fail ('could not normalise ' + $Path) }
}

# A junction/symlink, or $null for a path that is absent or a real directory.
function Get-ReparsePoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $item }
  return $null
}

# ONLY ever remove a reparse point. Remove-Item -Recurse on a junction in PS 5.1
# follows the link and deletes the TARGET's contents - i.e. the plugin sources.
function Remove-ReparsePoint([string]$Path) {
  $item = Get-ReparsePoint $Path
  if ($null -eq $item) { Fail ('refusing to delete something that is not a link: ' + $Path) }
  [System.IO.Directory]::Delete($Path, $false)
}

# A path on the profile's drive that points at $Source (or $Source itself when the
# drives already match). Created/verified, so the recorded spec always resolves.
function Resolve-Mirror([string]$Source) {
  if ([System.IO.Path]::GetPathRoot($Source) -ieq $profileRoot) { return $Source }
  $mirror = Join-Path $MirrorRoot (Split-Path -Leaf $Source)
  $parent = Split-Path -Parent $mirror
  if (-not (Test-Path -LiteralPath $parent)) {
    if ($WhatIfOnly) { Info ('[whatif] create directory ' + $parent) }
    else { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  }
  $existing = Get-ReparsePoint $mirror
  if ($null -ne $existing) {
    $target = [string]$existing.Target
    if ($target -ieq $Source -and (Test-Path -LiteralPath (Join-Path $mirror 'package.json'))) {
      Info ('mirror ok  : ' + $mirror + ' -> ' + $target)
      return $mirror
    }
    Info ('mirror bad : ' + $mirror + ' -> ' + $target)
    if ($WhatIfOnly) { Info ('[whatif] remove and recreate ' + $mirror) }
    else {
      Remove-ReparsePoint $mirror
      New-Item -ItemType Junction -Path $mirror -Target $Source | Out-Null
    }
  } elseif (Test-Path -LiteralPath $mirror) {
    Fail ('mirror path exists and is not a junction: ' + $mirror + ' - inspect it by hand')
  } elseif ($WhatIfOnly) {
    Info ('[whatif] create junction ' + $mirror + ' -> ' + $Source)
  } else {
    New-Item -ItemType Junction -Path $mirror -Target $Source | Out-Null
  }
  if (-not $WhatIfOnly) {
    Info ('mirror     : ' + $mirror + ' -> ' + [string](Get-Item -LiteralPath $mirror -Force).Target)
  }
  return $mirror
}

# Make node_modules/<name> resolve again, pointing at the mirror. Never follows or
# deletes anything but the link itself.
function Repair-Link([string]$Name, [string]$Target) {
  $link = Join-Path $profileDir ('node_modules\' + $Name)
  if (Test-Path -LiteralPath (Join-Path $link 'package.json')) {
    Info ('link ok    : ' + $Name)
    return
  }
  $existing = Get-ReparsePoint $link
  $seen = if ($null -eq $existing) { 'absent or a real directory' } else { [string]$existing.Target }
  Info ('link BROKEN: ' + $Name + '  (' + $seen + ')')
  if ($WhatIfOnly) { Info ('[whatif] recreate ' + $link + ' -> ' + $Target); return }
  if ($null -ne $existing) { Remove-ReparsePoint $link }
  elseif (Test-Path -LiteralPath $link) { Fail ('not a link, refusing to replace: ' + $link) }
  $parent = Split-Path -Parent $link
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  New-Item -ItemType Junction -Path $link -Target $Target | Out-Null
  Info ('link fixed : ' + $Name + ' -> ' + [string](Get-Item -LiteralPath $link -Force).Target)
}

Step ('1/6 mirror junction for ' + $pkgName)
$mirror = Resolve-Mirror $PluginDir

Step ('2/6 dsh plugin --profile ' + $Profile + ' add')
if ($SkipInstall) { Info 'skipped (-SkipInstall)' }
elseif ($WhatIfOnly) { Info ('[whatif] dsh plugin --profile ' + $Profile + ' add "' + $mirror + '"') }
else {
  & dsh plugin --profile $Profile add $mirror
  # The exit code is deliberately not trusted: dsh exits 0 even when the bundle
  # was not registered. Everything is verified below instead.
}

Step '3/6 cross-drive link: dependencies -> same-drive mirror'
$manifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
$mirrored = @()
$specsChanged = $false
foreach ($dep in @($manifest.dependencies.PSObject.Properties)) {
  $name = $dep.Name
  $spec = [string]$dep.Value
  if ($spec -notmatch '^link:(.+)$') { continue }
  $source = $Matches[1] -replace '/', '\'
  if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
    Info ('skip       : ' + $name + ' (not a checkout: ' + $source + ')')
    continue
  }
  if ([System.IO.Path]::GetPathRoot($source) -ieq $profileRoot) {
    Info ('same drive : ' + $name + ' - nothing to do')
    continue
  }
  $depMirror = Resolve-Mirror $source
  $newSpec = 'link:' + ($depMirror -replace '\\', '/')
  if ($newSpec -ieq $spec) { Info ('spec ok    : ' + $name) }
  else {
    Info ('spec       : ' + $name)
    Info ('             ' + $spec)
    Info ('          -> ' + $newSpec)
    if (-not $WhatIfOnly) { $dep.Value = $newSpec; $specsChanged = $true }
  }
  $mirrored += , @($name, $depMirror)
  Repair-Link $name $depMirror
}
if ($specsChanged) {
  Write-Manifest $profileManifestPath $manifest
  Info ('profile manifest rewritten: ' + $profileManifestPath)
}

Step '4/6 pnpm lockfile'
# An absolute `link:` version is unresolvable on the next install; a lockfile
# written for a same-drive target holds a relative one instead. Regenerate it.
$staleLock = $false
if (Test-Path -LiteralPath $projectLockPath) {
  $lockText = [System.IO.File]::ReadAllText($projectLockPath)
  if ($lockText -match '(?m)^\s+version: link:[A-Za-z]:/') { $staleLock = $true }
}
if ($staleLock) {
  Info 'lockfile holds an absolute link: version -> regenerating'
  if ($WhatIfOnly) { Info '[whatif] delete pnpm-lock.yaml and node_modules\.pnpm\lock.yaml, then pnpm install' }
  else {
    Remove-Item -LiteralPath $projectLockPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $virtualLockPath -Force -ErrorAction SilentlyContinue
    if ($null -eq (Get-Command pnpm -ErrorAction SilentlyContinue)) {
      Info 'pnpm is not on PATH: run  dsh plugin --profile ' + $Profile + ' install  once by hand'
    } else {
      Push-Location $profileDir
      & pnpm install
      Pop-Location
      # pnpm rewrites links from the fresh lockfile; make sure every one resolves.
      foreach ($pair in $mirrored) { Repair-Link $pair[0] $pair[1] }
    }
  }
} else {
  Info 'lockfile is fine (relative link: versions)'
}

Step '5/6 dsh.profile.bundles'
if (-not $WhatIfOnly) { $manifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json }
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
  $bundles = @($manifest.dsh.profile.bundles)
}
Info ('bundles    : ' + ($bundles -join ', '))
$registered = 0
foreach ($dep in @($manifest.dependencies.PSObject.Properties)) {
  $name = $dep.Name
  if ($bundles -contains $name) { continue }
  $depManifestPath = Join-Path $profileDir ('node_modules\' + $name + '\package.json')
  if (-not (Test-Path -LiteralPath $depManifestPath)) {
    Info ('unresolved : ' + $name + ' - cannot read its manifest, not registering')
    continue
  }
  $depManifest = Get-Content -LiteralPath $depManifestPath -Raw | ConvertFrom-Json
  if (-not $depManifest.dsh -or -not $depManifest.dsh.bundle) {
    Info ('plain dep  : ' + $name + ' declares no dsh.bundle, not a profile layer')
    continue
  }
  Info ('register   : ' + $name)
  $bundles = @($bundles) + $name
  $registered++
}
if ($registered -gt 0) {
  if ($WhatIfOnly) { Info '[whatif] append the names above to dsh.profile.bundles' }
  else {
    if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    if (-not $manifest.dsh.profile) {
      $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
    }
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    Write-Manifest $profileManifestPath $manifest
    Info ('written. bundles now: ' + ($bundles -join ', '))
  }
} else {
  Info 'nothing to register'
}

Step '6/6 verify'
if ($WhatIfOnly) {
  Info ('[whatif] node require.resolve("' + $pkgName + '/package.json") from the profile')
  Info ('[whatif] dsh --profile ' + $Profile + ' --dump-config | findstr "' + $pkgName + '"')
} else {
  Push-Location $profileDir
  # Single quotes in the JS again: PS 5.1 drops embedded double quotes in native args.
  $resolveScript = 'try{console.log(require.resolve(process.argv[1]+''/package.json''))}catch(e){console.log(''FAIL ''+e.code)}'
  $resolved = (& node -e $resolveScript $pkgName 2>&1 | Out-String).Trim()
  Pop-Location
  Info ('require.resolve: ' + $resolved)
  if ($resolved -like 'FAIL*') { Fail ('the package still does not resolve from the profile: ' + $pkgName) }

  $dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
  $broken = ($dump -split "`r?`n") | Where-Object { $_ -match ('skipping profile bundle "' + [regex]::Escape($pkgName) + '"') }
  if ($broken) { Fail ($pkgName + ' is still skipped by dsh: ' + ($broken -join ' ')) }
  $entries = ($dump -split "`r?`n") | Where-Object { $_ -match ('^- id: ' + [regex]::Escape($pkgName) + '\s*$') }
  if (-not $entries) { Fail ($pkgName + ' is not in the composed profile tree - install did not succeed') }
  Info ('OK: ' + $pkgName + ' is in the composed profile tree.')
  Info ''
  Info 'Next: restart dsh - a NEW bundle is only picked up at boot (dsh.profile.bundles'
  Info 'is read once), then refresh the browser page so the client half loads too.'
}

Write-Host ''
Write-Host 'DONE'
