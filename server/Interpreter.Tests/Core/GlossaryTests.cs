using Interpreter.Core.Cascade;
using Interpreter.Core.Interpretation;
using Interpreter.Core.Languages;

namespace Interpreter.Tests.Core;

public class GlossaryTests
{
    private static Glossary Medical() =>
        Glossary.Load(Path.Combine(Path.GetDirectoryName(LanguageCatalog.FindConfigFile(AppContext.BaseDirectory))!, "glossary.json"));

    [Fact]
    public void Looks_up_either_direction_from_one_entry()
    {
        var g = Medical();

        Assert.True(g.Count >= 10);
        Assert.Equal("warfarina", g.For("en", "es")["warfarin"]);
        Assert.Equal("blood pressure", g.For("es", "en")["presión arterial"]);
        Assert.Empty(g.For("en", "vi"));
    }

    [Fact]
    public void Missing_file_is_an_empty_glossary()
    {
        Assert.Equal(0, Glossary.Load("/nonexistent/glossary.json").Count);
    }

    [Fact]
    public void Cascade_and_realtime_get_the_same_glossary_block()
    {
        var terms = Medical().For("en", "es");
        var realtime = InterpreterInstructions.Build("English", "Spanish", terms);
        var cascade = TranslationPrompt.System(new TranslationRequest("English", "Spanish", "x", Glossary: terms));

        Assert.StartsWith(realtime, cascade);
        Assert.Contains("- warfarin → warfarina", realtime);
    }
}
