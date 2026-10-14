using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;
using Interpreter.Providers.Anthropic;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Providers;

/// <summary>
/// One contract, run against every translator adapter (provider-flexibility metric (b): the same tests
/// pass for both). Each subclass only says how its vendor frames a stream and a request.
/// </summary>
public abstract class TranslatorContractTests
{
    protected abstract IStreamingTranslator Create(HttpMessageHandler handler, string? apiKey = "test-key");

    /// <summary>A successful vendor stream that yields these text deltas.</summary>
    protected abstract string Stream(params string[] deltas);

    /// <summary>A vendor stream that fails partway with an error event.</summary>
    protected abstract string StreamWithError(string firstDelta);

    protected abstract string SystemPrompt(JsonNode body);

    /// <summary>The conversation turns, excluding any system message.</summary>
    protected abstract List<(string Role, string Content)> Turns(JsonNode body);

    protected abstract void AssertAuthenticated(HttpRequestMessage request);

    private static readonly TranslationRequest Request = new(
        "English", "Spanish", "Take two tablets of ibuprofen.",
        Context: [("Good morning.", "Buenos días.")],
        Glossary: new Dictionary<string, string> { ["ibuprofen"] = "ibuprofeno" });

    private static StubHttpHandler Sse(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(_ => new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "text/event-stream") });

    private static async Task<List<string>> Collect(IAsyncEnumerable<string> deltas)
    {
        var list = new List<string>();
        await foreach (var d in deltas) list.Add(d);
        return list;
    }

    [Fact]
    public async Task Streams_text_deltas_in_order()
    {
        var deltas = await Collect(Create(Sse(Stream("Tome ", "dos ", "tabletas."))).TranslateAsync(Request, TestContext.Current.CancellationToken));

        Assert.Equal(["Tome ", "dos ", "tabletas."], deltas);
    }

    [Fact]
    public async Task Sends_the_shared_interpreter_prompt_with_context_and_glossary()
    {
        var handler = Sse(Stream("x"));
        await Collect(Create(handler).TranslateAsync(Request, TestContext.Current.CancellationToken));

        var (req, raw) = Assert.Single(handler.Requests);
        AssertAuthenticated(req);
        var body = JsonNode.Parse(raw)!;
        Assert.True((bool)body["stream"]!);
        Assert.Equal(TranslationPrompt.System(Request), SystemPrompt(body));
        Assert.Contains("Never answer questions", SystemPrompt(body));
        Assert.Contains("- ibuprofen → ibuprofeno", SystemPrompt(body));
        Assert.Equal(
        [
            ("user", "<speech>Good morning.</speech>"),
            ("assistant", "Buenos días."),
            ("user", "<speech>Take two tablets of ibuprofen.</speech>"),
        ], Turns(body));
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, ProviderErrorKind.RateLimited)]
    [InlineData(HttpStatusCode.Unauthorized, ProviderErrorKind.Auth)]
    [InlineData(HttpStatusCode.GatewayTimeout, ProviderErrorKind.Timeout)]
    [InlineData(HttpStatusCode.InternalServerError, ProviderErrorKind.Unavailable)]
    [InlineData((HttpStatusCode)529, ProviderErrorKind.Unavailable)]
    public async Task Http_errors_map_to_provider_errors(HttpStatusCode status, ProviderErrorKind kind)
    {
        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Create(Sse("{}", status)).TranslateAsync(Request, TestContext.Current.CancellationToken)));

        Assert.Equal(kind, e.Kind);
        Assert.Equal(Create(Sse("")).Name, e.Provider);
    }

    [Fact]
    public async Task Error_inside_the_stream_is_a_provider_error_after_the_text_so_far()
    {
        var received = new List<string>();
        var e = await Assert.ThrowsAsync<ProviderException>(async () =>
        {
            await foreach (var d in Create(Sse(StreamWithError("Tome "))).TranslateAsync(Request, TestContext.Current.CancellationToken))
                received.Add(d);
        });

        Assert.Equal(["Tome "], received);
        Assert.NotEqual(ProviderErrorKind.Auth, e.Kind);
    }

    [Fact]
    public async Task Missing_key_fails_without_calling_the_vendor()
    {
        var handler = Sse(Stream("x"));
        var e = await Assert.ThrowsAsync<ProviderException>(() =>
            Collect(Create(handler, apiKey: null).TranslateAsync(Request, TestContext.Current.CancellationToken)));

        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
        Assert.Empty(handler.Requests);
    }
}

