var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new HealthResponse("ok", typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0")));

app.Run();

public sealed record HealthResponse(string Status, string Version);

// Exposed so Interpreter.Tests can host the app with WebApplicationFactory.
public partial class Program;
