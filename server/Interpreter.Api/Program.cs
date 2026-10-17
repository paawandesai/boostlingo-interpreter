using Interpreter.Api.Cascade;
using Interpreter.Api.Health;
using Interpreter.Api.Hosting;
using Interpreter.Api.Realtime;
using Interpreter.Api.Security;
using Interpreter.Core.Interpretation;
using Interpreter.Core.Languages;
using Interpreter.Providers.Anthropic;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.ElevenLabs;
using Interpreter.Providers.OpenAI;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

var languagesPath = builder.Configuration["Languages:Path"]
    ?? LanguageCatalog.FindConfigFile(builder.Environment.ContentRootPath)
    ?? throw new InvalidOperationException("config/languages.json not found; set Languages:Path");
builder.Services.AddSingleton(LanguageCatalog.Load(languagesPath));
builder.Services.AddSingleton(Glossary.Load(Path.Combine(Path.GetDirectoryName(languagesPath)!, "glossary.json")));
builder.Services.AddProblemDetails();
builder.Services.AddSingleton<ProviderActivity>();
builder.Services.AddOpenAIRealtime(builder.Configuration);
builder.Services.AddAccessControl(builder.Configuration);
// BAA mode (off by default): refuses any session whose route isn't covered by a declared BAA.
builder.Services.AddCompliance(builder.Configuration);
builder.Services.AddHostedService<ComplianceStartupCheck>();
builder.Services.AddOptions<CascadeOptions>().Bind(builder.Configuration.GetSection(CascadeOptions.Section)).ValidateOnStart();
// A voice the active TTS doesn't list, or a session cap that isn't positive, stops startup with the setting's name.
builder.Services.AddSingleton<IValidateOptions<CascadeOptions>, CascadeOptionsValidation>();
// Without a Deepgram key the default STT adapter can't run; with an OpenAI key the openai one serves instead.
builder.Services.ConfigureOptions<CascadeSttFallback>();
builder.Services.AddDeepgramStt(builder.Configuration);
builder.Services.AddOpenAIStt(builder.Configuration);
builder.Services.AddOpenAITranslator(builder.Configuration);
builder.Services.AddAnthropicTranslator(builder.Configuration);
builder.Services.AddElevenLabsTts(builder.Configuration);
builder.Services.AddOpenAITts(builder.Configuration);

var app = builder.Build();

// Public demo only (T5, G14): proxy headers, noindex and the built SPA. All off unless configured,
// except the security response headers, which every run sends.
app.UseDemoHosting(builder.Configuration);
// Endpoints that declare a body limit get it before the JSON body is bound (the mint routes: 4 KB).
app.UseRequestBodyLimits();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
app.UseRateLimiter();

app.MapHealthEndpoints();
app.MapGet("/api/languages", (LanguageCatalog catalog, IOptions<ComplianceOptions> compliance, IOptions<CascadeOptions> cascade) => Results.Ok(new
{
    languages = catalog.Languages.Select(l => new { l.Code, l.Name, l.Disclosure, l.OutputChecks, l.RealtimeTranslate }),
    pairs = catalog.Pairs.Select(p => new[] { p.A, p.B }),
    // The prompt-leak canary is not a secret: it only has to never appear in an output (G15).
    canary = InterpreterInstructions.Canary,
    // Modes BAA mode refuses, with the reason the setup screen shows; empty when BAA mode is off.
    blockedModes = compliance.Value.BlockedModes(cascade.Value.Stt, cascade.Value.Translator, cascade.Value.Tts),
}));
// List prices for the session export's cost table (T3.5). Served as-is; null means unchecked.
var pricesPath = Path.Combine(Path.GetDirectoryName(languagesPath)!, "prices.json");
app.MapGet("/api/prices", () => File.Exists(pricesPath)
    ? Results.Text(File.ReadAllText(pricesPath), "application/json")
    : Results.NotFound());
app.MapGet("/api/glossary", (Glossary g) => Results.Ok(new { name = g.Name, count = g.Count }));
app.MapRealtimeEndpoints();
app.MapCascadeEndpoints();
app.MapDemoSpa(builder.Configuration);

app.Run();


// Exposed so Interpreter.Tests can host the app with WebApplicationFactory.
public partial class Program;
