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

        public Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct)
        {
            Calls.Add(request);
            return Task.FromResult(create(request));
        }
    }

    private HttpClient Client(IRealtimeSessionMinter minter) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton(minter))).CreateClient();

    [Fact]
    public async Task Returns_ephemeral_secret_and_instructions_for_both_directions()
    {
        var minter = new FakeMinter(_ => new RealtimeClientSecret("ek_test", DateTimeOffset.UnixEpoch, "gpt-realtime", "gpt-4o-mini-transcribe"));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "en", target = "es" });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
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

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "en", target = "fr" });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(minter.Calls);
    }

    [Fact]
    public async Task Rate_limit_is_passed_to_the_client_with_kind_and_retry_after()
    {
        var minter = new FakeMinter(_ => throw new ProviderException(
            ProviderErrorKind.RateLimited, "openai-realtime", "rate limited", TimeSpan.FromSeconds(3)));

        var res = await Client(minter).PostAsJsonAsync("/api/realtime/session", new { source = "es", target = "en" });

        Assert.Equal(HttpStatusCode.TooManyRequests, res.StatusCode);
        var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("RateLimited", json.GetProperty("kind").GetString());
        Assert.Equal(3000, json.GetProperty("retryAfterMs").GetInt64());
    }
}
