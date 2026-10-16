using System.Net;
using System.Net.Http.Json;
using Interpreter.Api.Health;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests;

public class HealthEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Health_returns_ok()
    {
        var client = factory.CreateClient();

        var response = await client.GetAsync("/health", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<HealthResponse>(TestContext.Current.CancellationToken);
        Assert.Equal("ok", body?.Status);
    }

    [Fact]
    public async Task Health_reports_configuration_as_booleans_and_no_key_material()
    {
        const string fakeKey = "health-test-placeholder-value";
        var client = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("OPENAI_API_KEY", fakeKey);
            b.UseSetting("DEEPGRAM_API_KEY", "");
            b.UseSetting("Access:Token", "t");
        }).CreateClient();

        var raw = await client.GetStringAsync("/health", TestContext.Current.CancellationToken);
        var body = System.Text.Json.JsonSerializer.Deserialize<HealthResponse>(raw, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        Assert.DoesNotContain(fakeKey, raw);
        Assert.DoesNotContain("sk-", raw);
        Assert.True(body.Config!.AccessTokenSet);
        Assert.True(body.Config.Keys["OPENAI_API_KEY"]);
        Assert.False(body.Config.Keys["DEEPGRAM_API_KEY"]);
        // The default STT is deepgram, but with no Deepgram key and an OpenAI key the openai adapter serves.
        Assert.Equal("openai", body.Config.CascadeStt);
        // Deepgram is not in use, so its key is not missing; the keys of the adapters in use that are unset are.
        Assert.DoesNotContain("DEEPGRAM_API_KEY", body.Config.Missing);
        Assert.All(body.Config.Missing, k => Assert.False(body.Config.Keys[k]));
    }

    [Fact]
    public async Task Health_lists_only_the_unset_keys_the_configured_adapters_need()
    {
        var client = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("OPENAI_API_KEY", "health-test-placeholder-value");
            b.UseSetting("DEEPGRAM_API_KEY", "");
            b.UseSetting("ELEVENLABS_API_KEY", "");
            b.UseSetting("CLAUDE_TRANSLATOR_API_KEY", "");
            b.UseSetting("Cascade:Stt", "openai");
            b.UseSetting("Cascade:Translator", "anthropic");
            b.UseSetting("Cascade:Tts", "elevenlabs");
        }).CreateClient();

        var body = await client.GetFromJsonAsync<HealthResponse>("/health", TestContext.Current.CancellationToken);

        Assert.Equal(["CLAUDE_TRANSLATOR_API_KEY", "ELEVENLABS_API_KEY"], body!.Config!.Missing);
    }

    [Fact]
    public void Provider_activity_keeps_the_latest_success_per_provider()
    {
        var time = new ManualTime(new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero));
        var activity = new ProviderActivity(time);
        activity.Success("tts:elevenlabs");
        time.Now = time.Now.AddMinutes(1);
        activity.Success("tts:elevenlabs");

        Assert.Equal(time.Now, Assert.Single(activity.Snapshot()).Value);
    }

    private sealed class ManualTime(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