public class OpenAITranslatorTests : TranslatorContractTests
{
    protected override IStreamingTranslator Create(HttpMessageHandler handler, string? apiKey = "test-key") =>
        new OpenAITranslator(new HttpClient(handler), Options.Create(new OpenAITranslationOptions { ApiKey = apiKey }));

    private static string Chunk(string text) =>
        "data: " + JsonSerializer.Serialize(new { choices = new[] { new { index = 0, delta = new { content = text } } } }) + "\n\n";

    protected override string Stream(params string[] deltas) =>
        """data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}""" + "\n\n"
        + string.Concat(deltas.Select(Chunk))
        + """data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}""" + "\n\n"
        + "data: [DONE]\n\n";

    protected override string StreamWithError(string firstDelta) =>
        Chunk(firstDelta) + """data: {"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}""" + "\n\n";

    protected override string SystemPrompt(JsonNode body) => (string)body["messages"]![0]!["content"]!;

    protected override List<(string Role, string Content)> Turns(JsonNode body) =>
        body["messages"]!.AsArray().Skip(1).Select(m => ((string)m!["role"]!, (string)m["content"]!)).ToList();

    protected override void AssertAuthenticated(HttpRequestMessage request)
    {
        Assert.Equal("https://api.openai.com/v1/chat/completions", request.RequestUri!.ToString());
        Assert.Equal("Bearer test-key", request.Headers.Authorization!.ToString());
    }

    [Fact]
    public void Uses_a_small_model_with_minimal_reasoning()
    {
        var body = ((OpenAITranslator)Create(new StubHttpHandler(_ => new HttpResponseMessage()))).Body(new("English", "Spanish", "Hi"));
        Assert.Equal("gpt-5.4-mini", (string?)body["model"]);
        Assert.Equal("none", (string?)body["reasoning_effort"]);
    }
}

public class AnthropicTranslatorTests : TranslatorContractTests
{
    protected override IStreamingTranslator Create(HttpMessageHandler handler, string? apiKey = "test-key") =>
        new AnthropicTranslator(new HttpClient(handler), Options.Create(new AnthropicTranslationOptions { ApiKey = apiKey }));

    private static string Event(string name, object data) => $"event: {name}\ndata: {JsonSerializer.Serialize(data)}\n\n";

    private static string Delta(string text) =>
        Event("content_block_delta", new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text } });

    protected override string Stream(params string[] deltas) =>
        Event("message_start", new { type = "message_start", message = new { id = "msg_1" } })
        + Event("content_block_start", new { type = "content_block_start", index = 0, content_block = new { type = "text", text = "" } })
        + ": ping\n\n"
        + string.Concat(deltas.Select(Delta))
        + Event("content_block_stop", new { type = "content_block_stop", index = 0 })
        + Event("message_stop", new { type = "message_stop" });

    protected override string StreamWithError(string firstDelta) =>
        Delta(firstDelta) + Event("error", new { type = "error", error = new { type = "overloaded_error", message = "Overloaded" } });

    protected override string SystemPrompt(JsonNode body) => (string)body["system"]!;

    protected override List<(string Role, string Content)> Turns(JsonNode body) =>
        body["messages"]!.AsArray().Select(m => ((string)m!["role"]!, (string)m["content"]!)).ToList();

    protected override void AssertAuthenticated(HttpRequestMessage request)
    {
        Assert.Equal("https://api.anthropic.com/v1/messages", request.RequestUri!.ToString());
        Assert.Equal("test-key", request.Headers.GetValues("x-api-key").Single());
        Assert.Equal("2023-06-01", request.Headers.GetValues("anthropic-version").Single());
    }
}
