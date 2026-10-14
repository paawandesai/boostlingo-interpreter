using System.Runtime.CompilerServices;
using System.Text;
using Interpreter.Core.Cascade;
using Interpreter.Core.Errors;

namespace Interpreter.Tests.Cascade;

public class CascadePipelineTests
{
    private static readonly CascadeSettings EnEs = new("en", "English", "es", "Spanish");

    private static async IAsyncEnumerable<AudioFrame> NoAudio()
    {
        await Task.CompletedTask;
        yield break;
    }

    private static async Task<List<CascadeEvent>> RunAll(
        CascadePipeline pipeline, CascadeSettings? settings = null, TimeSpan? timeout = null)
    {
        // A deadlock in the pipeline fails the test instead of hanging the run.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        cts.CancelAfter(timeout ?? TimeSpan.FromSeconds(10));
        var events = new List<CascadeEvent>();
        await foreach (var e in pipeline.RunAsync(NoAudio(), settings ?? EnEs, cts.Token)) events.Add(e);
        return events;
    }

    private static string Spoken(IEnumerable<CascadeEvent> events, int utterance) =>
        string.Join("|", events.OfType<TtsAudio>().Where(a => a.Utterance == utterance)
            .Select(a => Encoding.UTF8.GetString(a.Audio.Pcm16.Span)));

    private static SttFinal Final(string text, bool ends = true) => new(text, ends, 0.9);

    [Fact]
    public async Task Utterances_are_translated_and_spoken_in_order()
    {
        var translator = new FakeTranslator();
        var pipeline = new CascadePipeline(
            new FakeStt([new SttPartial("Good"), Final("Good morning."), Final("Where does it hurt?")]),
            translator, new FakeTts());

        var events = await RunAll(pipeline);

        Assert.Equal("ES(Good morning.)", Spoken(events, 1));
        Assert.Equal("ES(Where does it hurt?)", Spoken(events, 2));
        var audio = events.OfType<TtsAudio>().Select(a => a.Utterance).ToList();
        Assert.Equal(audio.Order(), audio);
        Assert.Equal([1, 2], events.OfType<UtteranceDone>().Select(d => d.Utterance));
        Assert.Equal(new SourcePartial(1, "Good"), events.OfType<SourcePartial>().Single() with { AtMs = 0 });
        Assert.Equal(0.9, events.OfType<SourceFinal>().First().Confidence);
        // The second utterance is translated with the first as context.
        Assert.Equal([("Good morning.", "ES(Good morning.)")], translator.Requests[1].Context!);
    }

    [Fact]
    public async Task Segment_finals_are_translated_before_the_utterance_ends()
    {
        var tts = new FakeTts();
        // STT holds the utterance open until TTS has started speaking it (milestone M3: no stage blocks another).
        var stt = new FakeStt([Final("I have had a headache since Monday.", ends: false)], then: async ct =>
        {
            await tts.FirstChunk.Task.WaitAsync(ct);
            return [Final("It is worse at night.", ends: false), new SttUtteranceEnd()];
        });

        var events = await RunAll(new CascadePipeline(stt, new FakeTranslator(), tts));

        Assert.Equal("ES(I have had a headache since Monday.)|ES(It is worse at night.)", Spoken(events, 1));
        var marks = events.OfType<LatencyMark>().Select(m => m.Name).ToList();
        Assert.True(marks.IndexOf("tts.first_flush") < marks.IndexOf("endpoint"));
    }

    [Fact]
    public async Task Every_utterance_gets_all_latency_marks_in_time_order()
    {
        var events = await RunAll(new CascadePipeline(
            new FakeStt([Final("One."), Final("Two.")]), new FakeTranslator(), new FakeTts()));

        string[] chain = ["stt.final", "translation.first_token", "tts.first_flush", "tts.first_byte"];
        foreach (var u in new[] { 1, 2 })
        {
            var marks = events.OfType<LatencyMark>().Where(m => m.Utterance == u).ToList();
            // "endpoint" comes from the STT stage and can land before or after translation starts.
            Assert.Equal(chain.Append("endpoint").Order(), marks.Select(m => m.Name).Order());
            var times = chain.Select(name => marks.Single(m => m.Name == name).AtMs).ToList();
            Assert.Equal(times.Order(), times);
        }
    }

