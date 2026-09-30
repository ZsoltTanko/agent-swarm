/**
 * Development entry (`npm run ui:dev`): the API on 127.0.0.1:5199 and a Vite dev server on 5198
 * with hot reload. vite.config.ts at the project root proxies /api to the API server.
 */
import { resolve } from "node:path";
import { createServer } from "vite";
import { startServer } from "./app.ts";

const API_PORT = 5199;

const root = process.cwd();

try {
  const api = await startServer({
    runsDir: resolve(root, "runs"),
    cacheDir: resolve(root, "cache"),
    port: API_PORT,
    hostname: "127.0.0.1",
  });
  const vite = await createServer({ configFile: resolve(root, "vite.config.ts") });
  await vite.listen();
  const uiUrl = vite.resolvedUrls?.local[0] ?? `http://localhost:${vite.config.server.port}/`;
  console.log(`Swarm observer (dev): ${uiUrl}`);
  console.log(`API server:           ${api.url}`);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === "EADDRINUSE" ? `Port ${API_PORT} is already in use.` : error);
  process.exit(1);
}
