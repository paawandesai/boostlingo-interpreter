namespace Interpreter.Core.Errors;

/// <summary>
/// Wraps a streamed provider response body so a read that fails after the response started (dropped
/// connection, reset, truncated body) becomes a <see cref="ProviderException"/> of kind Unavailable.
/// The pipeline then reports it for that turn instead of the exception ending the whole session.
/// Caller cancellation still surfaces as <see cref="OperationCanceledException"/>.
/// </summary>
public sealed class ProviderBodyStream(Stream inner, string provider, string what) : Stream
{
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        try
        {
            return await inner.ReadAsync(buffer, ct);
        }
        catch (Exception e) when (e is IOException or HttpRequestException && !ct.IsCancellationRequested)
        {
            throw new ProviderException(ProviderErrorKind.Unavailable, provider, $"{what} stream failed while reading", inner: e);
        }
        catch (Exception e) when (e is not OperationCanceledException && ct.IsCancellationRequested)
        {
            throw new OperationCanceledException(ct);
        }
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
}
