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
}
