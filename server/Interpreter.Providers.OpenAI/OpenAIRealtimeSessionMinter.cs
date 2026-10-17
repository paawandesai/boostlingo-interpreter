using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Interpreter.Core.Configuration;
using Interpreter.Core.Errors;
using Interpreter.Core.Realtime;
using Microsoft.Extensions.Options;

namespace Interpreter.Providers.OpenAI;

/// <summary>Mints ephemeral Realtime client secrets (ek_...) with the interpreter session config baked in.</summary>
public sealed class OpenAIRealtimeSessionMinter(HttpClient http, IOptions<OpenAIRealtimeOptions> options) : IRealtimeSessionMinter
{
    private const string Provider = "openai-realtime";
    private readonly OpenAIRealtimeOptions _opts = options.Value;

    public string DefaultModel => _opts.Model;

    public IReadOnlyList<string> AllowedModels =>
        _opts.AllowedModels.Contains(_opts.Model) ? _opts.AllowedModels : [_opts.Model, .. _opts.AllowedModels];

    public string TranslateModel => _opts.TranslateModel;

    public async Task<RealtimeClientSecret> CreateAsync(RealtimeSessionRequest request, CancellationToken ct)
    {
        var model = request.Model ?? _opts.Model;
        if (!AllowedModels.Contains(model))
            throw new ArgumentException($"Model {model} is not in OpenAI:Realtime:AllowedModels", nameof(request));
        return await MintAsync("realtime/client_secrets", BuildBody(request, model), model, _opts.TranscriptionModel, ct);
    }

    public Task<RealtimeClientSecret> CreateTranslationAsync(string targetLanguage, CancellationToken ct) =>
        MintAsync("realtime/translations/client_secrets", BuildTranslationBody(targetLanguage),
            _opts.TranslateModel, _opts.TranslateTranscriptionModel, ct);

    private async Task<RealtimeClientSecret> MintAsync(string path, object body, string model, string transcriptionModel, CancellationToken ct)
    {
        if (!ConfigValue.IsSet(_opts.ApiKey))
            throw new ProviderException(ProviderErrorKind.Auth, Provider, "OPENAI_API_KEY is not configured on the server");

        using var msg = new HttpRequestMessage(HttpMethod.Post, new Uri(_opts.BaseUrl, path))
        {
            Content = JsonContent.Create(body, options: JsonOptions),
        };
        msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _opts.ApiKey);

        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(msg, ct);
        }
        catch (TaskCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new ProviderException(ProviderErrorKind.Timeout, Provider, "Timed out creating a Realtime session", inner: e);
        }
        catch (HttpRequestException e)
        {
            throw new ProviderException(ProviderErrorKind.Unavailable, Provider, "Could not reach the Realtime API", inner: e);
        }

        using (res)
        {
            if (!res.IsSuccessStatusCode) throw MapError(res);
            var secret = await res.Content.ReadFromJsonAsync<ClientSecretResponse>(JsonOptions, ct);
            if (secret is null || string.IsNullOrEmpty(secret.Value))
                throw new ProviderException(ProviderErrorKind.Empty, Provider, "Realtime API returned no client secret");
            return new RealtimeClientSecret(secret.Value, DateTimeOffset.FromUnixTimeSeconds(secret.ExpiresAt), model, transcriptionModel);
        }
    }

    private object BuildBody(RealtimeSessionRequest r, string model) => new
    {
        expires_after = new { anchor = "created_at", seconds = _opts.SecretTtlSeconds },
        session = new
        {
            type = "realtime",
            model,
            instructions = r.Instructions,
            output_modalities = new[] { "audio" },
            audio = new
            {
                input = new
                {
                    transcription = new { model = _opts.TranscriptionModel, language = r.SourceLanguage },
                    noise_reduction = new { type = "near_field" },
                    turn_detection = _opts.ClientEndpointing
                        ? null
                        : new
                        {
                            type = "server_vad",
                            silence_duration_ms = _opts.SilenceDurationMs,
                            create_response = true,
                            // Half-duplex (D13): the mic is gated while the interpreter speaks, so no barge-in.
                            interrupt_response = false,
                        },
                },
                output = new { voice = _opts.Voice },
            },
        },
    };

    /// <summary>
    /// Translation session (G17): the only settings are the target language, the source transcript model and
    /// noise reduction. Source language is detected by the model.
    /// </summary>
    private object BuildTranslationBody(string targetLanguage) => new
    {
        expires_after = new { anchor = "created_at", seconds = _opts.SecretTtlSeconds },
        session = new
        {
            model = _opts.TranslateModel,
            audio = new
            {
                input = new
                {
                    transcription = new { model = _opts.TranslateTranscriptionModel },
                    noise_reduction = new { type = "near_field" },
                },
                output = new { language = targetLanguage },
            },
        },
    };

    private static ProviderException MapError(HttpResponseMessage res)
    {
        var status = (int)res.StatusCode;
        return res.StatusCode switch
        {
            HttpStatusCode.TooManyRequests => new ProviderException(
                ProviderErrorKind.RateLimited, Provider, "Realtime API rate limited the request", RetryAfter(res.Headers)),
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ProviderException(
                ProviderErrorKind.Auth, Provider, $"Realtime API rejected the server key (HTTP {status})"),
            HttpStatusCode.RequestTimeout or HttpStatusCode.GatewayTimeout => new ProviderException(
                ProviderErrorKind.Timeout, Provider, $"Realtime API timed out (HTTP {status})"),
            _ => new ProviderException(ProviderErrorKind.Unavailable, Provider, $"Realtime API error (HTTP {status})"),
        };
    }

    private static TimeSpan? RetryAfter(HttpResponseHeaders headers) =>
        headers.RetryAfter?.Delta
        ?? (headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record ClientSecretResponse(
        [property: JsonPropertyName("value")] string Value,
        [property: JsonPropertyName("expires_at")] long ExpiresAt);
}
