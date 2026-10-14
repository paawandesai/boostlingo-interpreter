using Interpreter.Core.Languages;

namespace Interpreter.Tests.Core;

public class LanguageCatalogTests
{
    private static LanguageCatalog Repo() =>
        LanguageCatalog.Load(LanguageCatalog.FindConfigFile(AppContext.BaseDirectory)
            ?? throw new InvalidOperationException("config/languages.json not found"));

    [Fact]
    public void Repo_config_supports_english_spanish_both_ways()
    {
        var catalog = Repo();

        Assert.True(catalog.IsSupportedDirection("en", "es"));
        Assert.True(catalog.IsSupportedDirection("es", "en"));
        Assert.False(catalog.IsSupportedDirection("en", "fr"));
        Assert.Equal("Spanish", catalog.Find("es")?.Name);
    }

    [Fact]
    public void Pair_with_unknown_language_is_rejected()
    {
        Assert.Throws<InvalidOperationException>(() =>
            new LanguageCatalog([new Language("en", "English")], [("en", "xx")]));
    }
}
