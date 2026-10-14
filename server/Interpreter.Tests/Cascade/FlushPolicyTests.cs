using Interpreter.Core.Cascade;

namespace Interpreter.Tests.Cascade;

public class FlushPolicyTests
{
    /// <summary>Feeds text one character at a time (the worst case for a streaming LLM) and collects every chunk.</summary>
    private static List<string> Stream(string text, FlushOptions? options = null)
    {
        var policy = new FlushPolicy(options);
        var chunks = new List<string>();
        foreach (var c in text) chunks.AddRange(policy.Push(c.ToString(), 0));
        if (policy.Complete() is { } rest) chunks.Add(rest);
        return chunks;
    }

    public static TheoryData<string, string[]> Cases => new()
    {
        // English
        { "Hello there. How are you?", ["Hello there.", "How are you?"] },
        { "Dr. Smith will see you now. Thanks.", ["Dr. Smith will see you now.", "Thanks."] },
        { "Mrs. Jones and J. R. Smith called. Bye.", ["Mrs. Jones and J. R. Smith called.", "Bye."] },
        { "Take 3.5 mg twice a day. Okay.", ["Take 3.5 mg twice a day.", "Okay."] },
        { "Yes, I understand.", ["Yes, I understand."] },
        { "When the pain started last night after dinner, I took an aspirin.",
            ["When the pain started last night after dinner,", "I took an aspirin."] },
        { "He said \"stop.\" Then he left.", ["He said \"stop.\"", "Then he left."] },
        { "Bring e.g. water and food. Wait!", ["Bring e.g. water and food.", "Wait!"] },
        { "Is that all? No. There is more.", ["Is that all?", "No.", "There is more."] },
        // Spanish
        { "¿Dónde le duele? En el pecho.", ["¿Dónde le duele?", "En el pecho."] },
        { "¡Hola! La Sra. García llegó.", ["¡Hola!", "La Sra. García llegó."] },
        { "Tome 2,5 mg cada día. Gracias.", ["Tome 2,5 mg cada día.", "Gracias."] },
        { "Cuando empezó el dolor anoche después de cenar, tomé una aspirina.",
            ["Cuando empezó el dolor anoche después de cenar,", "tomé una aspirina."] },
        { "Sí, entiendo.", ["Sí, entiendo."] },
        { "Bueno… creo que sí.", ["Bueno…", "creo que sí."] },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void Flushes_at_sentence_and_long_clause_boundaries(string text, string[] expected)
    {
        Assert.Equal(expected, Stream(text));
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Chunking_does_not_depend_on_delta_size(string text, string[] expected)
    {
        var policy = new FlushPolicy();
        var chunks = new List<string>();
        foreach (var word in text.Split(' ')) chunks.AddRange(policy.Push(word + " ", 0));
        if (policy.Complete() is { } rest) chunks.Add(rest);

        Assert.Equal(expected, chunks);
    }

    [Fact]
    public void Text_is_never_lost_or_reordered()
    {
        const string text = "One. Two, three; four: five? Six! 7.5 eight… nine";
        Assert.Equal(text, string.Join(" ", Stream(text, new FlushOptions(MinClauseChars: 0))));
    }

    [Fact]
    public void Timeout_releases_up_to_the_last_word_and_keeps_the_partial_word()
    {
        var policy = new FlushPolicy(new FlushOptions(MaxWaitMs: 400, MinCharsOnTimeout: 12));

        Assert.Empty(policy.Push("This is a long clause without any", 0));
        Assert.Null(policy.Tick(399));
        Assert.Equal("This is a long clause without", policy.Tick(400));
        Assert.Equal("any", policy.Complete());
    }

    [Fact]
    public void Timeout_waits_for_enough_text()
    {
        var policy = new FlushPolicy(new FlushOptions(MaxWaitMs: 400, MinCharsOnTimeout: 12));

        policy.Push("Well I", 0);
        Assert.Null(policy.Tick(1000));
        Assert.Equal("Well I", policy.Complete());
    }

    [Fact]
    public void Timeout_clock_restarts_after_each_release()
    {
        var policy = new FlushPolicy(new FlushOptions(MaxWaitMs: 400, MinCharsOnTimeout: 5));

        Assert.Equal(["First sentence."], policy.Push("First sentence. second part of it", 300));
        Assert.Null(policy.Tick(600));
        Assert.Equal("second part of", policy.Tick(700));
    }

    [Fact]
    public void Tick_before_any_text_does_nothing()
    {
        var policy = new FlushPolicy();
        Assert.Null(policy.Tick(10_000));
        Assert.Null(policy.Complete());
        Assert.False(policy.HasPending);
    }
}
