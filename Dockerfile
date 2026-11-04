# ==========================================
# FolioTrack - Dockerfile per UGREEN NAS (UGOS) & Linux
# Node.js 22 LTS Alpine con dumb-init e compilazione nativa C++
# ==========================================

# 1. Builder Stage: compilazione moduli nativi (better-sqlite3)
FROM node:22-alpine AS builder

# Installa strumenti di compilazione C++ per Alpine
RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

# Copia manifesti npm e installa solo dipendenze di produzione
COPY package*.json ./
RUN npm ci --omit=dev

# 2. Production Runner Stage: immagine snella e sicura
FROM node:22-alpine AS runner

# Installa dumb-init (gestione segnali PID 1 per chiusura atomica SQLite), tzdata e wget per healthcheck
RUN apk add --no-cache dumb-init tzdata wget libstdc++

WORKDIR /app

# Variabili d'ambiente predefinite
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Europe/Rome \
    DB_PATH=/app/data/foliotrack.db \
    BACKUP_DIR=/app/data/backups

# Copia dipendenze precompilate dallo stage builder
COPY --from=builder /app/node_modules ./node_modules

# Copia il codice dell'applicazione
COPY . .

# Crea cartella dati con permessi di scrittura
RUN mkdir -p /app/data /app/data/backups

# Esponi porta applicativa
EXPOSE 3000

# Healthcheck per Docker & UGOS (verifica stato SQLite e risposte HTTP)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD wget -qO- http://localhost:3000/api/health | grep '"status":"ok"' || exit 1

# Usa dumb-init come PID 1 per inoltrare correttamente SIGTERM e prevenire corruzione DB
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Avvio server FolioTrack
CMD ["node", "src/server.js"]

