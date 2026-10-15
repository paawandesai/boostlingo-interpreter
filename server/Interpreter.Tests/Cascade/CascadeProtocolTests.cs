using Interpreter.Api.Cascade;

namespace Interpreter.Tests.Cascade;

public class CascadeProtocolTests
{
    [Fact]
    public void History_keeps_the_latest_complete_pairs_and_cuts_long_text()
    {
        var pairs = Enumerable.Range(1, 9).Select(i => new CascadeProtocol.HistoryPair($"s{i}", $"t{i}")).ToList();
        pairs.Insert(3, new CascadeProtocol.HistoryPair("only source", null));
        pairs.Add(new CascadeProtocol.HistoryPair(new string('x', 2000), "long"));
        var start = new CascadeProtocol.Start("start", "tok", "en", "es", null, History: pairs);

        var history = CascadeProtocol.History(start);

        Assert.Equal(CascadeProtocol.MaxHistoryPairs, history.Count);
        Assert.Equal(("s5", "t5"), history[0]);
        Assert.Equal(CascadeProtocol.MaxHistoryChars, history[^1].Source.Length);
        Assert.DoesNotContain(history, p => p.Source == "only source");
    }

    [Fact]
    public void No_history_is_an_empty_list()
    {
        Assert.Empty(CascadeProtocol.History(new CascadeProtocol.Start("start", "tok", "en", "es", null)));
    }
}
