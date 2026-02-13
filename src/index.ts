import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";


type Severity = "P1" | "P2" | "P3";

type Alert = {
  id: string;
  severity: Severity;
  service: string;
  title: string;
  createdAt: string;
  signal: string;
};

type LogEntry = {
  timestamp: string;
  service: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  traceId: string;
};

type CliTransport = "stdio" | "http" | "streamable-http";

type CliOptions = {
  transport: CliTransport;
  port: number;
  host: string;
};

type SessionState = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const parseCliOptions = (argv: string[]): CliOptions => {
  let transport: CliTransport = "stdio";
  let port = 45451;
  let host = "0.0.0.0";

  for (const arg of argv) {
    if (arg.startsWith("--transport=")) {
      const value = arg.split("=")[1]?.trim().toLowerCase();
      if (value === "stdio" || value === "http" || value === "streamable-http") {
        transport = value;
      } else {
        throw new Error("Invalid --transport value. Use stdio, http, or streamable-http.");
      }
      continue;
    }

    if (arg.startsWith("--port=")) {
      const raw = arg.split("=")[1]?.trim();
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error("Invalid --port value. Use an integer between 1 and 65535.");
      }
      port = parsed;
      continue;
    }

    if (arg.startsWith("--host=")) {
      const raw = arg.split("=")[1]?.trim();
      if (!raw) {
        throw new Error("Invalid --host value. Use a non-empty host string.");
      }
      host = raw;
    }
  }

  return { transport, port, host };
};

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const alerts: Alert[] = [
  {
    id: "ALT-1001",
    severity: "P1",
    service: "payments-service",
    title: "Database connection pool saturation > 95%",
    createdAt: minutesAgo(4),
    signal: "pool_exhaustion"
  },
  {
    id: "ALT-1002",
    severity: "P2",
    service: "checkout-api",
    title: "5xx rate breached 3% for 10m",
    createdAt: minutesAgo(9),
    signal: "http_5xx_burn_rate"
  },
  {
    id: "ALT-1003",
    severity: "P3",
    service: "orders-read-model",
    title: "P95 latency above 800ms",
    createdAt: minutesAgo(22),
    signal: "latency_p95"
  }
];

const demoLogs: LogEntry[] = [
  {
    timestamp: minutesAgo(14),
    service: "checkout-api",
    level: "ERROR",
    message: "POST /checkout failed with 502: upstream payments-service timeout",
    traceId: "trc-9d21"
  },
  {
    timestamp: minutesAgo(13),
    service: "checkout-api",
    level: "ERROR",
    message: "Circuit breaker open for payments-service after 30 consecutive failures",
    traceId: "trc-9d22"
  },
  {
    timestamp: minutesAgo(12),
    service: "payments-service",
    level: "WARN",
    message: "db pool usage 48/50 active, queue depth=12",
    traceId: "trc-a101"
  },
  {
    timestamp: minutesAgo(11),
    service: "payments-service",
    level: "ERROR",
    message: "Failed to acquire DB connection: pool exhausted (timeout 2000ms)",
    traceId: "trc-a102"
  },
  {
    timestamp: minutesAgo(10),
    service: "payments-service",
    level: "WARN",
    message: "Slow query detected (3120ms): SELECT * FROM payment_attempts WHERE status='pending'",
    traceId: "trc-a103"
  },
  {
    timestamp: minutesAgo(9),
    service: "payments-service",
    level: "WARN",
    message: "Slow query detected (2870ms): UPDATE ledger_entries SET settled=true",
    traceId: "trc-a104"
  },
  {
    timestamp: minutesAgo(8),
    service: "checkout-api",
    level: "WARN",
    message: "Retry storm detected: avg retries/request spiked to 6.7",
    traceId: "trc-9d25"
  },
  {
    timestamp: minutesAgo(7),
    service: "checkout-api",
    level: "ERROR",
    message: "Request failed after max retries to payments-service",
    traceId: "trc-9d26"
  },
  {
    timestamp: minutesAgo(6),
    service: "payments-service",
    level: "ERROR",
    message: "Transaction rollback due to lock wait timeout",
    traceId: "trc-a107"
  },
  {
    timestamp: minutesAgo(5),
    service: "checkout-api",
    level: "INFO",
    message: "Fallback payment path engaged for degraded dependency mode",
    traceId: "trc-9d28"
  }
];

