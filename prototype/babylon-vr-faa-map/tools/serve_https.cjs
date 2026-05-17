const fs = require("fs");
const https = require("https");
const path = require("path");

function parseArgs(argv) {
  const options = {
    host: "0.0.0.0",
    port: 4443,
    directory: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--directory" && next) {
      options.directory = next;
      index += 1;
    } else if (arg === "--pfxfile" && next) {
      options.pfxfile = next;
      index += 1;
    } else if (arg === "--passphrase" && next) {
      options.passphrase = next;
      index += 1;
    }
  }

  if (!options.pfxfile || !options.passphrase) {
    throw new Error("Missing required --pfxfile or --passphrase.");
  }

  return options;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function safePath(rootDirectory, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.normalize(path.join(rootDirectory, normalized));
  const relative = path.relative(rootDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extension] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(response);
}

function startServer() {
  const options = parseArgs(process.argv.slice(2));
  const rootDirectory = path.resolve(options.directory);
  const pfx = fs.readFileSync(path.resolve(options.pfxfile));

  const server = https.createServer(
    {
      pfx,
      passphrase: options.passphrase,
      minVersion: "TLSv1.2",
    },
    (request, response) => {
      const target = safePath(rootDirectory, request.url || "/");
      if (!target) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }

      let filePath = target;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      sendFile(response, filePath);
    },
  );

  server.listen(options.port, options.host, () => {
    console.log(`Serving HTTPS from ${rootDirectory}`);
    console.log(`Bound to https://${options.host}:${options.port}`);
  });
}

startServer();
