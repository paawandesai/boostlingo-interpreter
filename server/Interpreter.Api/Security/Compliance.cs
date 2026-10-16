using Microsoft.Extensions.Options;

namespace Interpreter.Api.Security;

/// <summary>
/// BAA mode. Code can't sign a Business Associate Agreement or switch on a vendor's retention terms, but it
/// can make sure session content only reaches endpoints those agreements cover. With <see cref="RequireBaa"/>
/// on, every session (Realtime mint, translation mint, cascade socket) is refused unless each route it uses
/// is on the vendor's HIPAA-eligible list and the vendor is named in <see cref="BaaSigned"/>.
/// </summary>
public sealed class ComplianceOptions
{
    public const string Section = "Compliance";

    /// <summary>Off by default: the workbench runs on synthetic data only and has no BAA (README "Known constraints").</summary>
    public bool RequireBaa { get; set; }

    /// <summary>
    /// Vendors this deployment has an executed BAA with, including the retention terms the BAA requires
    /// (OpenAI: Modified Retention; ElevenLabs: Enterprise with Zero Retention Mode). Declared by the operator;
    /// the server can't check a contract.
    /// </summary>
    public List<string> BaaSigned { get; set; } = [];
}

/// <summary>One place session content goes: a mode or a cascade stage, its vendor endpoint, and whether the vendor lists it as HIPAA-eligible.</summary>
/// <param name="Basis">Where eligibility was read, so a reviewer can re-check it.</param>
public sealed record BaaRoute(string Name, string Vendor, string Endpoint, bool Eligible, string Basis);

public static class BaaRoutes
{
    private const string OpenAIList = "OpenAI's HIPAA-eligible products page, read 2026-10-16";

    public static readonly BaaRoute Realtime = new("Realtime", "openai", "/v1/realtime", true, OpenAIList);

    public static readonly BaaRoute RealtimeTranslate = new(
        "Realtime translate", "openai", "/v1/realtime/translations", false, $"not on {OpenAIList}");

    public static BaaRoute Stt(string adapter) => adapter switch
    {
        // The transcription session runs on /v1/realtime (intent=transcription).
        "openai" => new("cascade speech-to-text (openai)", "openai", "/v1/realtime", true, OpenAIList),
        "deepgram" => new("cascade speech-to-text (deepgram)", "deepgram", "/v1/listen", true,
            "Deepgram's data privacy compliance page (BAA on request), read 2026-10-16"),
        _ => Unknown("speech-to-text", adapter),
    };

    public static BaaRoute Translator(string adapter) => adapter switch
    {
        "anthropic" => new("cascade translator (anthropic)", "anthropic", "/v1/messages", true,
            "Anthropic's API and data retention page, feature table, fetched 2026-10-16"),
        // Chat Completions was not on the pages checked; off until someone confirms it.
        "openai" => new("cascade translator (openai)", "openai", "/v1/chat/completions", false,
            "not checked against OpenAI's HIPAA-eligible list"),
        _ => Unknown("translator", adapter),
    };

    public static BaaRoute Tts(string adapter) => adapter switch
    {
        "openai" => new("cascade text-to-speech (openai)", "openai", "/v1/audio/speech", true, OpenAIList),
        // ElevenLabs lists HIPAA eligibility for Enterprise with Zero Retention Mode on its speech-to-text page;
        // nothing checked covers the TTS stream-input socket.
        "elevenlabs" => new("cascade text-to-speech (elevenlabs)", "elevenlabs", "/v1/text-to-speech/{voice}/stream-input", false,
            "not checked for text-to-speech; ElevenLabs offers a BAA on Enterprise only"),
        _ => Unknown("text-to-speech", adapter),
    };

    private static BaaRoute Unknown(string stage, string adapter) =>
        new($"cascade {stage} ({adapter})", adapter, "unknown", false, "no eligibility recorded for this adapter");

    /// <summary>Why <paramref name="route"/> is refused in BAA mode, or null when it may carry session content.</summary>
    public static string? Refusal(this ComplianceOptions o, BaaRoute route)
    {
        if (!o.RequireBaa) return null;
        if (!route.Eligible)
            return $"BAA mode is on: {route.Name} is off because {route.Endpoint} is {route.Basis}.";
        if (!o.BaaSigned.Contains(route.Vendor, StringComparer.OrdinalIgnoreCase))
            return $"BAA mode is on: {route.Name} is off because no BAA with {route.Vendor} is declared in Compliance:BaaSigned.";
        return null;
    }

    /// <summary>The first refusal among a cascade session's three stages, or null when all three may run.</summary>
    public static string? CascadeRefusal(this ComplianceOptions o, string stt, string translator, string tts) =>
        o.Refusal(Stt(stt)) ?? o.Refusal(Translator(translator)) ?? o.Refusal(Tts(tts));

    public static IServiceCollection AddCompliance(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<ComplianceOptions>().Bind(config.GetSection(ComplianceOptions.Section));
        return services;
    }

    /// <summary>Per UI mode, why it is off in BAA mode (absent when it may run), for GET /api/languages.</summary>
    public static Dictionary<string, string> BlockedModes(this ComplianceOptions o, string stt, string translator, string tts)
    {
        var blocked = new Dictionary<string, string>();
        if (o.Refusal(RealtimeTranslate) is { } t) blocked["translate"] = t;
        if (o.Refusal(Realtime) is { } r) blocked["realtime"] = r;
        if (o.CascadeRefusal(stt, translator, tts) is { } c) blocked["cascade"] = c;
        return blocked;
    }
}

/// <summary>Logs at startup when BAA mode is on but the configured cascade defaults can't run under it.</summary>
public sealed class ComplianceStartupCheck(IOptions<ComplianceOptions> compliance, IOptions<Cascade.CascadeOptions> cascade,
    ILogger<ComplianceStartupCheck> log) : IHostedService
{
    public Task StartAsync(CancellationToken ct)
    {
        var o = compliance.Value;
        if (!o.RequireBaa) return Task.CompletedTask;
        var c = cascade.Value;
        log.LogWarning("BAA mode is on; declared BAAs: {Vendors}", o.BaaSigned.Count == 0 ? "none" : string.Join(", ", o.BaaSigned));
        foreach (var (mode, reason) in o.BlockedModes(c.Stt, c.Translator, c.Tts))
            log.LogWarning("BAA mode: {Mode} is unavailable. {Reason}", mode, reason);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
