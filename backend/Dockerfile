FROM node:20-slim

WORKDIR /app

COPY package*.json ./

# npm install (not ci) so newly added deps resolve even if the lockfile predates them.
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
ENV USE_HTTPS=false

EXPOSE 8080

CMD ["node", "src/server.js"]