using System.Reflection;

namespace Interpreter.Tests.Architecture;

/// <summary>
/// Provider abstractions (brief, code quality): Core defines the interfaces and never depends on a
/// vendor adapter or the web host, so swapping a provider is a contained change.
/// </summary>
public class DependencyRulesTests
{
    private static readonly Assembly Core = typeof(Interpreter.Core.Cascade.IStreamingStt).Assembly;

    private static readonly Assembly[] Providers =
    [
        typeof(Interpreter.Providers.OpenAI.AssemblyMarker).Assembly,
        typeof(Interpreter.Providers.Deepgram.AssemblyMarker).Assembly,
        typeof(Interpreter.Providers.Anthropic.AssemblyMarker).Assembly,
        typeof(Interpreter.Providers.ElevenLabs.AssemblyMarker).Assembly,
    ];

    [Fact]
    public void Core_references_no_provider_or_api_assembly()
    {
        var refs = Core.GetReferencedAssemblies().Select(a => a.Name!).ToList();

        Assert.DoesNotContain(refs, n => n.StartsWith("Interpreter.Providers", StringComparison.Ordinal));
        Assert.DoesNotContain("Interpreter.Api", refs);
    }

    [Fact]
    public void Providers_do_not_reference_each_other_or_the_api()
    {
        foreach (var provider in Providers)
        {
            var refs = provider.GetReferencedAssemblies().Select(a => a.Name!).ToList();
            Assert.DoesNotContain(refs, n => n.StartsWith("Interpreter.Providers", StringComparison.Ordinal) && n != provider.GetName().Name);
            Assert.DoesNotContain("Interpreter.Api", refs);
        }
    }

    [Fact]
    public void Cascade_interfaces_expose_no_vendor_types()
    {
        var cascadeTypes = Core.GetTypes().Where(t => t.Namespace == "Interpreter.Core.Cascade");
        var exposed = cascadeTypes
            .SelectMany(t => t.GetMethods().SelectMany(m => m.GetParameters().Select(p => p.ParameterType).Append(m.ReturnType)))
            .SelectMany(Flatten)
            .Select(t => t.Assembly)
            .Distinct();

        Assert.All(exposed, a => Assert.True(a == Core || a.GetName().Name!.StartsWith("System", StringComparison.Ordinal),
            $"Cascade interface exposes a type from {a.GetName().Name}"));
    }

    private static IEnumerable<Type> Flatten(Type t) =>
        t.IsGenericType ? t.GetGenericArguments().SelectMany(Flatten).Append(t.GetGenericTypeDefinition()) : [t.HasElementType ? t.GetElementType()! : t];
}
