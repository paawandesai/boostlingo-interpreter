using System.Net;
using System.Text.Json;
using Interpreter.Core.Errors;
using Interpreter.Core.Realtime;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Realtime;

public class OpenAIRealtimeSessionMinterTests
{
    private static readonly RealtimeSessionRequest Request = new("en", "es", "INSTRUCTIONS");

    private static OpenAIRealtimeSessionMinter Minter(StubHttpHandler handler, string? apiKey = "test-key") =>
        new(new HttpClient(handler), Options.Create(new OpenAIRealtimeOptions { ApiKey = apiKey }));

    [Fact]
    public async Task Posts_session_config_to_client_secrets_with_server_key()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, """{"value":"ek_abc","expires_at":1760000000,"session":{}}""");

        var secret = await Minter(handler).CreateAsync(Request, CancellationToken.None);

        Assert.Equal("ek_abc", secret.Value);
        Assert.Equal("gpt-realtime-2.1", secret.Model);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1760000000), secret.ExpiresAt);

        var (req, body) = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("https://api.openai.com/v1/realtime/client_secrets", req.RequestUri!.ToString());
        Assert.Equal("Bearer test-key", req.Headers.Authorization!.ToString());

        var session = JsonDocument.Parse(body).RootElement.GetProperty("session");
        Assert.Equal("realtime", session.GetProperty("type").GetString());
        Assert.Equal("gpt-realtime-2.1", session.GetProperty("model").GetString());
        // Guardrail: never the retired beta header or a preview model.
        Assert.False(req.Headers.Contains("OpenAI-Beta"));
        Assert.DoesNotContain("preview", session.GetProperty("model").GetString());
        Assert.Equal("INSTRUCTIONS", session.GetProperty("instructions").GetString());
        var input = session.GetProperty("audio").GetProperty("input");
        Assert.Equal("en", input.GetProperty("transcription").GetProperty("language").GetString());
        Assert.Equal("server_vad", input.GetProperty("turn_detection").GetProperty("type").GetString());
        Assert.False(input.GetProperty("turn_detection").GetProperty("interrupt_response").GetBoolean());
        Assert.Equal("marin", session.GetProperty("audio").GetProperty("output").GetProperty("voice").GetString());
        // G16: the interpreting session has no tools, so an injection can change words but never trigger an action.
        Assert.False(session.TryGetProperty("tools", out _));
        Assert.False(session.TryGetProperty("tool_choice", out _));
        // G19: the shortest practical secret lifetime.
        var expires = JsonDocument.Parse(body).RootElement.GetProperty("expires_after");
        Assert.Equal(60, expires.GetProperty("seconds").GetInt32());
    }

    [Fact]
    public async Task Rate_limit_maps_to_RateLimited_with_retry_after()
    {
        var handler = new StubHttpHandler(_ =>
        {
            var res = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            res.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
            return res;
        });

        var e = await Assert.ThrowsAsync<ProviderException>(() => Minter(handler).CreateAsync(Request, CancellationToken.None));

        Assert.Equal(ProviderErrorKind.RateLimited, e.Kind);
        Assert.Equal(TimeSpan.FromSeconds(7), e.RetryAfter);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, ProviderErrorKind.Auth)]
    [InlineData(HttpStatusCode.GatewayTimeout, ProviderErrorKind.Timeout)]
    [InlineData(HttpStatusCode.InternalServerError, ProviderErrorKind.Unavailable)]
    public async Task Http_errors_map_to_error_kinds(HttpStatusCode status, ProviderErrorKind kind)
    {
        var handler = StubHttpHandler.Json(status, "{}");

        var e = await Assert.ThrowsAsync<ProviderException>(() => Minter(handler).CreateAsync(Request, CancellationToken.None));

        Assert.Equal(kind, e.Kind);
    }

    [Fact]
    public async Task Empty_secret_maps_to_Empty()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, """{"value":"","expires_at":0}""");

        var e = await Assert.ThrowsAsync<ProviderException>(() => Minter(handler).CreateAsync(Request, CancellationToken.None));

        Assert.Equal(ProviderErrorKind.Empty, e.Kind);
    }

    [Fact]
    public async Task Missing_key_fails_before_any_request()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, "{}");

        var e = await Assert.ThrowsAsync<ProviderException>(() => Minter(handler, apiKey: null).CreateAsync(Request, CancellationToken.None));

        Assert.Equal(ProviderErrorKind.Auth, e.Kind);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Client_timeout_maps_to_Timeout()
    {
        var handler = new StubHttpHandler(_ => throw new TaskCanceledException("timeout"));

        var e = await Assert.ThrowsAsync<ProviderException>(() => Minter(handler).CreateAsync(Request, CancellationToken.None));

        Assert.Equal(ProviderErrorKind.Timeout, e.Kind);
    }

    [Fact]
    public async Task Uses_the_requested_model_when_it_is_allowed()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, """{"value":"ek_abc","expires_at":1760000000,"session":{}}""");

        var secret = await Minter(handler).CreateAsync(Request with { Model = "gpt-realtime" }, CancellationToken.None);

        Assert.Equal("gpt-realtime", secret.Model);
        var (_, body) = Assert.Single(handler.Requests);
        Assert.Equal("gpt-realtime", JsonDocument.Parse(body).RootElement.GetProperty("session").GetProperty("model").GetString());
    }

    [Fact]
    public async Task Refuses_a_model_outside_the_allow_list_without_calling_OpenAI()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, "{}");

        await Assert.ThrowsAsync<ArgumentException>(() =>
            Minter(handler).CreateAsync(Request with { Model = "gpt-4o-realtime-preview" }, CancellationToken.None));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Translation_session_takes_only_a_target_language_and_no_instructions_or_tools()
    {
        var handler = StubHttpHandler.Json(HttpStatusCode.OK, """{"value":"ek_tr","expires_at":1760000000,"session":{"type":"translation"}}""");

        var secret = await Minter(handler).CreateTranslationAsync("es", CancellationToken.None);

        Assert.Equal("gpt-realtime-translate", secret.Model);
        var (req, body) = Assert.Single(handler.Requests);
        Assert.Equal("https://api.openai.com/v1/realtime/translations/client_secrets", req.RequestUri!.ToString());
        Assert.Equal("Bearer test-key", req.Headers.Authorization!.ToString());
        var root = JsonDocument.Parse(body).RootElement;
        Assert.Equal(60, root.GetProperty("expires_after").GetProperty("seconds").GetInt32());
        var session = root.GetProperty("session");
        Assert.Equal("gpt-realtime-translate", session.GetProperty("model").GetString());
        Assert.Equal("es", session.GetProperty("audio").GetProperty("output").GetProperty("language").GetString());
        Assert.Equal("gpt-realtime-whisper", session.GetProperty("audio").GetProperty("input").GetProperty("transcription").GetProperty("model").GetString());
        Assert.False(session.TryGetProperty("instructions", out _));
        Assert.False(session.TryGetProperty("tools", out _));
    }
}
