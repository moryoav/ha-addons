param([string]$Image = 'whatsapp-addon:local')

$ErrorActionPreference = 'Stop'
$testDirectory = $PSScriptRoot
$mount = "type=bind,source=$testDirectory,target=/app/voice/test,readonly"

function Invoke-CheckedDocker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Offline Docker validation failed with exit code $LASTEXITCODE" }
}

$common = @('run', '--rm', '--network', 'none', '--mount', $mount)
Invoke-CheckedDocker -Arguments ($common + @('--entrypoint', 'node', $Image, '--test',
    '/app/voice/test/app.test.js', '/app/voice/test/calls.test.js', '/app/voice/test/process.test.js',
    '/app/voice/test/recordings.test.js'))
Invoke-CheckedDocker -Arguments ($common + @('--entrypoint', 'python3', $Image, '-m', 'unittest',
    'discover', '-s', '/app/voice/test', '-p', 'test_configuration.py', '-v'))
foreach ($module in @('test_bridge.py', 'test_call_control.py', 'test_live_simulation.py')) {
    Invoke-CheckedDocker -Arguments ($common + @('--entrypoint', 'python3', $Image, '-m', 'unittest',
        'discover', '-s', '/app/voice/test', '-p', $module, '-v'))
}
Invoke-CheckedDocker -Arguments ($common + @('--entrypoint', 'node', $Image, '/app/voice/test/native-smoke.js'))

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$working = Join-Path $tempRoot ('wa-voice-offline-' + [guid]::NewGuid().ToString('N'))
$containerId = $null
try {
    New-Item -ItemType Directory -Path $working | Out-Null
    $optionsFile = Join-Path $working 'options.json'
    @{ clients=@('default'); log_level='info' } |
        ConvertTo-Json | Set-Content -LiteralPath $optionsFile -Encoding utf8NoBOM
    $start = @('run', '-d', '--network', 'none', '--add-host', 'supervisor:127.0.0.1',
        '--env', 'SUPERVISOR_TOKEN=synthetic-supervisor-token', '--mount', $mount,
        '--mount', "type=bind,source=$optionsFile,target=/data/options.json,readonly",
        '--entrypoint', 'sh', $Image, '-c',
        'node /app/voice/test/supervisor-fixture.js & exec /init /run.sh --offline-simulation')
    $containerId = (& docker @start).Trim()
    if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') {
        throw 'The offline smoke container did not start'
    }
    Invoke-CheckedDocker -Arguments @('exec', $containerId, 'node', '/app/voice/test/packaged-smoke.js')
    Invoke-CheckedDocker -Arguments @('exec', $containerId, '/healthcheck.sh')
    Invoke-CheckedDocker -Arguments @('stop', '--timeout', '10', $containerId)
    $exitCode = & docker inspect $containerId --format '{{.State.ExitCode}}'
    if ($LASTEXITCODE -ne 0 -or $exitCode.Trim() -ne '0') { throw 'The packaged app did not shut down cleanly' }
    Write-Output 'Offline image validation passed, including a clean shutdown.'
} finally {
    if ($containerId -match '^[a-f0-9]{64}$') {
        & docker stop --timeout 10 $containerId | Out-Null
        & docker rm $containerId | Out-Null
    }
    if (Test-Path -LiteralPath $working) {
        $resolved = (Get-Item -LiteralPath $working).FullName
        if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\', '/') -ne $tempRoot -or
            [IO.Path]::GetFileName($resolved) -notmatch '^wa-voice-offline-[a-f0-9]{32}$') {
            throw 'Refusing to remove an unexpected temporary directory'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
