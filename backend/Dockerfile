FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build
EXPOSE 5001
CMD ["sh", "-c", "npx prisma db push && npm run start"]