const parseTimeframeMinutes = (timeframe: string): number => {
  const match = timeframe.trim().match(/^(\d+)(m|h)$/i);
  if (!match) {
    throw new Error("Invalid timeframe. Use values like 5m, 15m, or 1h.");
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return unit === "h" ? value * 60 : value;
};

const toTextResponse = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
});

const createMcpServer = (): McpServer => {
  const server = new McpServer({
    name: "pitcrew-mcp",
    version: "1.0.0"
  });

  server.tool(
    "fetch_alerts",
    "Fetch latest active alerts from monitoring",
    {},
    async () => {
      const sorted = [...alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return toTextResponse({ count: sorted.length, alerts: sorted });
    }
  );

  server.tool(
    "query_logs",
    "Query logs for a service within a timeframe (e.g. 5m, 15m, 1h)",
    {
      service: z.string().min(1),
      timeframe: z.string().regex(/^\d+(m|h)$/i)
    },
    async ({ service, timeframe }) => {
      const minutes = parseTimeframeMinutes(timeframe);
      const cutoffMs = Date.now() - minutes * 60_000;

      const rows = demoLogs
        .filter((entry) => entry.service.toLowerCase() === service.toLowerCase())
        .filter((entry) => Date.parse(entry.timestamp) >= cutoffMs)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      return toTextResponse({ service, timeframe, count: rows.length, logs: rows });
    }
  );

  server.tool(
    "summarize_logs",
    "Summarize raw log lines into an SRE-friendly incident narrative",
    {
      logs: z.any()
    },
    async ({ logs }) => {
      const normalized: LogEntry[] = Array.isArray(logs)
        ? (logs as LogEntry[])
        : typeof logs === "string"
          ? logs
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((line, idx) => ({
                timestamp: new Date().toISOString(),
                service: "unknown",
                level: /error/i.test(line) ? "ERROR" : /warn/i.test(line) ? "WARN" : "INFO",
                message: line,
                traceId: `raw-${idx + 1}`
              }))
          : [];

      const errorCount = normalized.filter((l) => l.level === "ERROR").length;
      const warnCount = normalized.filter((l) => l.level === "WARN").length;
      const services = [...new Set(normalized.map((l) => l.service))];

      const narrative = [
        `Incident involves ${services.length || 0} service(s): ${services.join(", ") || "none identified"}.`,
        `Observed ${errorCount} error log(s) and ${warnCount} warning log(s).`,
        "Pattern suggests payments-service database saturation cascaded into checkout-api retry amplification.",
        "Customer impact likely includes intermittent checkout failures and elevated latency."
      ].join(" ");

      return toTextResponse({
        summary: narrative,
        indicators: {
          services,
          errorCount,
          warnCount,
          likelyRootCause: "payments-service DB pool exhaustion with downstream retry storm"
        }
      });
    }
  );

  server.tool(
    "suggest_remediation",
    "Suggest safe remediation steps based on the incident summary",
    {
      summary: z.any()
    },
    async ({ summary }) => {
      const summaryText = typeof summary === "string" ? summary : JSON.stringify(summary);

      const actions = [
        "Throttle checkout-api retries and enforce jittered exponential backoff.",
        "Increase payments-service DB pool capacity temporarily and verify DB CPU/headroom.",
        "Kill or tune the top slow SQL statements and add missing indexes for payment_attempts lookups.",
        "Enable degraded mode for non-critical payment enrichments to reduce DB contention.",
        "Set short-term SLO guardrails and monitor 5xx, queue depth, and connection acquisition latency."
      ];

      return toTextResponse({
        basedOn: summaryText,
        remediations: actions,
        safetyNote: "Prefer reversible actions first; validate each change with metrics before proceeding."
      });
    }
  );

  server.tool(
    "create_ticket",
    "Create an incident ticket in a system like Jira/ServiceNow/GitHub (demo stub)",
    {
      system: z.enum(["jira", "servicenow", "github"]),
      title: z.string().min(3),
      description: z.string().min(10)
    },
    async ({ system, title, description }) => {
      const ticketId = `${system.toUpperCase()}-${Math.floor(Math.random() * 90000 + 10000)}`;

      return toTextResponse({
        status: "created",
        system,
        ticketId,
        title,
        description,
        url: `https://${system}.example.local/incidents/${ticketId.toLowerCase()}`,
        createdAt: new Date().toISOString()
      });
    }
  );

  server.tool(
    "notify",
    "Send a message to a channel (Slack/Teams) - demo stub",
    {
      channel: z.string().min(1),
      message: z.string().min(1)
    },
    async ({ channel, message }) => {
      return toTextResponse({
        status: "sent",
        channel,
        message,
        sentAt: new Date().toISOString(),
        provider: channel.toLowerCase().includes("teams") ? "teams" : "slack"
      });
    }
  );

  return server;
};

const getSessionIdHeader = (req: IncomingMessage): string | undefined => {
  const value = req.headers["mcp-session-id"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const ensureAcceptHeader = (req: IncomingMessage): void => {
  const accept = req.headers.accept;
  if (!accept || !accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }
};

const writeJsonError = (res: ServerResponse, statusCode: number, code: number, message: string): void => {
  if (res.headersSent) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null
    })
  );
};

