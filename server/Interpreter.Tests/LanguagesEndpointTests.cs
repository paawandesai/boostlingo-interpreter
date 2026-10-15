using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests;

public class LanguagesEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Lists_configured_languages_and_pairs()
    {
        var json = JsonDocument.Parse(await factory.CreateClient().GetStringAsync("/api/languages", TestContext.Current.CancellationToken)).RootElement;

        var codes = json.GetProperty("languages").EnumerateArray().Select(l => l.GetProperty("code").GetString()).ToList();
        Assert.Contains("en", codes);
        Assert.Contains("es", codes);
        Assert.Contains(json.GetProperty("pairs").EnumerateArray(), p => p[0].GetString() == "en" && p[1].GetString() == "es");
    }

    [Fact]
    public async Task Every_language_carries_an_ai_disclosure()
    {
        // G7: the consent step needs the notice in each party's language before the mic opens.
        var json = JsonDocument.Parse(await factory.CreateClient().GetStringAsync("/api/languages", TestContext.Current.CancellationToken)).RootElement;

        Assert.All(json.GetProperty("languages").EnumerateArray(), l =>
        {
            var d = l.GetProperty("disclosure");
            Assert.False(string.IsNullOrWhiteSpace(d.GetProperty("notice").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(d.GetProperty("spoken").GetString()));
        });
    }
}
