using Interpreter.Core.Cascade;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Providers.Deepgram;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddDeepgramStt(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<DeepgramOptions>()
            .Bind(config.GetSection(DeepgramOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["DEEPGRAM_API_KEY"]);
        services.AddKeyedSingleton<IStreamingStt, DeepgramStt>("deepgram");
        return services;
    }
}
