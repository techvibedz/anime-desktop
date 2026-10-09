using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Keep verification in the Windows browser; return the result to the native player.
class ProviderBrowser {
  [STAThread] static void Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    var json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    Uri url;
    if (args.Length != 2 || !Uri.TryCreate(args[0], UriKind.Absolute, out url) || url.Scheme != "https") return;
    var job = json.Deserialize<Dictionary<string, object>>(Console.ReadLine());
    var script = (string)job["injectAfter"];
    var form = new Form { Width = 1280, Height = 800, ShowInTaskbar = false, Opacity = 0 };
    var browser = new WebView2 { Dock = DockStyle.Fill };
    form.Controls.Add(browser);
    var deadline = DateTime.UtcNow.AddMilliseconds(Convert.ToInt32(job["timeoutMs"]));
    var timer = new Timer { Interval = 500 };
    timer.Tick += (s, e) => { if (DateTime.UtcNow > deadline) form.Close(); };
    form.Shown += async (s, e) => {
      try {
        var environment = await CoreWebView2Environment.CreateAsync(null, args[1]);
        await browser.EnsureCoreWebView2Async(environment);
        var core = browser.CoreWebView2;
        core.IsMuted = true;
        core.Settings.AreDevToolsEnabled = false;
        var clientHints = new Dictionary<string, string>();
        core.AddWebResourceRequestedFilter("https://witanime.site/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (sender, request) => {
          var headers = request.Request.Headers;
          var gate = request.Request.Uri.Contains("/watch/stream-gate/");
          foreach (var name in new[] { "Sec-CH-UA", "Sec-CH-UA-Mobile", "Sec-CH-UA-Platform" }) {
            if (gate && !headers.Contains(name) && clientHints.ContainsKey(name)) headers.SetHeader(name, clientHints[name]);
            else if (!gate && headers.Contains(name)) clientHints[name] = headers.GetHeader(name);
          }
        };
        core.NewWindowRequested += (sender, request) => { request.Handled = true; };
        core.NavigationStarting += (sender, request) => {
          Uri target;
          if (!Uri.TryCreate(request.Uri, UriKind.Absolute, out target) || target.Scheme != "https" ||
              (!Regex.IsMatch(target.Host, @"^(?:[^.]+\.)?(?:vik(?:i|1)ngfile\.(?:com|site)|vk\.(?:com|ru)|vkvideo\.ru|(?:witanime|anime4up|streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix)\.[a-z]+)$") && target.Host != url.Host)) request.Cancel = true;
        };
        core.WebMessageReceived += (sender, message) => {
          if (message.Source != core.Source) return;
          try {
            var result = json.Deserialize<Dictionary<string, object>>(message.WebMessageAsJson);
            if (!result.ContainsKey("pantoufaResult")) return;
            Console.WriteLine(message.WebMessageAsJson);
            form.Close();
          } catch {}
        };
        core.WebResourceResponseReceived += async (sender, response) => {
          var gate = Regex.Match(response.Request.Uri, @"^https://witanime\.site/watch/stream-gate/([a-f0-9]{64})$");
          if (!gate.Success || response.Response.StatusCode < 300 || response.Response.StatusCode > 399) return;
          try {
            var target = response.Response.Headers.GetHeader("Location");
            Uri destination;
            if (!Uri.TryCreate(target, UriKind.Absolute, out destination) || !Regex.IsMatch(destination.Scheme, "^https?$")) return;
            await core.ExecuteScriptAsync("window.__pantoufaGateRedirects=window.__pantoufaGateRedirects||{};window.__pantoufaGateRedirects[" + json.Serialize(gate.Groups[1].Value) + "]=" + json.Serialize(target));
          } catch {}
        };
        if (job.ContainsKey("injectBefore") && job["injectBefore"] is string)
          await core.AddScriptToExecuteOnDocumentCreatedAsync((string)job["injectBefore"]);
        core.DOMContentLoaded += async (sender, ready) => {
          try {
            await core.ExecuteScriptAsync("Promise.resolve().then(()=>eval(" + json.Serialize(script) + ")).then(pantoufaResult=>window.chrome.webview.postMessage({pantoufaResult})).catch(()=>window.chrome.webview.postMessage({pantoufaResult:null}));");
          } catch {}
        };
        core.Navigate(url.ToString());
        timer.Start();
      } catch (Exception error) { Console.Error.WriteLine(error.Message); form.Close(); }
    };
    Application.Run(form);
    timer.Dispose();
  }
}
