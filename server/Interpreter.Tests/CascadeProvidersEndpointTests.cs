using System.Net.Http.Json;
using System.Text.Json;
using Interpreter.Api.Health;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests;

public class CascadeProvidersEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string Placeholder = "providers-test-placeholder-value";

    private HttpClient Client(string stt, string deepgramKey, string openaiKey) => factory.WithWebHostBuilder(b =>
    {
        b.UseSetting("Cascade:Stt", stt);
        b.UseSetting("DEEPGRAM_API_KEY", deepgramKey);
        b.UseSetting("OPENAI_API_KEY", openaiKey);
    }).CreateClient();

    [Fact]
    public async Task Names_the_configured_cascade_vendors_without_keys()
    {
        var body = await Client("deepgram", Placeholder, Placeholder).GetStringAsync("/api/cascade/providers", TestContext.Current.CancellationToken);
        var json = JsonDocument.Parse(body).RootElement;

        Assert.Equal("deepgram", json.GetProperty("stt").GetString());
        Assert.Equal("openai", json.GetProperty("translator").GetString());
        Assert.Equal("elevenlabs", json.GetProperty("tts").GetString());
        Assert.DoesNotContain("key", body, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("deepgram", "", Placeholder, "openai")] // no Deepgram key, an OpenAI key: the openai adapter serves
    [InlineData("deepgram", Placeholder, Placeholder, "deepgram")]
    [InlineData("deepgram", "", "", "deepgram")] // nothing to fall back to: the session reports the missing key
    [InlineData("openai", "", Placeholder, "openai")]
    public async Task Falls_back_to_openai_stt_only_when_deepgram_has_no_key_and_openai_does(
        string configured, string deepgramKey, string openaiKey, string expected)
    {
        var client = Client(configured, deepgramKey, openaiKey);
        var ct = TestContext.Current.CancellationToken;

        var providers = JsonDocument.Parse(await client.GetStringAsync("/api/cascade/providers", ct)).RootElement;
        var health = await client.GetFromJsonAsync<HealthResponse>("/health", ct);

        Assert.Equal(expected, providers.GetProperty("stt").GetString());
        Assert.Equal(expected, health!.Config!.CascadeStt);
    }
}
