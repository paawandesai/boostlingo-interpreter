using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Interpreter.Core.Configuration;
using Microsoft.AspNetCore.RateLimiting;

namespace Interpreter.Api.Security;

/// <summary>
/// Guards endpoints that spend provider credit (docs/GUARDRAILS.md, Keys and transport: an
/// unauthenticated mint endpoint is a credit drain). Two layers: a shared demo access token, and a
/// per-client rate limit. The token comes from configuration (env DEMO_ACCESS_TOKEN) and is never logged.
/// </summary>
public sealed class AccessOptions
{
    public const string Section = "Access";

    /// <summary>Shared demo token. When unset, guarded endpoints refuse every request.</summary>
    public string? Token { get; set; }

    /// <summary>Guarded requests allowed per client per window.</summary>
    public int PermitLimit { get; set; } = 10;

    public int WindowSeconds { get; set; } = 60;
}

public static class AccessControl
{
    public const string HeaderName = "X-Access-Token";
    public const string RateLimitPolicy = "provider-spend";

    public static IServiceCollection AddAccessControl(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<AccessOptions>()
            .Bind(config.GetSection(AccessOptions.Section))
            .PostConfigure(o =>
            {
                o.Token ??= config["DEMO_ACCESS_TOKEN"];
                // The .env.example placeholder is public, so it counts as no token: the gate refuses (503).
                if (!ConfigValue.IsSet(o.Token)) o.Token = null;
            });

        var opts = config.GetSection(AccessOptions.Section).Get<AccessOptions>() ?? new AccessOptions();
        services.AddRateLimiter(limiter =>
        {
            limiter.AddPolicy(RateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
                http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = opts.PermitLimit,
                    Window = TimeSpan.FromSeconds(opts.WindowSeconds),
                    QueueLimit = 0,
                }));
            limiter.OnRejected = async (ctx, ct) =>
            {
                var retryAfter = ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var ra) ? ra : TimeSpan.FromSeconds(opts.WindowSeconds);
                ctx.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
                ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                await Results.Problem(
                    "Too many session requests from this client. Try again shortly.",
                    statusCode: StatusCodes.Status429TooManyRequests,
                    extensions: new Dictionary<string, object?>
                    {
                        ["kind"] = "RateLimited",
                        ["provider"] = "workbench",
                        ["retryAfterMs"] = (long)retryAfter.TotalMilliseconds,
                    }).ExecuteAsync(ctx.HttpContext);
            };
        });
        return services;
    }

    /// <summary>Requires the demo access token and applies the per-client rate limit.</summary>
    public static TBuilder RequireAccess<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter(CheckToken).RequireRateLimiting(RateLimitPolicy);

    private static async ValueTask<object?> CheckToken(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var expected = ctx.HttpContext.RequestServices.GetRequiredService<Microsoft.Extensions.Options.IOptions<AccessOptions>>().Value.Token;
        if (!ConfigValue.IsSet(expected))
            return Results.Problem("Server access token is not configured. Set DEMO_ACCESS_TOKEN on the server.",
                statusCode: StatusCodes.Status503ServiceUnavailable, extensions: Kind("Auth"));

        var supplied = ctx.HttpContext.Request.Headers[HeaderName].ToString();
        if (!TokensMatch(supplied, expected!))
            return Results.Problem("Missing or wrong access token.", statusCode: StatusCodes.Status401Unauthorized, extensions: Kind("Auth"));

        return await next(ctx);
    }

    internal static bool TokensMatch(string supplied, string expected) =>
        supplied.Length > 0 &&
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(supplied)), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));

    private static Dictionary<string, object?> Kind(string kind) => new() { ["kind"] = kind, ["provider"] = "workbench" };
}
