using System.Diagnostics.CodeAnalysis;

namespace Interpreter.Core.Configuration;

/// <summary>
/// One test for "is this setting really set", shared by /health, the STT fallback, the access gate and every
/// provider adapter's key check, so they never disagree and the placeholder is never sent to a vendor. "replace-me" is the .env.example placeholder: an instance started from the
/// unchanged example file has no key and no access token, never a public one.
/// </summary>
public static class ConfigValue
{
    public const string Placeholder = "replace-me";

    public static bool IsSet([NotNullWhen(true)] string? value) => !string.IsNullOrWhiteSpace(value) && value.Trim() != Placeholder;
}
