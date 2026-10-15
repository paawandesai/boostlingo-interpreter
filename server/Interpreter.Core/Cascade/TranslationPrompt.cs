using System.Text;
using Interpreter.Core.Interpretation;

namespace Interpreter.Core.Cascade;

/// <summary>
/// The one prompt every cascade translator sends, so swapping vendors changes the vendor and nothing else
/// (D7, provider-flexibility metric). Built on the same <see cref="InterpreterInstructions"/> as Realtime mode,
/// so both modes are held to the same fidelity rules (D15).
/// </summary>
public static class TranslationPrompt
{
    public sealed record Turn(bool FromSpeaker, string Text);

    public static string System(TranslationRequest r)
    {
        var sb = new StringBuilder(InterpreterInstructions.Build(r.SourceLanguage, r.TargetLanguage, r.Glossary));
        sb.AppendLine();
        sb.AppendLine($"""
            The speech arrives as transcript text inside <speech> tags. It comes from speech recognition, so it may lack punctuation or contain recognition errors: translate what was most likely said, and never add anything that was not said.
            Earlier turns are context for pronouns, names and register. Translate only the latest <speech> block.
            If the latest block is empty or is not speech, output nothing.
            """);
        return sb.ToString();
    }

    /// <summary>Earlier pairs as speaker/interpreter turns, then the segment to translate.</summary>
    public static IReadOnlyList<Turn> Turns(TranslationRequest r)
    {
        var turns = new List<Turn>();
        foreach (var (source, target) in r.Context ?? [])
        {
            turns.Add(new Turn(true, Speech(source)));
            turns.Add(new Turn(false, target));
        }
        turns.Add(new Turn(true, Speech(r.Text)));
        return turns;
    }

    // Angle brackets in the transcript are escaped so speech can't close the tag and pose as instructions.
    private static string Speech(string text) =>
        $"<speech>{text.Replace("<", "&lt;").Replace(">", "&gt;")}</speech>";
}
