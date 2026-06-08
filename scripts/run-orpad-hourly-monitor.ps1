$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot '..')
$workspaceRoot = Resolve-Path (Join-Path $repoRoot '..')
$monitorRoot = Join-Path $workspaceRoot '.orpad\monitor'
$monitorScript = Join-Path $scriptRoot 'monitor-orpad-current-run.mjs'
$outLog = Join-Path $monitorRoot 'scheduler.out.log'
$errLog = Join-Path $monitorRoot 'scheduler.err.log'

New-Item -ItemType Directory -Force -Path $monitorRoot | Out-Null
Set-Location $repoRoot

& node $monitorScript --workspace-root $workspaceRoot >> $outLog 2>> $errLog
exit $LASTEXITCODE
