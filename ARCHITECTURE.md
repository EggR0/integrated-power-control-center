# Integrated Power Control Center Architecture

## Overview

The Integrated Power Control Center is an independent, local-first Multi-AI orchestrator designed to operate as a loopback broker (`127.0.0.1:37241`). It provides standard interfaces for inbound host agents (ChatGPT, Claude, Antigravity) and outbound worker executors (Local LLMs, Codex, Agy CLI).

## Architecture Layers

```
┌───────────────────────────────────────────────────────────────┐
│                     Desktop GUI (Tauri 2)                     │
│  - Real-time Agent Status & Health Monitoring                 │
│  - 1-Click MCP Setup & Auto-Registration                      │
│  - Human-in-the-Loop Approval Queue                           │
└──────────────────────────────┬────────────────────────────────┘
                               │ Loopback HTTP / IPC
┌──────────────────────────────▼────────────────────────────────┐
│               Integrated Power Broker Engine                   │
│  ┌─────────────────────────┐   ┌───────────────────────────┐  │
│  │   Universal MCP Server  │   │  A2A v1 Protocol Engine   │  │
│  │   (/mcp, stdio)         │   │  (/message:send, cards)   │  │
│  └─────────────────────────┘   └───────────────────────────┘  │
│  ┌─────────────────────────┐   ┌───────────────────────────┐  │
│  │  AG-UI Task SSE Stream  │   │ Encrypted Event Ledger    │  │
│  │  (/v1/tasks/:id/stream) │   │ (SQLCipher / DPAPI)       │  │
│  └─────────────────────────┘   └───────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────┘
                               │ Delegation & Worktree Management
┌──────────────────────────────▼────────────────────────────────┐
│                   Execution Adapters Layer                    │
│  - OpenAiCompatibleLocalAdapter (Ollama / vLLM / Qwen 27B)    │
│  - CodexAppServerAdapter (Official stdio JSON-RPC)            │
│  - AgyCliAdapter (agy CLI accept-edits)                       │
└───────────────────────────────────────────────────────────────┘
```

## Security & Privacy Principles

1. **Zero GUI Credential Theft**:
   - The broker never attempts to read browser session cookies, extract API keys from other apps' GUI windows, or drive third-party UI through accessibility scrapers.
2. **Loopback Only**:
   - All server endpoints strictly bind to `127.0.0.1`.
3. **Encrypted State Ledger**:
   - Event histories, approvals, and metrics are encrypted on disk using SQLCipher / Windows DPAPI / macOS Keychain.
4. **Approval Gate for Destructive Actions**:
   - Worktree code merge and external data transfers require explicit confirmation through the Control Center UI before execution.
