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

    [Fact]
    public async Task Every_language_carries_output_checks_and_the_canary_is_served()
    {
        // G15: the client checks every output segment in both modes against these.
        var json = JsonDocument.Parse(await factory.CreateClient().GetStringAsync("/api/languages", TestContext.Current.CancellationToken)).RootElement;

        Assert.All(json.GetProperty("languages").EnumerateArray(), l =>
        {
            var c = l.GetProperty("outputChecks");
            Assert.True(c.GetProperty("markers").GetArrayLength() >= 10);
            Assert.True(c.GetProperty("assistantPatterns").GetArrayLength() > 0);
            Assert.True(c.GetProperty("refusalPatterns").GetArrayLength() > 0);
        });
        Assert.Equal(Interpreter.Core.Interpretation.InterpreterInstructions.Canary, json.GetProperty("canary").GetString());
    }
}
