FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/
COPY data/ ./data/

USER node

CMD ["node", "src/index.js"]
