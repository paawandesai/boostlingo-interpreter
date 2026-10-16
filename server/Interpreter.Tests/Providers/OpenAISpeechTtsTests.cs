using System.Net;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

public class OpenAISpeechTtsTests
{
    private static OpenAISpeechTts Tts(StubHttpHandler handler, string? key = "test-placeholder") =>
        new(new HttpClient(handler), Options.Create(new OpenAISpeechOptions { ApiKey = key }));

    private static async IAsyncEnumerable<string> Texts(params string[] texts)
    {
        foreach (var t in texts)
        {
            await Task.Yield();
            yield return t;
        }
    }

    /// <summary>Returns the body in pieces of the given sizes, so reads can end mid-sample.</summary>
    private sealed class ChunkedStream(byte[] data, int piece) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
            base.ReadAsync(buffer[..Math.Min(piece, buffer.Length)], ct);
    }

    /// <summary>Returns <paramref name="before"/> bytes, then fails the next read as a dropped connection would.</summary>
    private sealed class FailingStream(int before) : MemoryStream(new byte[before])
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            var read = await base.ReadAsync(buffer, ct);
            return read > 0 ? read : throw new IOException("The response ended prematurely.");
        }
    }

    [Fact]
    public void Asks_for_24khz_pcm_from_a_stock_voice()
    {
        var body = Tts(StubHttpHandler.Json(HttpStatusCode.OK, "")).Body("Hola.", new TtsOptions("es"));

        Assert.Equal(("gpt-4o-mini-tts", "alloy", "Hola.", "pcm"),
            ((string?)body["model"], (string?)body["voice"], (string?)body["input"], (string?)body["response_format"]));
    }

    [Fact]
    public async Task Refuses_a_voice_that_is_not_on_the_stock_list()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, "");

        await Assert.ThrowsAsync<ArgumentException>(async () =>
        {
            await foreach (var _ in Tts(handler).SynthesizeAsync(Texts("Hola."), new TtsOptions("es", "my-clone"), TestContext.Current.CancellationToken)) { }
        });
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Sends_one_request_per_phrase_and_yields_whole_samples()
    {
        var pcm = Enumerable.Range(0, 10).Select(i => (byte)i).ToArray();
        var handler = new StubHttpHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new ChunkedStream(pcm, 3)) });

        var chunks = new List<AudioChunk>();
        await foreach (var c in Tts(handler).SynthesizeAsync(Texts("Hola.", " ", "Adiós."), new TtsOptions("es"), TestContext.Current.CancellationToken))
            chunks.Add(c);

        Assert.Equal(2, handler.Requests.Count);
        Assert.EndsWith("/v1/audio/speech", handler.Requests[0].Request.RequestUri!.AbsolutePath);
        Assert.Equal("Adiós.", (string?)JsonNode.Parse(handler.Requests[1].Body)!["input"]);
        Assert.All(chunks, c => Assert.True(c.Pcm16.Length % 2 == 0 && c.SampleRate == 24000));
        Assert.Equal(pcm.Concat(pcm), chunks.SelectMany(c => c.Pcm16.ToArray()));
    }

    [Fact]
    public async Task Maps_a_rejected_key_to_an_auth_error()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.Unauthorized, """{"error":{}}""");

        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var _ in Tts(handler).SynthesizeAsync(Texts("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken)) { }
        });

        Assert.Equal((ProviderErrorKind.Auth, "openai-tts"), (e.Kind, e.Provider));
    }

    [Fact]
    public async Task Maps_a_failed_read_mid_stream_to_an_unavailable_error()
    {
        var handler = new StubHttpHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new FailingStream(4)) });

        var chunks = new List<AudioChunk>();
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var c in Tts(handler).SynthesizeAsync(Texts("Hola."), new TtsOptions("es"), TestContext.Current.CancellationToken))
                chunks.Add(c);
        });

        Assert.Equal((ProviderErrorKind.Unavailable, "openai-tts"), (e.Kind, e.Provider));
        Assert.IsType<IOException>(e.InnerException);
        Assert.Equal(4, chunks.Sum(c => c.Pcm16.Length));
    }
}
