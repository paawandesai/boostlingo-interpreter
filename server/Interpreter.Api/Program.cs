using Interpreter.Api.Realtime;
using Interpreter.Api.Security;
using Interpreter.Core.Languages;
using Interpreter.Providers.OpenAI;

var builder = WebApplication.CreateBuilder(args);

var languagesPath = builder.Configuration["Languages:Path"]
    ?? LanguageCatalog.FindConfigFile(builder.Environment.ContentRootPath)
    ?? throw new InvalidOperationException("config/languages.json not found; set Languages:Path");
builder.Services.AddSingleton(LanguageCatalog.Load(languagesPath));
builder.Services.AddProblemDetails();
builder.Services.AddOpenAIRealtime(builder.Configuration);
builder.Services.AddAccessControl(builder.Configuration);

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/health", () => Results.Ok(new HealthResponse("ok", typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0")));
app.MapGet("/api/languages", (LanguageCatalog catalog) => Results.Ok(new
{
    languages = catalog.Languages.Select(l => new { l.Code, l.Name }),
    pairs = catalog.Pairs.Select(p => new[] { p.A, p.B }),
}));
app.MapRealtimeEndpoints();

app.Run();

public sealed record HealthResponse(string Status, string Version);

// Exposed so Interpreter.Tests can host the app with WebApplicationFactory.
public partial class Program;
