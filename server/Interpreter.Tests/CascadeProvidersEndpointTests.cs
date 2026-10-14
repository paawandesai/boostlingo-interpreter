using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests;

public class CascadeProvidersEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Names_the_configured_cascade_vendors_without_keys()
    {
        var body = await factory.CreateClient().GetStringAsync("/api/cascade/providers", TestContext.Current.CancellationToken);
        var json = JsonDocument.Parse(body).RootElement;

        Assert.Equal("deepgram", json.GetProperty("stt").GetString());
        Assert.Equal("openai", json.GetProperty("translator").GetString());
        Assert.Equal("elevenlabs", json.GetProperty("tts").GetString());
        Assert.DoesNotContain("key", body, StringComparison.OrdinalIgnoreCase);
    }
}
