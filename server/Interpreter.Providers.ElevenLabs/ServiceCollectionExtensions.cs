using Interpreter.Core.Cascade;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Providers.ElevenLabs;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddElevenLabsTts(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<ElevenLabsOptions>()
            .Bind(config.GetSection(ElevenLabsOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["ELEVENLABS_API_KEY"]);
        services.AddKeyedSingleton<IStreamingTts, ElevenLabsTts>("elevenlabs");
        return services;
    }
}
