/**
 * Production entry: serves the built UI (dist/ui) and the API on 127.0.0.1.
 *   tsx src/server/index.ts [--runs <dir>] [--cache <dir>]      (PORT overrides the default 5199)
 * `npm run ui` builds the UI first and then runs this.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "./app.ts";

const HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 5199;

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "runs" },
    cache: { type: "string", default: "cache" },
  },
});

const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be an integer between 0 and 65535 (got "${process.env.PORT}").`);
  process.exit(1);
}

const root = process.cwd();
const uiDir = resolve(root, "dist/ui");
const hasUi = existsSync(join(uiDir, "index.html"));

try {
  const { url } = await startServer({
    runsDir: resolve(root, values.runs),
    cacheDir: resolve(root, values.cache),
    uiDir: hasUi ? uiDir : undefined,
    port,
    hostname: HOSTNAME,
  });
  console.log(`Swarm observer: ${url}`);
  if (!hasUi) {
    console.log('dist/ui/index.html is missing, so only the API is served. Use "npm run ui", which builds the UI first.');
  }
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === "EADDRINUSE" ? `Port ${port} is already in use; set PORT to use another.` : error);
  process.exit(1);
}
