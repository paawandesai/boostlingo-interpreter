using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests;

public class PricesEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Every_price_with_a_value_says_where_and_when_it_was_checked()
    {
        var json = JsonDocument.Parse(await factory.CreateClient().GetStringAsync("/api/prices", TestContext.Current.CancellationToken)).RootElement;

        Assert.Equal("USD", json.GetProperty("currency").GetString());
        foreach (var e in json.GetProperty("entries").EnumerateArray())
        {
            var hasPrice = e.EnumerateObject().Any(p => p.Name.StartsWith("per", StringComparison.Ordinal) || p.Name.EndsWith("PerMTok", StringComparison.Ordinal)
                ? p.Value.ValueKind == JsonValueKind.Number
                : false);
            Assert.False(string.IsNullOrEmpty(e.GetProperty("source").GetString()));
            if (hasPrice) Assert.Equal(JsonValueKind.String, e.GetProperty("checkedOn").ValueKind);
        }
    }
}
