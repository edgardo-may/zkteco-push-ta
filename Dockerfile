# ──────────────────────────────────────────────────────────────
#  SIGNUM-CLOCK · ZKTeco TA Push Connector Dockerfile
#  Docker image basada en Node Alpine para mínimo footprint
# ──────────────────────────────────────────────────────────────

# 1. Builder Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar manifiestos
COPY package*.json ./
COPY tsconfig.json ./

# Instalar todas las dependencias
RUN npm ci

# Copiar código fuente
COPY src/ ./src/

# Compilar TypeScript a JavaScript en dist/
RUN npm run build

# 2. Production Stage
FROM node:20-alpine

# Metadatos
LABEL maintainer="Signum-Clock" \
      description="ZKTeco Attendance Push Connector → Supabase"

WORKDIR /app

# Copiar manifiesto
COPY package*.json ./

# Instalar solo dependencias de producción
RUN npm ci --omit=dev

# Copiar archivos compilados del builder stage
COPY --from=builder /app/dist ./dist

# Puerto HTTP de escucha por defecto
EXPOSE 5000

# Variables de entorno por defecto
ENV NODE_ENV=production \
    PORT=5000

# Punto de entrada
CMD ["node", "dist/server.js"]
