using Interpreter.Core.Cascade;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Interpreter.Providers.Anthropic;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddAnthropicTranslator(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<AnthropicTranslationOptions>()
            .Bind(config.GetSection(AnthropicTranslationOptions.Section))
            .PostConfigure(o => o.ApiKey ??= config["ANTHROPIC_API_KEY"]);
        services.AddHttpClient<AnthropicTranslator>(c => c.Timeout = TimeSpan.FromSeconds(15));
        services.AddKeyedTransient<IStreamingTranslator>("anthropic", (sp, _) => sp.GetRequiredService<AnthropicTranslator>());
        return services;
    }
}
