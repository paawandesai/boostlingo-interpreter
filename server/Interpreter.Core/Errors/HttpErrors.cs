using System.Net;
using System.Net.Http.Headers;

namespace Interpreter.Core.Errors;

/// <summary>Maps an HTTP failure from a provider to a <see cref="ProviderException"/>, the same way for every adapter.</summary>
public static class HttpErrors
{
    public static ProviderException Map(HttpResponseMessage res, string provider, string what)
    {
        var status = (int)res.StatusCode;
        return res.StatusCode switch
        {
            HttpStatusCode.TooManyRequests => new ProviderException(
                ProviderErrorKind.RateLimited, provider, $"{what} rate limited the request", RetryAfter(res.Headers)),
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ProviderException(
                ProviderErrorKind.Auth, provider, $"{what} rejected the server key (HTTP {status})"),
            HttpStatusCode.RequestTimeout or HttpStatusCode.GatewayTimeout => new ProviderException(
                ProviderErrorKind.Timeout, provider, $"{what} timed out (HTTP {status})"),
            _ => new ProviderException(ProviderErrorKind.Unavailable, provider, $"{what} error (HTTP {status})"),
        };
    }

    private static TimeSpan? RetryAfter(HttpResponseHeaders headers) =>
        headers.RetryAfter?.Delta
        ?? (headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);

    /// <summary>Sends with headers-only completion and maps transport failures.</summary>
    public static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpRequestMessage msg, string provider, string what, CancellationToken ct)
    {
        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(msg, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (TaskCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new ProviderException(ProviderErrorKind.Timeout, provider, $"Timed out calling {what}", inner: e);
        }
        catch (HttpRequestException e)
        {
            throw new ProviderException(ProviderErrorKind.Unavailable, provider, $"Could not reach {what}", inner: e);
        }
        if (res.IsSuccessStatusCode) return res;
        using (res) throw Map(res, provider, what);
    }
}
