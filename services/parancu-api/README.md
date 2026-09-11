# ParancU API 0.1

ParancU API exposes ParancU retrieval as a local HTTP service and connects it to a Slack agent.

## Current flow

```text
.txt file
    ↓
Slack thread
    ↓
isolated environment
    ↓
ParancU corpus preparation
    ↓
evidence retrieval
    ↓
Slack response
