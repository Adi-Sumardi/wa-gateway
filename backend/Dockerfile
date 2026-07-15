FROM node:20-slim

# Install OpenSSL and Certificates required by Prisma database engine
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build
EXPOSE 5001
CMD ["sh", "-c", "npx prisma db push && npm run start"]
