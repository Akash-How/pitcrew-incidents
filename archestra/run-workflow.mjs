import fs from "node:fs";
import { runAgent } from "../src/agent-runner.js";

async function main() {
  const seedPath = process.argv[2] || "demo/incident_seed.txt";
  const incidentSeed = fs.readFileSync(seedPath, "utf-8");

  console.log(`=== PitCrew MCP Incident Commander Demo (seed: ${seedPath}) ===\n`);

  const masterOut = await runAgent("Master", { incident: incidentSeed });
  console.log("\n--- MASTER ---\n" + masterOut + "\n");

  const triageOut = await runAgent("Triage", { incident: incidentSeed });
  console.log("\n--- TRIAGE ---\n" + triageOut + "\n");

  const invOut = await runAgent("Investigator", { incident: incidentSeed });
  console.log("\n--- INVESTIGATOR ---\n" + invOut + "\n");

  const fixOut = await runAgent("Fix_Engineer", { incident: incidentSeed });
  console.log("\n--- FIX_ENGINEER ---\n" + fixOut + "\n");

  const repOut = await runAgent("Reporter", { incident: incidentSeed });
  console.log("\n--- REPORTER ---\n" + repOut + "\n");

  console.log("=== Workflow Completed ===");
  console.log("Summary: Master -> Triage -> Investigator -> Fix_Engineer -> Reporter (all completed)");
}

try {
  await main();
} catch (e) {
  console.error("Workflow failed:", e.message);
  process.exit(1);
}
