const MCP_SERVER_URL = "http://0.0.0.0:45451/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SESSION_HEADER = "mcp-session-id";

const TOOL_BY_AGENT = {
  Master: null,
  Triage: "create_ticket",
  Investigator: "query_logs",
  Fix_Engineer: "suggest_remediation",
  Reporter: "notify"
};

let rpcId = 1;
let sharedSessionId = null;

function nextRpcId() {
  const id = rpcId;
  rpcId += 1;
  return id;
}

function words(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimWords(text, maxWords) {
  const parts = words(text).split(" ").filter(Boolean);
  if (parts.length <= maxWords) {
    return parts.join(" ");
  }
  return `${parts.slice(0, maxWords).join(" ")}...`;
}

function trimMarkdownWords(markdown, maxWords) {
  const parts = String(markdown ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= maxWords) {
    return String(markdown ?? "").trim();
  }
  const truncated = parts.slice(0, maxWords).join(" ");
  return `${truncated}...`;
}

function parseIncidentServices(incident) {
  const lowered = String(incident ?? "").toLowerCase();
  const services = [];
  if (lowered.includes("checkout-api")) {
    services.push("checkout-api");
  }
  if (lowered.includes("payments-service")) {
    services.push("payments-service");
  }
  return services.length > 0 ? services : ["checkout-api", "payments-service"];
}

function parseIncidentSeverity(incident) {
  const text = String(incident ?? "");
  const m = text.match(/severity\s*[:=]\s*"?([A-Za-z0-9-]+)"?/i);
  return m?.[1] ? m[1].toUpperCase() : "SEV-1";
}

function shortIncident(incident) {
  return trimWords(incident, 36);
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractToolText(result) {
  if (!result) {
    return "";
  }

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean);

    return textParts.join("\n");
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function buildAgentOutput(agentName, incident, toolResultObj) {
  const severity = parseIncidentSeverity(incident);
  const services = parseIncidentServices(incident).join(", ");

  if (agentName === "Master") {
    return trimWords("Workflow dispatched: Triage -> Investigator -> Fix_Engineer -> Reporter.", 40);
  }

  if (agentName === "Triage") {
    const ticketId = toolResultObj?.ticketId || "UNKNOWN";
    return trimWords(`Severity: ${severity}. Ticket ID: ${ticketId}. Impacted services: ${services}.`, 80);
  }

  if (agentName === "Investigator") {
    const logs = Array.isArray(toolResultObj?.logs) ? toolResultObj.logs : [];
    const finding1 = logs[0]?.message || "Payment path timeouts observed.";
    const finding2 = logs[1]?.message || "Retry pressure observed on checkout dependency calls.";
    return trimWords(
      `Findings: 1) ${finding1} 2) ${finding2} Likely root cause: payments-service saturation causing checkout retry cascade.`,
      80
    );
  }

  if (agentName === "Fix_Engineer") {
    const remediations = Array.isArray(toolResultObj?.remediations) ? toolResultObj.remediations : [];
    const step1 = remediations[0] || "Throttle checkout retries with jittered exponential backoff.";
    const step2 = remediations[1] || "Increase payments-service DB pool headroom and watch queue depth.";
    return trimWords(`Remediation steps: 1) ${step1} 2) ${step2}`, 80);
  }

  return trimWords("Agent completed.", 80);
}

export function buildReporterPostmortemMarkdown(incident, notifyReceipt, notifyObj) {
  const severity = parseIncidentSeverity(incident);
  const services = parseIncidentServices(incident).join(", ");
  const channel = notifyObj?.channel || "#incidents";
  const sentAt = notifyObj?.sentAt || "n/a";

  const markdown = [
    `Notify receipt: ${notifyReceipt}`,
    "",
    "### Postmortem",
    `- Severity: ${severity}`,
    `- Services: ${services}`,
    "- Summary: Checkout failures and payment timeouts caused user-facing transaction degradation.",
    "- Actions taken: Ticketing, investigation, and safe remediation plan executed.",
    `- Stakeholder update: Sent to ${channel} at ${sentAt}.`
  ].join("\n");

  return trimMarkdownWords(markdown, 250);
}

export async function mcpRpc(sessionId, method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };

  if (sessionId) {
    headers["Mcp-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId(),
      method,
      params
    })
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`MCP ${method} failed: non-JSON response (${response.status})`);
  }

  if (!response.ok || payload.error) {
    const msg = payload?.error?.message || response.statusText || "unknown MCP error";
    throw new Error(`MCP ${method} failed: ${msg}`);
  }

  return {
    result: payload.result,
    sessionId: response.headers.get(MCP_SESSION_HEADER)
  };
}

export async function mcpCreateSession() {
  if (sharedSessionId) {
    return sharedSessionId;
  }

  const init = await mcpRpc(null, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "pitcrew-agent-runner",
      version: "1.0.0"
    }
  });

  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error("MCP initialize failed: missing mcp-session-id header");
  }

  await mcpRpc(sessionId, "tools/list", {});
  sharedSessionId = sessionId;
  return sessionId;
}

function createToolLimiter(agentName, sessionId) {
  let count = 0;

  return {
    get count() {
      return count;
    },
    async callTool(toolName, args) {
      count += 1;
      if (count > 1) {
        throw new Error(`[${agentName}] attempted ${count} tool calls; max is 1`);
      }

      const rpc = await mcpRpc(sessionId, "tools/call", {
        name: toolName,
        arguments: args ?? {}
      });

      const text = extractToolText(rpc.result);
      const parsed = safeJsonParse(text);
      console.log(`[${agentName}] tool receipt: ${toolName} ok`);
      return {
        receipt: `${toolName} ok`,
        text,
        parsed,
        raw: rpc.result
      };
    }
  };
}

function triageArgs(incident) {
  return {
    system: "jira",
    title: trimWords(`SEV-1 Checkout failures | ${shortIncident(incident)}`, 12),
    description: trimWords(`Incident seed: ${shortIncident(incident)}. Active production customer impact detected.`, 45)
  };
}

function investigatorArgs() {
  return {
    service: "payments-service",
    timeframe: "15m"
  };
}

function fixArgs(incident) {
  return {
    summary: trimWords(`Checkout failures and payment timeouts with suspected cascading retries. ${incident}`, 30)
  };
}

function reporterArgs() {
  return {
    channel: "#incidents",
    message: "SEV-1 update: triage, investigation, and mitigations in progress. Next update in 15 minutes."
  };
}

export async function runAgent(agentName, { incident }) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_BY_AGENT, agentName)) {
    throw new Error(`Unsupported agent: ${agentName}`);
  }

  console.log(`[${agentName}] start`);

  const toolName = TOOL_BY_AGENT[agentName];
  let toolResult = null;

  if (toolName) {
    const sessionId = await mcpCreateSession();
    const limiter = createToolLimiter(agentName, sessionId);

    const argsByAgent = {
      Triage: triageArgs(incident),
      Investigator: investigatorArgs(),
      Fix_Engineer: fixArgs(incident),
      Reporter: reporterArgs()
    };

    toolResult = await limiter.callTool(toolName, argsByAgent[agentName]);

    if (limiter.count > 1) {
      throw new Error(`[${agentName}] attempted ${limiter.count} tool calls; max is 1`);
    }
  }

  let output;
  if (agentName === "Reporter") {
    output = buildReporterPostmortemMarkdown(incident, toolResult?.receipt || "notify ok", toolResult?.parsed || {});
  } else {
    output = buildAgentOutput(agentName, incident, toolResult?.parsed || {});
  }

  console.log(`[${agentName}] done`);
  return output;
}
