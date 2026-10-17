using Interpreter.Api.Security;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Cascade;

/// <summary>
/// Picks a cascade STT adapter that can run: when <c>Cascade:Stt</c> is "deepgram" but no Deepgram key is
/// configured and an OpenAI key is, the OpenAI transcription adapter serves instead, so a setup with only
/// OPENAI_API_KEY works out of the box. Runs once, when the options are first read, and logs setting names
/// only, never a key. /health, /api/cascade/providers and the socket read the same options, so they all
/// report the adapter actually in use.
/// </summary>
public sealed class CascadeSttFallback(
    IOptions<DeepgramOptions> deepgram,
    IOptions<OpenAITranscriptionOptions> openai,
    ILogger<CascadeSttFallback> log) : IPostConfigureOptions<CascadeOptions>
{
    public void PostConfigure(string? name, CascadeOptions options)
    {
        if (options.Stt != "deepgram") return;
        // The .env.example placeholder counts as unset, so copying the file unchanged still runs.
        if (ConfigValue.IsSet(deepgram.Value.ApiKey)) return;
        if (string.IsNullOrWhiteSpace(openai.Value.ApiKey)) return;
        options.Stt = "openai";
        log.LogWarning(
            "Cascade:Stt is deepgram but DEEPGRAM_API_KEY is not set; using the openai STT adapter because OPENAI_API_KEY is set. " +
            "Set DEEPGRAM_API_KEY, or Cascade:Stt=openai to choose it explicitly.");
    }
}
