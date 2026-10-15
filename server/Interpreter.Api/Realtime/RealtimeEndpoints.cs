using Interpreter.Api.Health;
using Interpreter.Api.Security;
using Interpreter.Core.Errors;
using Interpreter.Core.Interpretation;
using Interpreter.Core.Languages;
using Interpreter.Core.Realtime;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

namespace Interpreter.Api.Realtime;

/// <param name="Model">Optional; must be one of GET /api/realtime/models' allowed list.</param>
public sealed record CreateRealtimeSessionRequest(string Source, string Target, string? Model = null, bool Glossary = false);

public sealed record RealtimeModelsResponse(string Default, IReadOnlyList<string> Allowed);

/// <param name="ClientSecret">Ephemeral ek_ secret; the only credential the browser ever sees.</param>
/// <param name="Instructions">Interpreter instructions per direction ("en>es"), so a speaker flip can
/// send session.update without the browser owning the prompt template.</param>
public sealed record CreateRealtimeSessionResponse(
    string ClientSecret,
    DateTimeOffset ExpiresAt,
    string Model,
    string TranscriptionModel,
    string CallsUrl,
    IReadOnlyDictionary<string, string> Instructions,
    int MaxSessionSeconds);

public static class RealtimeEndpoints
{
    /// <summary>WebRTC SDP exchange URL (GA). Verified live 2026-10-14: POST with the ek_ secret returns 201 + SDP answer.</summary>
    public const string CallsUrl = "https://api.openai.com/v1/realtime/calls";

    public static IEndpointRouteBuilder MapRealtimeEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/realtime/models", (IRealtimeSessionMinter minter) =>
            Results.Ok(new RealtimeModelsResponse(minter.DefaultModel, minter.AllowedModels)));
        app.MapPost("/api/realtime/session", CreateSession).RequireAccess();
        return app;
    }

    private static async Task<IResult> CreateSession(
        CreateRealtimeSessionRequest req, LanguageCatalog catalog, Glossary glossary, IRealtimeSessionMinter minter, ProviderActivity activity,
        IOptions<OpenAIRealtimeOptions> realtime, ILoggerFactory logs, CancellationToken ct)
    {
        var source = catalog.Find(req.Source);
        var target = catalog.Find(req.Target);
        if (source is null || target is null || !catalog.IsSupportedDirection(source.Code, target.Code))
            return Results.Problem($"Unsupported language direction {req.Source} -> {req.Target}", statusCode: StatusCodes.Status400BadRequest);

        if (req.Model is { } model && !minter.AllowedModels.Contains(model))
            return Results.Problem($"Model {model} is not allowed", statusCode: StatusCodes.Status400BadRequest);

        var instructions = new Dictionary<string, string>
        {
            // Same glossary block as the cascade translators (T3.7), so the comparison is fair.
            [$"{source.Code}>{target.Code}"] = InterpreterInstructions.Build(source.Name, target.Name,
                req.Glossary ? glossary.For(source.Code, target.Code) : null),
            [$"{target.Code}>{source.Code}"] = InterpreterInstructions.Build(target.Name, source.Name,
                req.Glossary ? glossary.For(target.Code, source.Code) : null),
        };

        try
        {
            var secret = await minter.CreateAsync(
                new RealtimeSessionRequest(source.Code, target.Code, instructions[$"{source.Code}>{target.Code}"], req.Model), ct);
            activity.Success("realtime:openai");
            return Results.Ok(new CreateRealtimeSessionResponse(secret.Value, secret.ExpiresAt, secret.Model, secret.TranscriptionModel, CallsUrl, instructions,
                realtime.Value.MaxSessionSeconds));
        }
        catch (ProviderException e)
        {
            logs.CreateLogger("Realtime").LogWarning("Realtime session mint failed: {Kind} {Message}", e.Kind, e.Message);
            return ProviderProblem(e);
        }
    }

    /// <summary>Maps the provider error contract to HTTP, keeping Kind and Retry-After for the UI's failure states.</summary>
    internal static IResult ProviderProblem(ProviderException e)
    {
        var status = e.Kind switch
        {
            ProviderErrorKind.RateLimited => StatusCodes.Status429TooManyRequests,
            ProviderErrorKind.Timeout => StatusCodes.Status504GatewayTimeout,
            ProviderErrorKind.Auth => StatusCodes.Status503ServiceUnavailable,
            _ => StatusCodes.Status502BadGateway,
        };
        var extensions = new Dictionary<string, object?> { ["kind"] = e.Kind.ToString(), ["provider"] = e.Provider };
        if (e.RetryAfter is { } ra) extensions["retryAfterMs"] = (long)ra.TotalMilliseconds;
        return Results.Problem(e.Message, statusCode: status, extensions: extensions);
    }
}
