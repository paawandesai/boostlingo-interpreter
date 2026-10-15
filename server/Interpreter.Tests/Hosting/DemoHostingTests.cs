using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Interpreter.Tests.Hosting;

public sealed class DemoHostingTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>, IDisposable
{
    private readonly string _spa = Directory.CreateTempSubdirectory("spa").FullName;

    public void Dispose() => Directory.Delete(_spa, recursive: true);

    private HttpClient Client(params (string Key, string Value)[] settings) => factory.WithWebHostBuilder(b =>
    {
        b.UseSetting("Access:Token", "t");
        b.UseSetting("Access:PermitLimit", "2");
        foreach (var (k, v) in settings) b.UseSetting(k, v);
    }).CreateClient();

    private static HttpRequestMessage Mint(string forwardedFor)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/realtime/session") { Content = JsonContent.Create(new { source = "en", target = "es" }) };
        req.Headers.Add("X-Forwarded-For", forwardedFor);
        return req;
    }

    [Fact]
    public async Task Local_runs_serve_no_pages_and_send_no_robots_header()
    {
        var res = await Client().GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.False(res.Headers.Contains("X-Robots-Tag"));
    }

    [Fact]
    public async Task Demo_serves_the_spa_with_noindex_and_keeps_unknown_api_paths_404()
    {
        await File.WriteAllTextAsync(Path.Combine(_spa, "index.html"), "<html>spa</html>", TestContext.Current.CancellationToken);
        var client = Client(("Demo:SpaPath", _spa), ("Demo:NoIndex", "true"));
        var ct = TestContext.Current.CancellationToken;

        var root = await client.GetAsync("/", ct);
        var deep = await client.GetAsync("/some/client/route", ct);
        var api = await client.GetAsync("/api/nope", ct);

        Assert.Equal("<html>spa</html>", await root.Content.ReadAsStringAsync(ct));
        Assert.Equal("<html>spa</html>", await deep.Content.ReadAsStringAsync(ct));
        Assert.Equal(HttpStatusCode.NotFound, api.StatusCode);
        Assert.Equal("noindex, nofollow", root.Headers.GetValues("X-Robots-Tag").Single());
        Assert.Contains("Disallow: /", await client.GetStringAsync("/robots.txt", ct));
    }

    [Fact]
    public async Task Rate_limit_keys_on_the_address_the_proxies_saw_not_a_client_supplied_one()
    {
        // CloudFront appends the viewer address, the load balancer appends CloudFront's: 2 hops.
        var client = Client(("Demo:ForwardLimit", "2"));
        var ct = TestContext.Current.CancellationToken;
        var codes = new List<HttpStatusCode>();
        foreach (var spoof in new[] { "1.1.1.1", "2.2.2.2", "3.3.3.3" })
            codes.Add((await client.SendAsync(Mint($"{spoof}, 203.0.113.5, 130.176.0.1"), ct)).StatusCode);
        var other = await client.SendAsync(Mint("203.0.113.9, 130.176.0.1"), ct);

        Assert.Equal(HttpStatusCode.TooManyRequests, codes[2]);
        Assert.NotEqual(HttpStatusCode.TooManyRequests, codes[0]);
        Assert.NotEqual(HttpStatusCode.TooManyRequests, other.StatusCode);
    }
}
