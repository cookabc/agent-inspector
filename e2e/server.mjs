// Static-only fixture host. No production scanner, database or write API is loaded.
import http from "node:http";
import { fixturePayload } from "./data.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("../public/", import.meta.url)));
http
  .createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("APIs disabled in browser fixtures");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const data = fixturePayload(url);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(data ? 200 : 405);
      res.end(JSON.stringify(data || { error: "Unsupported fixture API" }));
      return;
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html",
      );
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(Number(process.env.FIXTURE_PORT) || 4386, "127.0.0.1");
