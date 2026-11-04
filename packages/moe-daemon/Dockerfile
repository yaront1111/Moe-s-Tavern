# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install --no-audit --no-fund

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:24-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S moe && \
    adduser -S moe -u 1001 -G moe

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --no-audit --no-fund --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create volume mount point for .moe directory
RUN mkdir -p /project/.moe && chown -R moe:moe /project

# Switch to non-root user
USER moe

# Expose WebSocket port (daemon default; keep in sync with MOE_DEFAULT_PORT)
EXPOSE 9876

# Default project path. Mount the project at the absolute path it has on the host and set MOE_PROJECT_PATH
# to it: the daemon reports this path in .moe/daemon.json and on /health, and moe-proxy and the IDE plugins
# refuse a daemon that reports another project's path.
ENV MOE_PROJECT_PATH=/project

# Listen on the container's own interfaces: a published port (-p) reaches the container's network
# interface, never its loopback. Publish on host loopback only (-p 127.0.0.1:9876:9876): /mcp has no auth.
ENV MOE_BIND_HOST=0.0.0.0

# Health check on IPv4 loopback: busybox wget tries localhost as ::1 first, which a 0.0.0.0 bind does not serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:9876/health || exit 1

# Start daemon; the project comes from MOE_PROJECT_PATH.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
