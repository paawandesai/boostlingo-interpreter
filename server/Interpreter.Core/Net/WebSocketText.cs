using System.Buffers;
using System.Net.WebSockets;
using System.Text;

namespace Interpreter.Core.Net;

/// <summary>Small helpers shared by the WebSocket provider adapters and the cascade transport.</summary>
public static class WebSocketText
{
    /// <summary>One received WebSocket message. <see cref="Close"/> is set when the peer closed instead.</summary>
    public readonly record struct Message(WebSocketMessageType Type, ReadOnlyMemory<byte> Data, WebSocketCloseStatus? Close, string? CloseReason)
    {
        public string Text => Encoding.UTF8.GetString(Data.Span);
    }

    /// <summary>Reads one whole message (all fragments). Caps the size so a misbehaving peer can't exhaust memory.</summary>
    public static async Task<Message> ReceiveAsync(WebSocket ws, CancellationToken ct, int maxBytes = 4 * 1024 * 1024)
    {
        var buffer = new ArrayBufferWriter<byte>(8192);
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer.GetMemory(8192), ct);
            if (result.MessageType == WebSocketMessageType.Close)
                return new Message(result.MessageType, default, ws.CloseStatus ?? WebSocketCloseStatus.Empty, ws.CloseStatusDescription);
            buffer.Advance(result.Count);
            if (buffer.WrittenCount > maxBytes)
                throw new WebSocketException(WebSocketError.Faulted, $"Message larger than {maxBytes} bytes");
            if (result.EndOfMessage) return new Message(result.MessageType, buffer.WrittenMemory, null, null);
        }
    }

    public static Task SendTextAsync(WebSocket ws, string text, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);

    /// <summary>Closes politely if the socket is still open; never throws.</summary>
    public static async Task CloseQuietlyAsync(WebSocket ws, string reason = "done")
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, timeout.Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            ws.Abort();
        }
    }
}
