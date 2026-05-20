const http = require("http");
const { spawn } = require("child_process");

function parseArgs(argv) {
  const options = {
    port: 4174,
    vrUrl: "",
    desktopUrl: "",
    stopScript: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--vrUrl" && next) {
      options.vrUrl = next;
      index += 1;
    } else if (arg === "--desktopUrl" && next) {
      options.desktopUrl = next;
      index += 1;
    } else if (arg === "--stopScript" && next) {
      options.stopScript = next;
      index += 1;
    }
  }

  if (!options.stopScript) {
    throw new Error("Missing required --stopScript.");
  }

  return options;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusPage({ vrUrl, desktopUrl }) {
  const lines = [];
  if (vrUrl) {
    lines.push(`<li><span>VR</span><a href="${escapeHtml(vrUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(vrUrl)}</a></li>`);
  }
  if (desktopUrl) {
    lines.push(`<li><span>Desktop</span><a href="${escapeHtml(desktopUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(desktopUrl)}</a></li>`);
  }
  if (!lines.length) {
    lines.push(`<li><span>LAN</span><div class="empty-state">No LAN IPv4 address was detected for this session.</div></li>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>St. Louis Demo Session</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --text: #edf4ff;
      --muted: #b5c6e3;
      --accent: #7dd3fc;
      --success: #34d399;
      --border: #2d4267;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(circle at top, #173052, var(--bg) 58%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }
    .shell {
      width: min(760px, 100%);
      background: rgba(10, 18, 32, 0.88);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 26px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }
    .eyebrow {
      margin: 0 0 8px;
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 34px;
      line-height: 1.1;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: rgba(52, 211, 153, 0.14);
      border: 1px solid rgba(52, 211, 153, 0.4);
      border-radius: 999px;
      color: #d8fff1;
      font-weight: 600;
      margin-bottom: 18px;
    }
    .status::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 6px rgba(52, 211, 153, 0.18);
    }
    .card {
      background: linear-gradient(180deg, rgba(27, 41, 69, 0.92), rgba(16, 28, 49, 0.92));
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px 18px;
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 17px;
    }
    .link-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 10px;
    }
    .link-list li {
      display: grid;
      gap: 4px;
    }
    .link-list span {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .link-list a {
      color: var(--text);
      word-break: break-all;
    }
    .link-list a:hover { color: var(--accent); }
    .actions {
      margin-top: 22px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 12px 18px;
      font-size: 15px;
      font-weight: 700;
      background: linear-gradient(180deg, #fb7185, #ef4444);
      color: white;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(239, 68, 68, 0.28);
    }
    button:disabled { opacity: 0.65; cursor: default; }
  </style>
</head>
<body>
  <main class="shell">
    <p class="eyebrow">One-Click Demo Launcher</p>
    <h1>St. Louis Session Status</h1>
    <div class="status">Session running</div>
    <section class="card">
      <h2>LAN Session Links</h2>
      <ul class="link-list">
        ${lines.join("\n")}
      </ul>
    </section>
    <div class="actions">
      <button id="stopButton" type="button">Stop Session</button>
    </div>
  </main>
  <script>
    const stopButton = document.getElementById('stopButton');
    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true;
      stopButton.textContent = 'Stopping...';
      try {
        const response = await fetch('/stop', { method: 'POST' });
        document.open();
        document.write(await response.text());
        document.close();
      } catch (error) {
        stopButton.disabled = false;
        stopButton.textContent = 'Stop Session';
        alert('Stop request failed. Close the session with the existing stop script if needed.');
      }
    });
  </script>
</body>
</html>`;
}

function stoppedPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>St. Louis Session Stopped</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0b1220;
      color: #edf4ff;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    .card {
      max-width: 520px;
      padding: 28px 30px;
      border-radius: 22px;
      background: #132038;
      border: 1px solid #2d4267;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
      text-align: center;
    }
    h1 { margin: 0 0 12px; }
    p { margin: 0; color: #b5c6e3; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Session stopped</h1>
    <p>The St. Louis demo session has been shut down cleanly.</p>
  </div>
</body>
</html>`;
}

function sendHtml(response, html, statusCode = 200) {
  const body = Buffer.from(html, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  response.end(body);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let stopping = false;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${options.port}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, statusPage(options));
      return;
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      if (stopping) {
        sendHtml(response, stoppedPage());
        return;
      }

      stopping = true;
      const child = spawn(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          options.stopScript,
        ],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );

      child.on("error", () => {
        stopping = false;
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Stop request failed.");
      });

      child.on("exit", () => {
        sendHtml(response, stoppedPage());
        setTimeout(() => {
          server.close(() => process.exit(0));
        }, 250);
      });

      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`Status page on http://127.0.0.1:${options.port}/`);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
