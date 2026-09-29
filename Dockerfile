# Glama builds every listed server in a sandbox and runs MCP protocol
# introspection against it (tools/list, resources/list, prompts/list), which is
# what the badge on the registry entry scores.
#
# This image therefore only has to start and answer those requests. It cannot
# actually generate an image: that needs a Windows host with the Codex desktop
# app running and a DevTools port open. See README, "Requirements".
FROM node:22-alpine

WORKDIR /app
COPY . .

# Zero runtime dependencies — plain Node ESM, so there is no install step.
CMD ["node", "mcp-server.mjs"]
