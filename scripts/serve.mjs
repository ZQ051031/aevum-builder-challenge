import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MIME = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", md: "text/plain" };
const LOCAL_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_call",
  "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_sendTransaction",
]);

export async function serve({ config, rpcUrl } = {}) {
  const host = process.env.WEB_HOST || "127.0.0.1";
  const port = Number(process.env.WEB_PORT || "8080");
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (config && path === "/local-rpc" && req.method === "POST") {
      return proxyLocal(req, res, rpcUrl, config.actors);
    }
    if (!["GET", "HEAD"].includes(req.method)) return reply(res, 405, "Method not allowed");
    if (config && path === "/local-config.json") {
      res.setHeader("Cache-Control", "no-store");
      return reply(res, 200, JSON.stringify(config), "application/json");
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^(?:vendor\/)?[a-zA-Z][a-zA-Z0-9_.-]*$/.test(file)) return reply(res, 404, "Not found");
    const type = MIME[file.split(".").at(-1)];
    if (!type) return reply(res, 404, "Not found");
    try {
      const body = await readFile(new URL(`../web/${file}`, import.meta.url));
      reply(res, 200, req.method === "HEAD" ? "" : body, type);
    } catch {
      reply(res, 404, "Not found");
    }
  });

  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  console.log(`Aevum Pay ${config ? "local simulation" : "testnet interface"} at http://localhost:${server.address().port}`);
  return server;
}

async function proxyLocal(req, res, rpcUrl, actors) {
  if (req.headers.origin !== `http://${req.headers.host}` ||
      !["localhost", "127.0.0.1"].includes(req.headers.host.split(":")[0])) {
    return reply(res, 403, "Local demo requires a same-origin loopback browser.");
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32_768) return reply(res, 413, "RPC body too large.");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const { method, params } = JSON.parse(body);
    const from = params?.[0]?.from?.toLowerCase();
    if (!LOCAL_METHODS.has(method) ||
        (method === "eth_sendTransaction" && !Object.values(actors).includes(from))) {
      return reply(res, 403, "RPC method or sender unavailable.");
    }
    const upstream = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000),
    });
    reply(res, upstream.status, await upstream.text(), "application/json");
  } catch {
    reply(res, 400, "Invalid or unavailable local RPC request.");
  }
}

function reply(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
