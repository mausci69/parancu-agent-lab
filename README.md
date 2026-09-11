# ParancU API 0.1

ParancU API exposes ParancU retrieval as a local HTTP service and connects it to Slack.

The goal of this version is simple: use ParancU as a retrieval backend for an agent without moving retrieval logic into the agent itself.

## What it does

A user can:

1. attach a `.txt` file in Slack
2. ask a question
3. let ParancU prepare and index the text
4. retrieve supporting evidence
5. continue asking questions in the same Slack thread

Each Slack user/thread pair gets its own isolated ParancU environment.

```text
Slack
  ↓
Slack agent
  ↓
OpenAI tool-calling agent
  ↓
ParancU tool
  ↓
ParancU API
  ↓
E5 + retrieval
