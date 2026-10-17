using Interpreter.Api.Cascade;
using Interpreter.Providers.ElevenLabs;
using Interpreter.Providers.OpenAI;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Interpreter.Tests.Cascade;

public class CascadeOptionsValidationTests
{
    // The validator is called directly: a host that fails to start can surface as ObjectDisposedException
    // instead of OptionsValidationException when tests run in parallel, which made host-level tests flaky.
    private static readonly CascadeOptionsValidation Validation =
        new(Options.Create(new ElevenLabsOptions()), Options.Create(new OpenAISpeechOptions()));

    private static string Failure(CascadeOptions options)
    {
        var result = Validation.Validate(null, options);
        Assert.True(result.Failed);
        return result.FailureMessage;
    }

    [Fact]
    public void A_voice_that_is_not_a_stock_voice_of_the_active_tts_fails()
    {
        var e = Failure(new CascadeOptions { Voices = new() { ["es"] = "my-cloned-voice" } });

        Assert.Contains("Cascade:Voices:es is my-cloned-voice, which is not in ElevenLabs:StockVoices", e);
    }

    [Fact]
    public void Voices_are_checked_against_the_tts_in_use()
    {
        // An ElevenLabs stock voice is not an OpenAI one.
        var e = Failure(new CascadeOptions { Tts = "openai", Voices = new() { ["es"] = "JBFqnCBsd6RMkjVDRZzb" } });

        Assert.Contains("OpenAI:Speech:StockVoices", e);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void A_session_cap_that_is_not_positive_fails(int seconds)
    {
        var e = Failure(new CascadeOptions { MaxSessionSeconds = seconds });

        Assert.Contains("Cascade:MaxSessionSeconds must be positive", e);
    }

    [Fact]
    public void The_defaults_and_a_stock_voice_pass()
    {
        Assert.True(Validation.Validate(null, new CascadeOptions()).Succeeded);
        Assert.True(Validation.Validate(null, new CascadeOptions { Voices = new() { ["es"] = "EXAVITQu4vr4xnSDxMaL" } }).Succeeded);
    }

    [Fact]
    public void The_server_registers_the_validation_and_checks_on_start()
    {
        using var host = new WebApplicationFactory<Program>();
        using var client = host.CreateClient();

        Assert.Contains(host.Services.GetServices<IValidateOptions<CascadeOptions>>(), v => v is CascadeOptionsValidation);
        Assert.Contains(host.Services.GetServices<IStartupValidator>(), _ => true);
    }
}
