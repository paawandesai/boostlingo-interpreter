using Interpreter.Core.Cascade;
using Interpreter.Core.Realtime;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Providers.OpenAI;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddOpenAIRealtime(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<OpenAIRealtimeOptions>()
            .Bind(config.GetSection(OpenAIRealtimeOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["OPENAI_API_KEY"]);
        services.AddHttpClient<IRealtimeSessionMinter, OpenAIRealtimeSessionMinter>(c => c.Timeout = TimeSpan.FromSeconds(10));
        return services;
    }

    public static IServiceCollection AddOpenAIStt(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<OpenAITranscriptionOptions>()
            .Bind(config.GetSection(OpenAITranscriptionOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["OPENAI_API_KEY"]);
        services.AddKeyedSingleton<IStreamingStt, OpenAIRealtimeStt>("openai");
        return services;
    }

    public static IServiceCollection AddOpenAITranslator(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<OpenAITranslationOptions>()
            .Bind(config.GetSection(OpenAITranslationOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["OPENAI_API_KEY"]);
        services.AddHttpClient<OpenAITranslator>(c => c.Timeout = TimeSpan.FromSeconds(15));
        services.AddKeyedTransient<IStreamingTranslator>("openai", (sp, _) => sp.GetRequiredService<OpenAITranslator>());
        return services;
    }
}
