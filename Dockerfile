# Minimal image for Glama / MCP introspection.
# Veris is a local-first tool — this image exists so Glama can spin up the MCP
# server, run introspection, and verify the 17 tools. Real users install via:
#   npx -y veris-core
FROM node:20-alpine

WORKDIR /app

# Install veris-core globally from npm. Pin to a specific version for
# reproducible builds. Bump on each release.
RUN npm install -g veris-core@2.1.8

# Sanity: make sure the binary resolves.
RUN veris --version

# MCP server speaks stdio. Glama will exec the container and pipe stdin/stdout.
ENTRYPOINT ["veris", "mcp"]
