using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Channels;
using Interpreter.Core.Errors;

namespace Interpreter.Core.Cascade;

/// <summary>One cascade session's settings. Language names go to the translator, codes to STT and TTS.</summary>
/// <param name="ContextPairs">How many recent source/target pairs the translator sees.</param>
public sealed record CascadeSettings(
    string SourceCode,
    string SourceName,
    string TargetCode,
    string TargetName,
    string? Voice = null,
    FlushOptions? Flush = null,
    int ContextPairs = 3,
    IReadOnlyList<string>? Keyterms = null,
    IReadOnlyDictionary<string, string>? Glossary = null);

/// <summary>
/// Everything the cascade reports, in the order it happened. <see cref="AtMs"/> is milliseconds since the
/// pipeline started (or since <c>clockStart</c>, a <see cref="TimeProvider"/> timestamp, when the caller passes
/// one to share a clock), on the server clock; the transport converts it for the client (D9).
/// </summary>
public abstract record CascadeEvent(int Utterance)
{
    public double AtMs { get; init; }
}

public sealed record SourcePartial(int Utterance, string Text) : CascadeEvent(Utterance);

public sealed record SourceFinal(int Utterance, string Text, double? Confidence) : CascadeEvent(Utterance);

public sealed record TranslationDelta(int Utterance, string Text) : CascadeEvent(Utterance);

/// <summary>A segment's full translation, for the transcript. Sent once per STT final.</summary>
public sealed record TranslationFinal(int Utterance, string Source, string Text) : CascadeEvent(Utterance);

public sealed record TtsAudio(int Utterance, AudioChunk Audio) : CascadeEvent(Utterance);

/// <summary>Server-side latency marks (D9): endpoint, stt.final, translation.first_token, tts.first_flush, tts.first_byte.</summary>
public sealed record LatencyMark(int Utterance, string Name) : CascadeEvent(Utterance);

/// <summary>Translation and speech for this utterance are finished (or abandoned after an error).</summary>
public sealed record UtteranceDone(int Utterance) : CascadeEvent(Utterance);

/// <param name="Stage">"stt", "translation" or "tts".</param>
public sealed record CascadeError(int Utterance, string Stage, string Provider, ProviderErrorKind Kind) : CascadeEvent(Utterance);

