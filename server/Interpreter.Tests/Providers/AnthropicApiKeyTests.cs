using Interpreter.Providers.Anthropic;
using Microsoft.Extensions.Configuration;

namespace Interpreter.Tests.Providers;

public class AnthropicApiKeyTests
{
    private static string? KeyFrom(params (string Name, string? Value)[] vars) =>
        AnthropicTranslationOptions.ApiKeyFrom(new ConfigurationBuilder()
            .AddInMemoryCollection(vars.Select(v => new KeyValuePair<string, string?>(v.Name, v.Value)))
            .Build());

    [Fact]
    public void Prefers_the_claude_translator_name() =>
        Assert.Equal("new", KeyFrom(("CLAUDE_TRANSLATOR_API_KEY", "new"), ("ANTHROPIC_API_KEY", "old")));

    [Fact]
    public void Falls_back_to_anthropic_api_key_for_local_runs() =>
        Assert.Equal("old", KeyFrom(("ANTHROPIC_API_KEY", "old")));

    [Fact]
    public void Treats_a_blank_preferred_name_as_unset() =>
        Assert.Equal("old", KeyFrom(("CLAUDE_TRANSLATOR_API_KEY", " "), ("ANTHROPIC_API_KEY", "old")));

    [Fact]
    public void Treats_the_env_example_placeholder_as_unset() =>
        Assert.Equal("old", KeyFrom(("CLAUDE_TRANSLATOR_API_KEY", "replace-me"), ("ANTHROPIC_API_KEY", "old")));

    [Fact]
    public void Is_null_when_neither_is_set() => Assert.Null(KeyFrom());
}
