using Microsoft.AspNetCore.Http.Features;

namespace Interpreter.Api.Security;

/// <summary>
/// Endpoint metadata: the largest request body the endpoint accepts. Minimal APIs bind the JSON body before
/// any endpoint filter runs and do not honour MVC's RequestSizeLimitAttribute, so the limit is applied by
/// <see cref="RequestBodyLimit.UseRequestBodyLimits"/>, a middleware that runs before binding.
/// </summary>
public sealed record MaxRequestBodySize(long Bytes);

public static class RequestBodyLimit
{
    public static TBuilder WithMaxRequestBodySize<TBuilder>(this TBuilder builder, long bytes) where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(new MaxRequestBodySize(bytes));

    /// <summary>
    /// Answers 413 when the declared length exceeds the endpoint's limit, and caps an undeclared (chunked)
    /// body at the same size through the server's feature, which Kestrel enforces with the same 413 while the
    /// body is read. So a client can't push a large payload into the mint endpoints ahead of the token check.
    /// </summary>
    public static IApplicationBuilder UseRequestBodyLimits(this IApplicationBuilder app) =>
        app.Use(async (ctx, next) =>
        {
            if (ctx.GetEndpoint()?.Metadata.GetMetadata<MaxRequestBodySize>() is { } limit)
            {
                if (ctx.Request.ContentLength > limit.Bytes)
                {
                    await Results.Problem($"The request body may be at most {limit.Bytes} bytes.",
                        statusCode: StatusCodes.Status413PayloadTooLarge).ExecuteAsync(ctx);
                    return;
                }
                var feature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (feature is { IsReadOnly: false }) feature.MaxRequestBodySize = limit.Bytes;
            }
            await next(ctx);
        });
}
