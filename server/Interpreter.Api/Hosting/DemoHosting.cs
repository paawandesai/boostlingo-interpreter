using Microsoft.AspNetCore.HttpOverrides;

namespace Interpreter.Api.Hosting;

/// <summary>
/// Settings for the public demo deployment (T5, docs/GUARDRAILS.md G14). Local runs leave them unset,
/// so nothing here changes the app outside the demo container, apart from the security response
/// headers in <see cref="DemoHosting.UseDemoHosting"/>, which every run sends.
/// </summary>
public sealed class DemoHostingOptions
{
    public const string Section = "Demo";

    /// <summary>
    /// Proxies in front of the app that append to X-Forwarded-For (the demo has only CloudFront: 1).
    /// The client address is read that many entries from the right, so a client-supplied
    /// X-Forwarded-For can't pick its own rate-limit partition. 0 trusts no header.
    /// </summary>
    public int ForwardLimit { get; set; }

    /// <summary>Folder holding the built SPA (web/dist). Unset means the API serves no pages.</summary>
    public string? SpaPath { get; set; }

    /// <summary>Send X-Robots-Tag: noindex on every response.</summary>
    public bool NoIndex { get; set; }
}

public static class DemoHosting
{
    /// <summary>
    /// Sent on every response: the page takes a typed access token and asks for the microphone, so it must
    /// not be framed or MIME-sniffed, must leak no referrer, and may use the mic only from its own origin.
    /// No Content-Security-Policy: the built SPA's inline script and style needs were not verified, and a
    /// wrong policy would blank the page.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> SecurityHeaders = new Dictionary<string, string>
    {
        ["X-Content-Type-Options"] = "nosniff",
        ["X-Frame-Options"] = "DENY",
        ["Referrer-Policy"] = "no-referrer",
        ["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()",
    };

    public static WebApplication UseDemoHosting(this WebApplication app, IConfiguration config)
    {
        var opts = Options(config);
        app.Use((ctx, next) =>
        {
            foreach (var (name, value) in SecurityHeaders) ctx.Response.Headers[name] = value;
            return next(ctx);
        });
        if (opts.ForwardLimit > 0)
        {
            var fwd = new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
                ForwardLimit = opts.ForwardLimit,
            };
            // The instance only takes traffic from CloudFront (security group), whose addresses are
            // many and change, so the hop count, not an address list, is what limits trust.
            fwd.KnownIPNetworks.Clear();
            fwd.KnownProxies.Clear();
            app.UseForwardedHeaders(fwd);
        }
        if (opts.NoIndex)
        {
            app.Use((ctx, next) =>
            {
                ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
                return next(ctx);
            });
            app.MapGet("/robots.txt", () => Results.Text("User-agent: *\nDisallow: /\n", "text/plain"));
        }
        if (opts.SpaPath is { } path)
        {
            var files = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(Path.GetFullPath(path));
            app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
            app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
        }
        return app;
    }

    /// <summary>Unknown non-API paths get the SPA's index.html.</summary>
    public static WebApplication MapDemoSpa(this WebApplication app, IConfiguration config)
    {
        if (Options(config).SpaPath is { } path)
        {
            var index = Path.Combine(Path.GetFullPath(path), "index.html");
            app.MapFallback("{*path:nonfile}", (HttpContext ctx) =>
                ctx.Request.Path.StartsWithSegments("/api") ? Results.NotFound() : Results.File(index, "text/html"));
        }
        return app;
    }

    private static DemoHostingOptions Options(IConfiguration config) =>
        config.GetSection(DemoHostingOptions.Section).Get<DemoHostingOptions>() ?? new DemoHostingOptions();
}
