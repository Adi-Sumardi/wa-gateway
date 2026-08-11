FROM node:20-slim

# Prisma's query engine needs OpenSSL - node:20-alpine's musl/OpenSSL-3 combo
# doesn't ship libssl.so.1.1 that the engine binary links against, so this
# uses the same debian-slim + openssl pattern the (working) legacy monolith
# Dockerfile already used.
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
EXPOSE 6001
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npm start"]
