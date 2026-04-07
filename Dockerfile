FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/
RUN npm install --prefix client
RUN npm install --prefix server
COPY . .
RUN npm run build --prefix client
EXPOSE 3001
CMD ["node", "server/index.js"]
