using Interpreter.Api.Cascade;
using Interpreter.Api.Health;
using Interpreter.Api.Realtime;
using Interpreter.Api.Security;
using Interpreter.Core.Languages;
using Interpreter.Providers.Anthropic;
using Interpreter.Providers.Deepgram;
using Interpreter.Providers.ElevenLabs;
using Interpreter.Providers.OpenAI;

var builder = WebApplication.CreateBuilder(args);

var languagesPath = builder.Configuration["Languages:Path"]
    ?? LanguageCatalog.FindConfigFile(builder.Environment.ContentRootPath)
    ?? throw new InvalidOperationException("config/languages.json not found; set Languages:Path");
builder.Services.AddSingleton(LanguageCatalog.Load(languagesPath));
builder.Services.AddProblemDetails();
builder.Services.AddSingleton<ProviderActivity>();
builder.Services.AddOpenAIRealtime(builder.Configuration);
builder.Services.AddAccessControl(builder.Configuration);
builder.Services.Configure<CascadeOptions>(builder.Configuration.GetSection(CascadeOptions.Section));
builder.Services.AddDeepgramStt(builder.Configuration);
builder.Services.AddOpenAIStt(builder.Configuration);
builder.Services.AddOpenAITranslator(builder.Configuration);
builder.Services.AddAnthropicTranslator(builder.Configuration);
builder.Services.AddElevenLabsTts(builder.Configuration);

var app = builder.Build();

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
app.UseRateLimiter();

app.MapHealthEndpoints();
app.MapGet("/api/languages", (LanguageCatalog catalog) => Results.Ok(new
{
    languages = catalog.Languages.Select(l => new { l.Code, l.Name, l.Disclosure }),
    pairs = catalog.Pairs.Select(p => new[] { p.A, p.B }),
}));
// List prices for the session export's cost table (T3.5). Served as-is; null means unchecked.
var pricesPath = Path.Combine(Path.GetDirectoryName(languagesPath)!, "prices.json");
app.MapGet("/api/prices", () => File.Exists(pricesPath)
    ? Results.Text(File.ReadAllText(pricesPath), "application/json")
    : Results.NotFound());
app.MapRealtimeEndpoints();
app.MapCascadeEndpoints();

app.Run();


// Exposed so Interpreter.Tests can host the app with WebApplicationFactory.
public partial class Program;
