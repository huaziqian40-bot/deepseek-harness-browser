import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
const root = "D:/browser/poster";
const types = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(root, p === "/" ? "xinlv-poster.html" : decodeURIComponent(p));
    const data = await fsp.readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(4174, "127.0.0.1", () => console.log("poster server on http://127.0.0.1:4174/"));
