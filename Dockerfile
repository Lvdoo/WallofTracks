FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker can reuse this layer when code changes.
# .env is NOT copied into the image (see .dockerignore) — secrets stay at runtime.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
