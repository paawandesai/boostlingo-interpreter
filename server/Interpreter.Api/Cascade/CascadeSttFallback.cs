using Interpreter.Api.Security;
using Interpreter.Core.Configuration;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Cascade;

/// <summary>
/// Picks a cascade STT adapter that can run: when <c>Cascade:Stt</c> is "deepgram" but no Deepgram key is
/// configured and an OpenAI key is, the OpenAI transcription adapter serves instead, so STT runs without a
/// Deepgram key. This covers STT only: TTS still defaults to ElevenLabs and needs ELEVENLABS_API_KEY unless
/// <c>Cascade:Tts</c> is "openai". Runs for every options instance but warns once per process, and logs setting names
/// only, never a key. /health, /api/cascade/providers and the socket read the same options, so they all
/// report the adapter actually in use.
/// </summary>
public sealed class CascadeSttFallback(
    IOptions<DeepgramOptions> deepgram,
    IOptions<OpenAITranscriptionOptions> openai,
    ILogger<CascadeSttFallback> log) : IPostConfigureOptions<CascadeOptions>
{
    // ConfigureOptions registers this transient, and each options instance runs it, so the flag is per process.
    private static int warned;

    public void PostConfigure(string? name, CascadeOptions options)
    {
        if (options.Stt != "deepgram") return;
        // The .env.example placeholder counts as unset for both keys, as it does in every adapter.
        if (ConfigValue.IsSet(deepgram.Value.ApiKey)) return;
        if (!ConfigValue.IsSet(openai.Value.ApiKey)) return;
        options.Stt = "openai";
        if (Interlocked.Exchange(ref warned, 1) == 1) return;
        log.LogWarning(
            "Cascade:Stt is deepgram but DEEPGRAM_API_KEY is not set; using the openai STT adapter because OPENAI_API_KEY is set. " +
            "Set DEEPGRAM_API_KEY, or Cascade:Stt=openai to choose it explicitly.");
    }
}
