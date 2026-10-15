using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Interpreter.Core.Errors;
using Interpreter.Core.Realtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Tests.Realtime;

public class RealtimeEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private sealed class FakeMinter(Func<RealtimeSessionRequest, RealtimeClientSecret> create) : IRealtimeSessionMinter
    {
        public List<RealtimeSessionRequest> Calls { get; } = [];

        public string DefaultModel => "gpt-realtime-2.1";

        public IReadOnlyList<string> AllowedModels => ["gpt-realtime-2.1", "gpt-realtime"];

        public Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct)
        {
            Calls.Add(request);
            return Task.FromResult(create(request));
        }
    }

    private const string Token = "test-access-token";

    private HttpClient Client(IRealtimeSessionMinter minter, string? serverToken = Token, string? clientToken = Token, int permitLimit = 100)
    {
        var client = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("Access:Token", serverToken ?? "");
            b.UseSetting("Access:PermitLimit", permitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture));
            b.ConfigureServices(s => s.AddSingleton(minter));
        }).CreateClient();
        if (clientToken is not null) client.DefaultRequestHeaders.Add("X-Access-Token", clientToken);
        return client;
    }

    private static readonly object EnEs = new { source = "en", target = "es" };

    private static FakeMinter OkMinter() =>
        new(_ => new RealtimeClientSecret("ek_test", DateTimeOffset.UnixEpoch, "gpt-realtime-2.1", "gpt-4o-mini-transcribe"));

    [Fact]
    public async Task Refuses_a_request_without_the_access_token()
    {
        var minter = OkMinter();

        var res = await Client(minter, clientToken: null).PostAsJsonAsync("/api/realtime/session", EnEs, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Empty(minter.Calls);
    }

    [Fact]
    public async Task Refuses_a_wrong_access_token()
    {
        var minter = OkMinter();

        var res = await Client(minter, clientToken: "wrong").PostAsJsonAsync("/api/realtime/session", EnEs, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Empty(minter.Calls);
    }

    [Fact]
    public async Task Refuses_everything_when_the_server_has_no_token_configured()
    {
        var minter = OkMinter();

        var res = await Client(minter, serverToken: null, clientToken: "anything").PostAsJsonAsync("/api/realtime/session", EnEs, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
        Assert.Empty(minter.Calls);
    }

    [Fact]
    public async Task Rate_limits_session_minting_per_client()
    {
        var minter = OkMinter();
        var client = Client(minter, permitLimit: 2);

        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++)
            codes.Add((await client.PostAsJsonAsync("/api/realtime/session", EnEs, TestContext.Current.CancellationToken)).StatusCode);

        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], codes);
        Assert.Equal(2, minter.Calls.Count);
    }

    [Fact]
    public async Task Glossary_goes_into_both_directions_only_when_asked()
    {
        var minter = OkMinter();
        var ct = TestContext.Current.CancellationToken;

        var with = JsonDocument.Parse(await (await Client(minter).PostAsJsonAsync("/api/realtime/session",
            new { source = "en", target = "es", glossary = true }, ct)).Content.ReadAsStringAsync(ct)).RootElement;
        var without = JsonDocument.Parse(await (await Client(minter).PostAsJsonAsync("/api/realtime/session",
            EnEs, ct)).Content.ReadAsStringAsync(ct)).RootElement;

        Assert.Contains("warfarin → warfarina", with.GetProperty("instructions").GetProperty("en>es").GetString());
        Assert.Contains("warfarina → warfarin", with.GetProperty("instructions").GetProperty("es>en").GetString());
        Assert.Contains("warfarin → warfarina", minter.Calls[0].Instructions);
        Assert.DoesNotContain("warfarin", without.GetProperty("instructions").GetProperty("en>es").GetString());
    }

    [Fact]
    public async Task Returns_ephemeral_secret_and_instructions_for_both_directions()
    {
        var minter = new FakeMinter(_ => new RealtimeClientSecret("ek_test", DateTimeOffset.UnixEpoch, "gpt-realtime", "gpt-4o-mini-transcribe"));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "en", target = "es" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;
        Assert.Equal("ek_test", json.GetProperty("clientSecret").GetString());
        Assert.Equal("gpt-4o-mini-transcribe", json.GetProperty("transcriptionModel").GetString());
        Assert.Equal("https://api.openai.com/v1/realtime/calls", json.GetProperty("callsUrl").GetString());
        var instructions = json.GetProperty("instructions");
        Assert.Contains("English", instructions.GetProperty("en>es").GetString());
        Assert.Contains("Spanish", instructions.GetProperty("es>en").GetString());

        var call = Assert.Single(minter.Calls);
        Assert.Equal(("en", "es"), (call.SourceLanguage, call.TargetLanguage));
    }

    [Fact]
    public async Task Rejects_unsupported_direction()
    {
        var minter = new FakeMinter(_ => throw new InvalidOperationException("should not be called"));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "en", target = "fr" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(minter.Calls);
    }

    [Fact]
    public async Task Rate_limit_is_passed_to_the_client_with_kind_and_retry_after()
    {
        var minter = new FakeMinter(_ => throw new ProviderException(
            ProviderErrorKind.RateLimited, "openai-realtime", "rate limited", TimeSpan.FromSeconds(3)));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "es", target = "en" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.TooManyRequests, res.StatusCode);
        var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;
        Assert.Equal("RateLimited", json.GetProperty("kind").GetString());
        Assert.Equal(3000, json.GetProperty("retryAfterMs").GetInt64());
    }

    [Fact]
    public async Task Lists_default_and_allowed_models()
    {
        var json = JsonDocument.Parse(await Client(new FakeMinter(_ => throw new InvalidOperationException()))
            .GetStringAsync("/api/realtime/models", TestContext.Current.CancellationToken)).RootElement;

        Assert.Equal("gpt-realtime-2.1", json.GetProperty("default").GetString());
        Assert.Equal(["gpt-realtime-2.1", "gpt-realtime"], json.GetProperty("allowed").EnumerateArray().Select(e => e.GetString()!));
    }

    [Fact]
    public async Task Rejects_a_model_that_is_not_allowed()
    {
        var minter = new FakeMinter(_ => throw new InvalidOperationException("should not be called"));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "en", target = "es", model = "gpt-4o-realtime-preview" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(minter.Calls);
    }
}
