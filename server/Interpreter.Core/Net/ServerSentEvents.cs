using System.Runtime.CompilerServices;
using System.Text;

namespace Interpreter.Core.Net;

/// <summary>Minimal text/event-stream reader for streaming LLM responses (event name plus joined data lines).</summary>
public static class ServerSentEvents
{
    public readonly record struct Event(string? Name, string Data);

    public static async IAsyncEnumerable<Event> ReadAsync(Stream stream, [EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        string? name = null;
        var data = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (data.Length > 0) yield return new Event(name, data.ToString());
                name = null;
                data.Clear();
            }
            else if (line.StartsWith(':'))
            {
                // Comment / heartbeat.
            }
            else if (Field(line, "event") is { } e)
            {
                name = e;
            }
            else if (Field(line, "data") is { } d)
            {
                if (data.Length > 0) data.Append('\n');
                data.Append(d);
            }
        }
        if (data.Length > 0) yield return new Event(name, data.ToString());
    }

    private static string? Field(string line, string field)
    {
        if (!line.StartsWith(field, StringComparison.Ordinal)) return null;
        var rest = line.AsSpan(field.Length);
        if (rest.IsEmpty) return "";
        if (rest[0] != ':') return null;
        rest = rest[1..];
        return (rest.Length > 0 && rest[0] == ' ' ? rest[1..] : rest).ToString();
    }
}
