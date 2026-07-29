FROM node:20-slim

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Uploaded PDFs live here; mount a volume over it in compose so they survive
# container restarts.
RUN mkdir -p uploads

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