    [Fact]
    public async Task A_slow_consumer_gets_every_utterance_without_loss()
    {
        const int count = 300; // well past every queue's capacity
        var tts = new FakeTts();
        var pipeline = new CascadePipeline(
            new FakeStt(Enumerable.Range(1, count).Select(i => (SttEvent)Final($"Sentence {i}."))),
            new FakeTranslator(), tts);

        var events = new List<CascadeEvent>();
        await foreach (var e in pipeline.RunAsync(NoAudio(), EnEs, TestContext.Current.CancellationToken))
        {
            if (events.Count % 50 == 0) await Task.Delay(20, TestContext.Current.CancellationToken);
            events.Add(e);
        }

        Assert.Equal(count, events.OfType<UtteranceDone>().Count());
        Assert.Equal(Enumerable.Range(1, count).Select(i => $"ES(Sentence {i}.)"), tts.Received);
    }

    [Fact]
    public async Task Cancelling_stops_every_stage()
    {
        var stt = new FakeStt([Final("Hello.", ends: false)], then: async ct =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return [];
        });
        var translator = new FakeTranslator { HangAfterFirstToken = true };
        var tts = new FakeTts();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var e in new CascadePipeline(stt, translator, tts).RunAsync(NoAudio(), EnEs, cts.Token))
                if (e is TranslationDelta) await cts.CancelAsync();
        });

        Assert.True(stt.Stopped.Task.IsCompleted);
        Assert.True(translator.Stopped.Task.IsCompleted);
    }

    [Fact]
    public async Task Breaking_out_early_stops_every_stage()
    {
        var stt = new FakeStt([new SttPartial("Hi")], then: async ct =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return [];
        });

        await foreach (var _ in new CascadePipeline(stt, new FakeTranslator(), new FakeTts())
                           .RunAsync(NoAudio(), EnEs, TestContext.Current.CancellationToken))
            break;

        Assert.True(stt.Stopped.Task.IsCompleted);
    }

    [Fact]
    public async Task Translation_error_is_reported_and_the_next_utterance_still_plays()
    {
        var translator = new FakeTranslator { FailOn = "Bad." };
        var events = await RunAll(new CascadePipeline(
            new FakeStt([Final("Bad."), Final("Good.")]), translator, new FakeTts()));

        var error = Assert.Single(events.OfType<CascadeError>());
        Assert.Equal((1, "translation", "fake-translator", ProviderErrorKind.RateLimited),
            (error.Utterance, error.Stage, error.Provider, error.Kind));
        Assert.Equal("", Spoken(events, 1));
        Assert.Equal("ES(Good.)", Spoken(events, 2));
        Assert.Equal([1, 2], events.OfType<UtteranceDone>().Select(d => d.Utterance));
    }

    [Fact]
    public async Task Tts_error_is_reported_and_translation_text_still_arrives()
    {
        var tts = new FakeTts { FailOn = "ES(Bad.)" };
        var events = await RunAll(new CascadePipeline(
            new FakeStt([Final("Bad."), Final("Good.")]), new FakeTranslator(), tts));

        var error = Assert.Single(events.OfType<CascadeError>());
        Assert.Equal((1, "tts"), (error.Utterance, error.Stage));
        Assert.Contains(events.OfType<TranslationFinal>(), t => t is { Utterance: 1, Text: "ES(Bad.)" });
        Assert.Equal("ES(Good.)", Spoken(events, 2));
    }

    [Fact]
    public async Task Stt_error_finishes_queued_utterances_then_ends()
    {
        var stt = new FakeStt([Final("Done.")], then: _ =>
            throw new ProviderException(ProviderErrorKind.Unavailable, "fake-stt", "socket closed"));

        var events = await RunAll(new CascadePipeline(stt, new FakeTranslator(), new FakeTts()));

        Assert.Equal("ES(Done.)", Spoken(events, 1));
        var error = Assert.Single(events.OfType<CascadeError>());
        Assert.Equal(("stt", ProviderErrorKind.Unavailable), (error.Stage, error.Kind));
    }

    [Fact]
    public async Task A_stalled_translator_is_flushed_on_the_timeout()
    {
        var tts = new FakeTts();
        var translator = new FakeTranslator
        {
            Script = ["This is a long clause without", " any", " end", " in sight."],
            PauseAfterFirstToken = TimeSpan.FromMilliseconds(400),
        };
        var settings = EnEs with { Flush = new FlushOptions(MaxWaitMs: 50, MinCharsOnTimeout: 5) };

        var events = await RunAll(new CascadePipeline(new FakeStt([Final("x")]), translator, tts), settings);

        // The first chunk went to TTS during the pause; the trailing word waited for more text.
        Assert.Equal(["This is a long clause", "without any end in sight."], tts.Received);
        Assert.Equal("This is a long clause without any end in sight.", events.OfType<TranslationFinal>().Single().Text);
    }

    [Fact]
    public async Task Empty_finals_and_stray_utterance_ends_are_ignored()
    {
        var events = await RunAll(new CascadePipeline(
            new FakeStt([new SttUtteranceEnd(), Final("  "), Final("Hi."), new SttUtteranceEnd()]),
            new FakeTranslator(), new FakeTts()));

        Assert.Equal([1], events.OfType<UtteranceDone>().Select(d => d.Utterance));
        Assert.Single(events.OfType<LatencyMark>(), m => m.Name == "endpoint");
    }

    [Fact]
    public async Task Endpoint_before_the_final_marks_the_utterance_without_closing_it()
    {
        var events = await RunAll(new CascadePipeline(
            new FakeStt([new SttEndpoint(), new SttPartial("Hi"), Final("Hi there.")]), new FakeTranslator(), new FakeTts()));

        var marks = events.OfType<LatencyMark>().Where(m => m.Utterance == 1).Select(m => m.Name).ToList();
        Assert.True(marks.IndexOf("endpoint") < marks.IndexOf("stt.final"));
        Assert.Single(marks, m => m == "endpoint");
        Assert.Equal("ES(Hi there.)", Spoken(events, 1));
    }

    [Fact]
    public async Task An_endpoint_that_arrives_before_the_previous_final_belongs_to_the_next_utterance()
    {
        var events = await RunAll(new CascadePipeline(
            new FakeStt([new SttEndpoint(), new SttEndpoint(), Final("One."), Final("Two.")]),
            new FakeTranslator(), new FakeTts()));

        var endpoints = events.OfType<LatencyMark>().Where(m => m.Name == "endpoint").ToList();
        Assert.Equal([1, 2], endpoints.Select(m => m.Utterance));
        var firstFinal = events.OfType<LatencyMark>().First(m => m is { Utterance: 1, Name: "stt.final" });
        Assert.True(endpoints[1].AtMs <= firstFinal.AtMs, "the second endpoint keeps the time it was seen");
        Assert.Equal("ES(Two.)", Spoken(events, 2));
    }

    private sealed class FakeStt(IEnumerable<SttEvent> first, Func<CancellationToken, Task<SttEvent[]>>? then = null)
        : IStreamingStt
    {
        public TaskCompletionSource Stopped { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "fake-stt";

        public async IAsyncEnumerable<SttEvent> TranscribeAsync(
            IAsyncEnumerable<AudioFrame> audio, SttOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            try
            {
                foreach (var e in first) yield return e;
                if (then is null) yield break;
                foreach (var e in await then(ct)) yield return e;
            }
            finally
            {
                Stopped.TrySetResult();
            }
        }
    }

    /// <summary>Translates "x" as "ES(x)", streamed in three pieces, unless a script is given.</summary>
    private sealed class FakeTranslator : IStreamingTranslator
    {
        public List<TranslationRequest> Requests { get; } = [];
        public string? FailOn { get; init; }
        public string[]? Script { get; init; }
        public TimeSpan PauseAfterFirstToken { get; init; }
        public bool HangAfterFirstToken { get; init; }
        public TaskCompletionSource Stopped { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "fake-translator";

        public async IAsyncEnumerable<string> TranslateAsync(
            TranslationRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            Requests.Add(request);
            if (request.Text == FailOn)
                throw new ProviderException(ProviderErrorKind.RateLimited, Name, "429");
            var pieces = Script ?? ["ES(", request.Text, ")"];
            try
            {
                for (var i = 0; i < pieces.Length; i++)
                {
                    await Task.Yield();
                    yield return pieces[i];
                    if (i > 0) continue;
                    if (HangAfterFirstToken) await Task.Delay(Timeout.Infinite, ct);
                    if (PauseAfterFirstToken > TimeSpan.Zero) await Task.Delay(PauseAfterFirstToken, ct);
                }
            }
            finally
            {
                Stopped.TrySetResult();
            }
        }
    }

    /// <summary>Returns each text chunk back as its UTF-8 bytes, so tests can read what was "spoken".</summary>
    private sealed class FakeTts : IStreamingTts
    {
        public List<string> Received { get; } = [];
        public string? FailOn { get; init; }
        public TaskCompletionSource FirstChunk { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "fake-tts";

        public async IAsyncEnumerable<AudioChunk> SynthesizeAsync(
            IAsyncEnumerable<string> textChunks, TtsOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var chunk in textChunks.WithCancellation(ct))
            {
                if (chunk == FailOn) throw new ProviderException(ProviderErrorKind.Unavailable, Name, "503");
                Received.Add(chunk);
                FirstChunk.TrySetResult();
                yield return new AudioChunk(Encoding.UTF8.GetBytes(chunk), options.SampleRate);
            }
        }
    }
}
