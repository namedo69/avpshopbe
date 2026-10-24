FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files from backend directory
COPY backend/package*.json ./
RUN npm install

# Copy source code and config
COPY backend/ ./
RUN npm run build

# Production image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules and built files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
