using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Web;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Core.Net;
using Interpreter.Providers.ElevenLabs;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

public class ElevenLabsTtsTests
{
    private static ElevenLabsTts Tts(Uri? baseUrl = null, string? key = "test-key") =>
        new(Options.Create(new ElevenLabsOptions { ApiKey = key, BaseUrl = baseUrl ?? new Uri("wss://api.elevenlabs.io/v1/") }));

    private static async IAsyncEnumerable<string> Text(params string[] chunks)
    {
        foreach (var c in chunks)
        {
            await Task.Yield();
            yield return c;
        }
    }

    private static string Audio(string payload) =>
        new JsonObject { ["audio"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(payload)), ["isFinal"] = null }.ToJsonString();

    [Fact]
    public void Requests_24khz_pcm_from_flash_with_a_stock_voice()
    {
        var uri = Tts().StreamUri(new TtsOptions("es"));
        var query = HttpUtility.ParseQueryString(uri.Query);

        Assert.Equal("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input", uri.AbsolutePath);
        Assert.Equal("eleven_flash_v2_5", query["model_id"]);
        Assert.Equal("pcm_24000", query["output_format"]);
        Assert.Equal("true", query["auto_mode"]);
        Assert.Equal("es", query["language_code"]);
    }

    [Fact]
    public void Refuses_a_voice_that_is_not_a_listed_stock_voice()
    {
        // Guardrail G5: no cloned voices, in particular none made from the live speaker.
        Assert.Throws<ArgumentException>(() => Tts().StreamUri(new TtsOptions("es", Voice: "my-cloned-voice")));
    }

    [Fact]
    public async Task Streams_text_in_and_audio_out()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("Hola"));
            await WebSocketText.SendTextAsync(ws, Audio("pcm-1"), default);
            await s.ReceiveUntil(ws, m => m.Text == """{"text":""}""");
            await WebSocketText.SendTextAsync(ws, Audio("pcm-2"), default);
            await WebSocketText.SendTextAsync(ws, """{"isFinal":true}""", default);
        });

        var chunks = new List<AudioChunk>();
        await foreach (var c in Tts(server.BaseUrl).SynthesizeAsync(Text("Hola,", "  ", "¿cómo está?"), new TtsOptions("es"), TestContext.Current.CancellationToken))
            chunks.Add(c);

        Assert.Equal("pcm-1pcm-2", string.Concat(chunks.Select(c => Encoding.UTF8.GetString(c.Pcm16.Span))));
        Assert.All(chunks, c => Assert.Equal(24000, c.SampleRate));
        Assert.Equal("test-key", server.Headers!["xi-api-key"]);
        Assert.Equal([" ", "Hola, ", "¿cómo está? ", ""], server.Received.Select(m => (string)JsonNode.Parse(m.Text)!["text"]!));
    }

    [Fact]
    public async Task Quota_error_is_rate_limited()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("Hola"));
            await WebSocketText.SendTextAsync(ws, """{"message":"quota","error":"quota_exceeded","code":1008}""", default);
            await s.ReceiveUntil(ws, _ => false);
        });

        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var _ in Tts(server.BaseUrl).SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        });
        Assert.Equal(ProviderErrorKind.RateLimited, e.Kind);
    }

    [Fact]
    public async Task Rejected_key_is_an_auth_error()
    {
        await using var server = await FakeWebSocketServer.StartAsync((_, _) => Task.CompletedTask, rejectWith: 403);

        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var _ in Tts(server.BaseUrl).SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        });
        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
    }

    [Fact]
    public async Task Odd_sized_chunks_are_forwarded_as_whole_samples()
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text == """{"text":""}""");
            await WebSocketText.SendTextAsync(ws, Audio("abc"), default);
            await WebSocketText.SendTextAsync(ws, Audio("d"), default);
            await WebSocketText.SendTextAsync(ws, Audio("efg"), default);
            await WebSocketText.SendTextAsync(ws, """{"isFinal":true}""", default);
        });

        var chunks = new List<AudioChunk>();
        await foreach (var c in Tts(server.BaseUrl).SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken))
            chunks.Add(c);

        Assert.Equal(["ab", "cd", "ef"], chunks.Select(c => Encoding.UTF8.GetString(c.Pcm16.Span)));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"audio":"!!not-base64!!"}""")]
    public async Task An_unreadable_message_ends_the_stream_with_a_provider_error_instead_of_stalling(string message)
    {
        await using var server = await FakeWebSocketServer.StartAsync(async (ws, s) =>
        {
            await s.ReceiveUntil(ws, m => m.Text.Contains("Hola"));
            await WebSocketText.SendTextAsync(ws, message, default);
            await s.ReceiveUntil(ws, _ => false);
        });

        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var _ in Tts(server.BaseUrl).SynthesizeAsync(Text("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        }).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        Assert.Equal((ProviderErrorKind.Unavailable, "elevenlabs"), (e.Kind, e.Provider));
    }
}
