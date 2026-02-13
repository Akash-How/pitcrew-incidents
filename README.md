# PitCrew Incidents (Archestra.AI)

**PitCrew Incidents** is a hackathon-ready, multi-agent incident response workflow built inside **Archestra.AI**.

It demonstrates **real tool-driven agent behavior** (no fake outputs) across:
- **Grafana MCP** (Prometheus evidence)
- **GitHub MCP** (auto-creates incident issues)
- **Slack MCP** (posts stakeholder updates)
- **Archestra Artifacts** (writes a clean incident report)

---

## 🚀 What This Project Does

Given a single incident prompt like:

> `SEV-1: Checkout failing, 5xx spike. Run full workflow.`

PitCrew automatically runs a strict workflow:

1. **TRIAGE**  
   Confirms monitoring health using Grafana (`up`)

2. **INVESTIGATOR**  
   Collects Grafana CPU evidence (PromQL)

3. **FIX ENGINEER**  
   Creates a GitHub issue in this repo with evidence + mitigation plan

4. **REPORTER**  
   Posts a tiny update in Slack `#incidents` including the GitHub URL

5. **MASTER AGENT**  
   Writes a final postmortem into an Archestra artifact

---

## 🧠 Why It’s Cool

Most agent demos fake tool outputs.

This project proves:
- Real MCP tool calls
- Real Grafana Prometheus metrics
- Real GitHub issue creation
- Real Slack posting
- Evidence-driven incident writeups

---

## 🔧 Stack

- **Archestra.AI** (multi-agent runtime + UI)
- **Grafana Cloud Free Tier**
- **Prometheus metrics via Node Exporter**
- **Grafana Alloy** (scrape + remote_write)
- **GitHub MCP**
- **Slack MCP**

---

## 📊 Grafana Evidence Used

This demo intentionally uses simple, high-signal PromQL:

- `up`
- CPU%:
