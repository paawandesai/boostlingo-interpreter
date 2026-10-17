using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Cascade;

public class CascadeOptionsValidationTests
{
    /// <summary>A fresh host per test: a host that failed to start is not reused.</summary>
    private static WebApplicationFactory<Program> Host(params (string Key, string Value)[] settings) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            foreach (var (key, value) in settings) b.UseSetting(key, value);
        });

    private static OptionsValidationException StartWith(params (string Key, string Value)[] settings)
    {
        using var host = Host(settings);
        return Assert.Throws<OptionsValidationException>(() => host.CreateClient());
    }

    [Fact]
    public void A_voice_that_is_not_a_stock_voice_of_the_active_tts_stops_startup()
    {
        var e = StartWith(("Cascade:Voices:es", "my-cloned-voice"));

        Assert.Contains("Cascade:Voices:es is my-cloned-voice, which is not in ElevenLabs:StockVoices", e.Message);
    }

    [Fact]
    public void Voices_are_checked_against_the_tts_in_use()
    {
        // An ElevenLabs stock voice is not an OpenAI one.
        var e = StartWith(("Cascade:Tts", "openai"), ("Cascade:Voices:es", "JBFqnCBsd6RMkjVDRZzb"));

        Assert.Contains("OpenAI:Speech:StockVoices", e.Message);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("0")]
    public void A_session_cap_that_is_not_positive_stops_startup(string seconds)
    {
        var e = StartWith(("Cascade:MaxSessionSeconds", seconds));

        Assert.Contains("Cascade:MaxSessionSeconds must be positive", e.Message);
    }

    [Fact]
    public void A_stock_voice_starts()
    {
        using var host = Host(("Cascade:Voices:es", "EXAVITQu4vr4xnSDxMaL"));
        using var client = host.CreateClient();
    }
}
