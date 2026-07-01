using System.Text;
using Windows.Media.Control;
using Windows.Storage.Streams;

static string TargetApp(string[] args)
{
    foreach (var arg in args)
    {
        if (string.IsNullOrWhiteSpace(arg) || arg.StartsWith('-')) continue;
        return arg.Trim();
    }
    return "ru.yandex.desktop.music";
}

var appId = TargetApp(args);
var mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
GlobalSystemMediaTransportControlsSession? session = null;

foreach (var s in mgr.GetSessions())
{
    if (string.Equals(s.SourceAppUserModelId, appId, StringComparison.OrdinalIgnoreCase))
    {
        session = s;
        break;
    }
}

if (session is null) return 2;

var props = await session.TryGetMediaPropertiesAsync();
if (props.Thumbnail is null) return 3;

using var stream = await props.Thumbnail.OpenReadAsync();
var size = (uint)stream.Size;
if (size == 0 || size > 512_000) return 4;

var reader = new DataReader(stream.GetInputStreamAt(0));
await reader.LoadAsync(size);
var bytes = new byte[size];
reader.ReadBytes(bytes);

var contentType = string.IsNullOrWhiteSpace(stream.ContentType) ? "image/jpeg" : stream.ContentType;
using var stdout = Console.OpenStandardOutput();
stdout.Write(Encoding.UTF8.GetBytes(contentType + "\n"));
stdout.Write(bytes, 0, bytes.Length);
return 0;
