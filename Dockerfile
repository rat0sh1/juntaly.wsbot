FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Directorios de persistencia para el usuario 'node' (UID 1000); en el VPS se montan desde el host.
RUN mkdir -p /app/data /app/auth_info /app/knowledge && \
    chown node:node /app/data /app/auth_info /app/knowledge
USER node
CMD ["node", "src/whatsapp.js"]
