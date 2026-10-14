using System.Reflection;

namespace Interpreter.Tests;

/// <summary>
/// Guards the provider boundary: Core holds interfaces and the pipeline, and must never
/// depend on a vendor adapter. Swapping a provider then stays a contained change.
/// </summary>
public class ArchitectureTests
{
    [Fact]
    public void Core_does_not_reference_any_provider_assembly()
    {
        var core = typeof(Interpreter.Core.AssemblyMarker).Assembly;

        var providerRefs = core.GetReferencedAssemblies()
            .Select(a => a.Name!)
            .Where(n => n.StartsWith("Interpreter.Providers", StringComparison.Ordinal))
            .ToList();

        Assert.Empty(providerRefs);
    }

    [Theory]
    [InlineData(typeof(Interpreter.Providers.Deepgram.AssemblyMarker))]
    [InlineData(typeof(Interpreter.Providers.OpenAI.AssemblyMarker))]
    [InlineData(typeof(Interpreter.Providers.Anthropic.AssemblyMarker))]
    [InlineData(typeof(Interpreter.Providers.ElevenLabs.AssemblyMarker))]
    public void Providers_do_not_reference_each_other(Type marker)
    {
        Assembly provider = marker.Assembly;

        var otherProviders = provider.GetReferencedAssemblies()
            .Select(a => a.Name!)
            .Where(n => n.StartsWith("Interpreter.Providers", StringComparison.Ordinal))
            .ToList();

        Assert.Empty(otherProviders);
    }
}
