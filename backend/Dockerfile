FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
ENV USE_HTTPS=false

EXPOSE 8080

CMD ["node", "src/server.js"]