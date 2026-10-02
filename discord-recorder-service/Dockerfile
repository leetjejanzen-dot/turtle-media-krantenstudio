FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./

RUN mkdir -p /app/recordings && chown -R node:node /app
USER node

EXPOSE 3210
CMD ["node", "server.js"]
