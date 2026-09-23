FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /app/data /app/auth_info /app/knowledge && chown node:node /app/data /app/auth_info /app/knowledge
USER node
CMD ["node", "src/whatsapp.js"]
