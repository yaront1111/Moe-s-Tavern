# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S moe && \
    adduser -S moe -u 1001 -G moe

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create volume mount point for .moe directory
RUN mkdir -p /project/.moe && chown -R moe:moe /project

# Switch to non-root user
USER moe

# Expose WebSocket port
EXPOSE 3141

# Set default project path
ENV MOE_PROJECT_PATH=/project

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3141/health || exit 1

# Start daemon
ENTRYPOINT ["node", "dist/index.js"]
CMD ["start", "--project", "/project"]
