# Build stage: instala dependencias en un entorno limpio
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Production stage: imagen final ligera y segura
FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

# Copiar dependencias de producción desde el build stage
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Crear directorios para persistencia con permisos adecuados para el usuario 'node'
RUN mkdir -p /app/data /app/auth_info /app/knowledge && \
    chown -R node:node /app/data /app/auth_info /app/knowledge

USER node

CMD ["node", "src/whatsapp.js"]
