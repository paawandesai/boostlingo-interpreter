using Interpreter.Api.Security;

namespace Interpreter.Tests.Security;

public class ComplianceTests
{
    private static ComplianceOptions Baa(params string[] signed) => new() { RequireBaa = true, BaaSigned = [.. signed] };

    [Fact]
    public void Nothing_is_refused_when_baa_mode_is_off()
    {
        var off = new ComplianceOptions();

        Assert.Null(off.Refusal(BaaRoutes.RealtimeTranslate));
        Assert.Null(off.CascadeRefusal("deepgram", "openai", "elevenlabs"));
        Assert.Empty(off.BlockedModes("deepgram", "openai", "elevenlabs"));
    }

    [Fact]
    public void Realtime_translate_is_refused_even_with_an_openai_baa()
    {
        Assert.Contains("/v1/realtime/translations", Baa("openai").Refusal(BaaRoutes.RealtimeTranslate));
    }

    [Fact]
    public void An_eligible_route_still_needs_its_vendor_declared()
    {
        Assert.Contains("no BAA with openai", Baa("anthropic").Refusal(BaaRoutes.Realtime));
        Assert.Null(Baa("OpenAI").Refusal(BaaRoutes.Realtime));
    }

    [Fact]
    public void The_covered_cascade_is_openai_stt_anthropic_translator_openai_tts()
    {
        var o = Baa("openai", "anthropic");

        Assert.Null(o.CascadeRefusal("openai", "anthropic", "openai"));
        Assert.Contains("/v1/chat/completions", o.CascadeRefusal("openai", "openai", "openai"));
        Assert.Contains("elevenlabs", o.CascadeRefusal("openai", "anthropic", "elevenlabs"));
        Assert.Contains("no eligibility recorded", o.CascadeRefusal("openai", "anthropic", "someone-new"));
    }

    [Fact]
    public void Deepgram_stt_is_allowed_only_with_a_deepgram_baa()
    {
        Assert.Contains("no BAA with deepgram", Baa("openai", "anthropic").CascadeRefusal("deepgram", "anthropic", "openai"));
        Assert.Null(Baa("openai", "anthropic", "deepgram").CascadeRefusal("deepgram", "anthropic", "openai"));
    }

    [Fact]
    public void Blocked_modes_name_each_mode_that_cannot_run()
    {
        var blocked = Baa("openai", "anthropic").BlockedModes("deepgram", "openai", "elevenlabs");

        Assert.Equal(["cascade", "translate"], blocked.Keys.Order());
    }
}