const createSessionState = async (): Promise<SessionState> => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true
  });
  await server.connect(transport);
  return { server, transport };
};

let activeHttpServer: HttpServer | undefined;
let activeStdioServer: McpServer | undefined;
const activeSessions = new Map<string, SessionState>();

const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/mcp") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  ensureAcceptHeader(req);

  const method = (req.method ?? "GET").toUpperCase();
  const sessionId = getSessionIdHeader(req);

  let state: SessionState | undefined;
  let createdForRequest = false;

  if (sessionId) {
    state = activeSessions.get(sessionId);
    if (!state) {
      writeJsonError(res, 404, -32001, "Session not found");
      return;
    }
  } else if (method === "POST") {
    state = await createSessionState();
    createdForRequest = true;
  } else {
    writeJsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  try {
    await state.transport.handleRequest(req, res);

    const establishedSessionId = state.transport.sessionId;
    if (establishedSessionId && !activeSessions.has(establishedSessionId)) {
      activeSessions.set(establishedSessionId, state);
    }

    if (createdForRequest && !establishedSessionId) {
      await state.transport.close();
      await state.server.close();
    }

    if (method === "DELETE" && sessionId) {
      activeSessions.delete(sessionId);
      await state.server.close();
    }
  } catch (error) {
    if (createdForRequest) {
      await state.transport.close().catch(() => undefined);
      await state.server.close().catch(() => undefined);
    }
    console.error("HTTP transport request error:", error);
    writeJsonError(res, 500, -32603, "Internal server error");
  }
};

const main = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.transport === "stdio") {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    activeStdioServer = server;
    console.log("pitcrew-mcp server started on stdio transport");
    return;
  }

  if (options.transport === "http" || options.transport === "streamable-http") {
    const httpServer = http.createServer((req, res) => {
      void handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });

    activeHttpServer = httpServer;

    console.log(
      `pitcrew-mcp server started on HTTP transport (${options.transport}) at http://${options.host}:${options.port}/mcp`
    );

    return;
  }

  throw new Error(`Unknown transport: ${options.transport}`);
};

const shutdown = async (): Promise<void> => {
  if (activeHttpServer) {
    await new Promise<void>((resolve, reject) => {
      activeHttpServer?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  for (const [sessionId, state] of activeSessions) {
    activeSessions.delete(sessionId);
    await state.transport.close().catch(() => undefined);
    await state.server.close().catch(() => undefined);
  }

  if (activeStdioServer) {
    await activeStdioServer.close().catch(() => undefined);
  }

  process.exit(0);
};

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});




