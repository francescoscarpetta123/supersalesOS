FROM node:20-alpine
WORKDIR /app

# Workspace install: single node_modules tree at repo root
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
