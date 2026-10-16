using System.Text.Json;
using System.Text.Json.Nodes;
using Interpreter.Api.Cascade;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;

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

    [Fact]
    public void Error_frames_carry_the_adapters_message()
    {
        var error = new CascadeError(3, "stt", "deepgram", ProviderErrorKind.Auth, "DEEPGRAM_API_KEY is not configured on the server");

        var frame = JsonNode.Parse(JsonSerializer.Serialize(CascadeProtocol.ToWire(error), CascadeProtocol.Json))!;

        Assert.Equal("error", (string?)frame["type"]);
        Assert.Equal(3, (int?)frame["u"]);
        Assert.Equal("Auth", (string?)frame["kind"]);
        Assert.Equal("DEEPGRAM_API_KEY is not configured on the server", (string?)frame["message"]);
    }
}
