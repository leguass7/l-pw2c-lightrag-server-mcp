import {
  loadConfigFromEnv,
  loadHttpOverrideSettingsFromEnv,
} from "./config.js";
import { SessionOverrideStore } from "./lightrag-session.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./transport/http.js";
import { startStdioServer } from "./transport/stdio.js";

async function main(): Promise<void> {
  const isHttpMode = process.argv.slice(2).includes("--sse");

  if (isHttpMode) {
    const envConfig = loadConfigFromEnv();
    const httpSettings = loadHttpOverrideSettingsFromEnv();
    const sessionStore = new SessionOverrideStore(envConfig, httpSettings);
    await startHttpServer({
      sessionStore,
      createMcpServer: () => createMcpServer(undefined, { sessionStore }),
    });
  } else {
    const server = createMcpServer();
    await startStdioServer(server);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("l-pw2c-lightrag-server-mcp fatal:", msg);
  process.exit(1);
});
