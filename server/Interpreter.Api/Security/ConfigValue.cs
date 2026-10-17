namespace Interpreter.Api.Security;

/// <summary>
/// One test for "is this setting really set", shared by /health, the STT fallback and the access gate, so
/// they never disagree. "replace-me" is the .env.example placeholder: an instance started from the
/// unchanged example file has no key and no access token, never a public one.
/// </summary>
public static class ConfigValue
{
    public const string Placeholder = "replace-me";

    public static bool IsSet(string? value) => !string.IsNullOrWhiteSpace(value) && value.Trim() != Placeholder;
}