/// <summary>
/// The cascade (D8, D11): STT finals are translated as they arrive, translation streams through the
/// <see cref="FlushPolicy"/>, and released text feeds one TTS stream per utterance. STT keeps listening
/// while earlier utterances are translated and spoken. Utterances are spoken in order.
/// <para>
/// Errors: a translation or TTS <see cref="ProviderException"/> is reported and the pipeline moves on to the
/// next utterance; an STT error is reported and ends the session after queued utterances finish. Any other
/// exception is a bug and propagates.
/// </para>
/// </summary>
public sealed class CascadePipeline(
    IStreamingStt stt,
    IStreamingTranslator translator,
    IStreamingTts tts,
    TimeProvider? time = null)
{
    // Bounded everywhere: a slow consumer slows its producer instead of growing memory or dropping text.
    private const int QueueCapacity = 64;

    private readonly IStreamingStt _stt = stt;
    private readonly IStreamingTranslator _translator = translator;
    private readonly IStreamingTts _tts = tts;
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public async IAsyncEnumerable<CascadeEvent> RunAsync(
        IAsyncEnumerable<AudioFrame> audio,
        CascadeSettings settings,
        [EnumeratorCancellation] CancellationToken ct,
        long? clockStart = null)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var run = new Run(this, settings, clockStart ?? _time.GetTimestamp(), cts.Token);

        // If one stage fails, cancel the other so neither waits forever on a queue nobody serves.
        async Task Stage(Func<Task> body)
        {
            try { await body(); }
            catch { await cts.CancelAsync(); throw; }
        }

        var stages = Task.WhenAll(Stage(() => run.ListenAsync(audio)), Stage(run.InterpretAsync));
        var all = stages.ContinueWith(
            t => run.Events.Writer.TryComplete(
                t.Exception?.InnerExceptions.FirstOrDefault(e => e is not OperationCanceledException)),
            CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

        try
        {
            await foreach (var e in run.Events.Reader.ReadAllAsync(ct))
                yield return e;
        }
        finally
        {
            // The consumer stopped early, was cancelled, or a stage threw: stop every stage and wait for them.
            await cts.CancelAsync();
            await all;
        }
    }

    private sealed class Utterance(int id)
    {
        public int Id { get; } = id;
        public Channel<SttFinal> Segments { get; } = Channel.CreateBounded<SttFinal>(QueueCapacity);
        public bool EndpointMarked { get; set; }
    }

    private sealed class Run(CascadePipeline p, CascadeSettings s, long start, CancellationToken ct)
    {
        private readonly CascadePipeline _p = p;
        private readonly CascadeSettings _s = s;
        private readonly CancellationToken _ct = ct;
        private readonly Channel<Utterance> _utterances = Channel.CreateBounded<Utterance>(QueueCapacity);
        private readonly Queue<(string Source, string Target)> _context = new();
        private readonly FlushOptions _flush = s.Flush ?? new FlushOptions();

        public Channel<CascadeEvent> Events { get; } = Channel.CreateBounded<CascadeEvent>(QueueCapacity);

        private double Now() => _p._time.GetElapsedTime(start).TotalMilliseconds;

        private ValueTask Emit(CascadeEvent e, double? atMs = null) =>
            Events.Writer.WriteAsync(e with { AtMs = atMs ?? Now() }, _ct);

        /// <summary>STT stage: splits the event stream into utterances and queues their finals.</summary>
        public async Task ListenAsync(IAsyncEnumerable<AudioFrame> audio)
        {
            var nextId = 1;
            Utterance? current = null;
            // Endpoints seen while the previous utterance still waits for its final (OpenAI transcribes after
            // speech stops, so a quick next turn can end first). Each belongs to the next utterance opened.
            var earlyEndpoints = new Queue<double>();

            async ValueTask<Utterance> Current()
            {
                if (current is not null) return current;
                current = new Utterance(nextId++);
                await _utterances.Writer.WriteAsync(current, _ct);
                if (earlyEndpoints.TryDequeue(out var at))
                {
                    current.EndpointMarked = true;
                    await Emit(new LatencyMark(current.Id, "endpoint"), at);
                }
                return current;
            }

            async ValueTask Close(Utterance u)
            {
                if (!u.EndpointMarked)
                {
                    u.EndpointMarked = true;
                    await Emit(new LatencyMark(u.Id, "endpoint"));
                }
                u.Segments.Writer.TryComplete();
                current = null;
            }

            try
            {
                var options = new SttOptions(_s.SourceCode, Keyterms: _s.Keyterms);
                await foreach (var e in _p._stt.TranscribeAsync(audio, options, _ct).WithCancellation(_ct))
                {
                    switch (e)
                    {
                        case SttPartial { Text.Length: > 0 } partial:
                            await Emit(new SourcePartial((await Current()).Id, partial.Text));
                            break;
                        case SttFinal final:
                            if (final.Text.Trim().Length > 0)
                            {
                                var u = await Current();
                                await Emit(new LatencyMark(u.Id, "stt.final"));
                                await Emit(new SourceFinal(u.Id, final.Text, final.Confidence));
                                await u.Segments.Writer.WriteAsync(final, _ct);
                            }
                            if (final.EndsUtterance && current is not null) await Close(current);
                            break;
                        case SttUtteranceEnd when current is not null:
                            await Close(current);
                            break;
                        case SttEndpoint when current is { EndpointMarked: true }:
                            earlyEndpoints.Enqueue(Now());
                            break;
                        case SttEndpoint:
                            var open = await Current();
                            if (!open.EndpointMarked)
                            {
                                open.EndpointMarked = true;
                                await Emit(new LatencyMark(open.Id, "endpoint"));
                            }
                            break;
                    }
                }
            }
            catch (ProviderException ex)
            {
                await Emit(new CascadeError(current?.Id ?? nextId, "stt", ex.Provider, ex.Kind));
            }
            finally
            {
                current?.Segments.Writer.TryComplete();
                _utterances.Writer.TryComplete();
            }
        }

        /// <summary>Translation and TTS: one utterance at a time, so speech comes out in order.</summary>
        public async Task InterpretAsync()
        {
            await foreach (var u in _utterances.Reader.ReadAllAsync(_ct))
            {
                await InterpretUtteranceAsync(u);
                await Emit(new UtteranceDone(u.Id));
            }
        }

        private async Task InterpretUtteranceAsync(Utterance u)
        {
            var speech = new Speech(this, u.Id);
            var translating = true;
            try
            {
                await foreach (var segment in u.Segments.Reader.ReadAllAsync(_ct))
                {
                    // After a translation error, drain the rest of the utterance so STT is never blocked.
                    if (!translating) continue;
                    translating = await TranslateSegmentAsync(u.Id, segment.Text, speech);
                }
            }
            finally
            {
                await speech.FinishAsync();
            }
        }

        /// <returns>False if the translator failed and the rest of this utterance should be skipped.</returns>
        private async Task<bool> TranslateSegmentAsync(int id, string source, Speech speech)
        {
            var request = new TranslationRequest(
                _s.SourceName, _s.TargetName, source, _context.ToArray(), _s.Glossary);
            var policy = new FlushPolicy(_flush);
            var full = new StringBuilder();
            var first = true;

            await using var tokens = _p._translator.TranslateAsync(request, _ct).GetAsyncEnumerator(_ct);
            Task<bool>? next = null;
            try
            {
                next = tokens.MoveNextAsync().AsTask();
                while (true)
                {
                    // Wait for the next delta, but wake up for the flush timeout if the translator stalls.
                    using var tick = CancellationTokenSource.CreateLinkedTokenSource(_ct);
                    var timeout = Task.Delay(TimeSpan.FromMilliseconds(_flush.MaxWaitMs), _p._time, tick.Token);
                    var won = await Task.WhenAny(next, timeout);
                    await tick.CancelAsync();
                    if (won == timeout)
                    {
                        _ct.ThrowIfCancellationRequested();
                        if (policy.Tick(Now()) is { } stalled) await speech.SayAsync(stalled);
                        continue;
                    }
                    if (!await next) break;

                    var delta = tokens.Current;
                    if (first)
                    {
                        first = false;
                        await Emit(new LatencyMark(id, "translation.first_token"));
                    }
                    full.Append(delta);
                    await Emit(new TranslationDelta(id, delta));
                    foreach (var chunk in policy.Push(delta, Now())) await speech.SayAsync(chunk);
                    next = tokens.MoveNextAsync().AsTask();
                }
            }
            catch (ProviderException ex)
            {
                await Emit(new CascadeError(id, "translation", ex.Provider, ex.Kind));
                return false;
            }
            finally
            {
                // An enumerator can't be disposed mid-MoveNext; let a cancelled call finish first.
                if (next is { IsCompleted: false }) await ((Task)next).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            }

            if (policy.Complete() is { } rest) await speech.SayAsync(rest);
            var target = full.ToString().Trim();
            await Emit(new TranslationFinal(id, source, target));
            Remember(source, target);
            return true;
        }

        private void Remember(string source, string target)
        {
            if (_s.ContextPairs <= 0 || target.Length == 0) return;
            _context.Enqueue((source, target));
            while (_context.Count > _s.ContextPairs) _context.Dequeue();
        }

        /// <summary>The utterance's TTS stream: opened on the first flushed chunk, closed when the utterance ends.</summary>
        private sealed class Speech(Run run, int id)
        {
            private Channel<string>? _text;
            private Task? _speaking;
            private bool _failed;

            public async ValueTask SayAsync(string chunk)
            {
                if (_failed) return;
                if (_text is null)
                {
                    await run.Emit(new LatencyMark(id, "tts.first_flush"));
                    _text = Channel.CreateBounded<string>(QueueCapacity);
                    _speaking = SpeakAsync(_text.Reader);
                }
                try
                {
                    await _text.Writer.WriteAsync(chunk, run._ct);
                }
                catch (ChannelClosedException)
                {
                    // TTS failed; the error is already reported. Translation text still reaches the transcript.
                }
            }

            public async Task FinishAsync()
            {
                _text?.Writer.TryComplete();
                if (_speaking is not null) await _speaking;
            }

            private async Task SpeakAsync(ChannelReader<string> text)
            {
                var options = new TtsOptions(run._s.TargetCode, run._s.Voice);
                var first = true;
                try
                {
                    await foreach (var audio in run._p._tts.SynthesizeAsync(text.ReadAllAsync(run._ct), options, run._ct)
                                       .WithCancellation(run._ct))
                    {
                        if (first)
                        {
                            first = false;
                            await run.Emit(new LatencyMark(id, "tts.first_byte"));
                        }
                        await run.Emit(new TtsAudio(id, audio));
                    }
                }
                catch (ProviderException ex)
                {
                    _failed = true;
                    _text!.Writer.TryComplete();
                    await run.Emit(new CascadeError(id, "tts", ex.Provider, ex.Kind));
                }
            }
        }
    }
}
