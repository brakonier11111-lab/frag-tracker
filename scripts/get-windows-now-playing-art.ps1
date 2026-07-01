$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$targetApp = if ($args[0]) { [string]$args[0] } else { 'ru.yandex.desktop.music' }

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $null
foreach ($s in $mgr.GetSessions()) {
    if ([string]$s.SourceAppUserModelId -eq $targetApp) {
        $session = $s
        break
    }
}
if (-not $session) { exit 0 }

$props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail
if (-not $thumb) { exit 0 }

$stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$size = [int64]$stream.Size
if ($size -le 0) { exit 0 }
if ($size -gt 400000) { $size = 400000 }

$reader = [Windows.Storage.Streams.DataReader]::FromStream($stream)
$null = Await ($reader.LoadAsync([uint32]$size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[Convert]::ToBase64String($bytes)
