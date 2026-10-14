using System.Collections.Concurrent;
using System.Net.WebSockets;
using Interpreter.Core.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Interpreter.Tests.Providers;

/// <summary>
/// A real Kestrel WebSocket server on localhost, standing in for a provider so adapters are tested through
/// their actual ClientWebSocket code. The script decides what the "provider" sends back.
/// </summary>
internal sealed class FakeWebSocketServer : IAsyncDisposable
{
    private readonly WebApplication _app;

    public ConcurrentQueue<WebSocketText.Message> Received { get; } = new();
    public string? Query { get; private set; }
    public string? Authorization { get; private set; }
    public Uri BaseUrl { get; private set; } = null!;

    private FakeWebSocketServer(WebApplication app) => _app = app;

    /// <param name="script">Runs once the socket is accepted. Return to close the socket normally.</param>
    /// <param name="rejectWith">If set, answer the upgrade with this HTTP status instead.</param>
    public static async Task<FakeWebSocketServer> StartAsync(
        Func<WebSocket, FakeWebSocketServer, Task> script, int? rejectWith = null)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var app = builder.Build();
        var server = new FakeWebSocketServer(app);
        app.UseWebSockets();
        app.Run(async ctx =>
        {
            server.Query = ctx.Request.QueryString.Value;
            server.Authorization = ctx.Request.Headers.Authorization.ToString();
            if (rejectWith is { } status || !ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = rejectWith ?? 400;
                return;
            }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            await script(ws, server);
            await WebSocketText.CloseQuietlyAsync(ws);
        });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        server.BaseUrl = new Uri(address.Replace("http://", "ws://") + "/v1/");
        return server;
    }

    /// <summary>Reads client messages into <see cref="Received"/> until one matches.</summary>
    public async Task<WebSocketText.Message> ReceiveUntil(WebSocket ws, Func<WebSocketText.Message, bool> match)
    {
        while (true)
        {
            var msg = await WebSocketText.ReceiveAsync(ws, CancellationToken.None);
            // Copy: the buffer is reused by the next receive.
            msg = msg with { Data = msg.Data.ToArray() };
            Received.Enqueue(msg);
            if (match(msg) || msg.Close is not null) return msg;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}
