#!/bin/bash

# SendaGo WA Gateway Deployment Script
# Codename: SendaGo Hub

set -e

# Visual styling
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "=========================================================="
echo "         SendaGo WhatsApp Gateway - Deploy System         "
echo "=========================================================="
echo -e "${NC}"

# Check for Node.js (required for local deployment)
check_node() {
  if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[Warning] Node.js is not installed. Required for local Method B.${NC}"
    return 1
  else
    echo -e "${GREEN}[Ok] Node.js is installed: $(node -v)${NC}"
    return 0
  fi
}

# Check for Docker (required for Docker Method A)
check_docker() {
  if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}[Warning] Docker is not running/installed. Required for Method A.${NC}"
    return 1
  else
    echo -e "${GREEN}[Ok] Docker is installed: $(docker -v)${NC}"
    return 0
  fi
}

check_node || true
check_docker || true

echo ""
echo -e "${CYAN}Choose your deployment method:${NC}"
echo "1) Docker Compose (Recommended for Production & VPS)"
echo "2) Local Manual Setup (Best for local developer environments)"
read -p "Enter choice (1 or 2): " DEPLOY_METHOD

if [ "$DEPLOY_METHOD" == "1" ]; then
  # ----------------------------------------------------
  # DOCKER COMPOSE METHOD
  # ----------------------------------------------------
  echo -e "\n${CYAN}>>> Initiating Docker Compose Deployment...${NC}"
  
  if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}[Error] Docker Compose command not found! Please install Docker Compose first.${NC}"
    exit 1
  fi

  # Build & run containers
  echo -e "${CYAN}Building and starting SendaGo containers...${NC}"
  if command -v docker-compose &> /dev/null; then
    docker-compose up --build -d
  else
    docker compose up --build -d
  fi

  echo -e "\n${GREEN}==========================================================${NC}"
  echo -e "${GREEN}[SUCCESS] SendaGo has been successfully deployed via Docker!${NC}"
  echo -e "  - Frontend Dashboard: http://localhost:5173"
  echo -e "  - Backend Rest API:   http://localhost:5001"
  echo -e "  - Default User:       admin@sendago.com / admin12345"
  echo -e "${GREEN}==========================================================${NC}"

else
  # ----------------------------------------------------
  # LOCAL MANUAL METHOD
  # ----------------------------------------------------
  echo -e "\n${CYAN}>>> Initiating Local Manual Deployment...${NC}"
  
  # Step 1: Install Backend dependencies and run Prisma setup
  echo -e "\n${CYAN}[1/3] Setting up Backend API service...${NC}"
  cd backend
  if [ ! -f .env ]; then
    echo -e "${YELLOW}[Warning] backend/.env file not found. Creating default local SQLite/PG env template...${NC}"
    echo "DATABASE_URL=\"postgresql://postgres:postgres@localhost:5432/sendago?schema=public\"" > .env
    echo "JWT_SECRET=\"sendago-super-secret-jwt-key\"" >> .env
    echo "GATEWAY_TOKEN=\"sendago-gateway-secret-token\"" >> .env
    echo "PORT=5001" >> .env
    echo "CORS_ORIGIN=\"http://localhost:5173\"" >> .env
  fi
  
  echo "Installing npm dependencies in backend..."
  npm install
  
  echo "Generating Prisma Client..."
  npx prisma generate
  
  echo "Pushing schema definitions to local PostgreSQL database..."
  npx prisma db push
  
  echo "Seeding default admin credentials..."
  npm run prisma:seed || true
  
  echo "Compiling backend TypeScript..."
  npm run build
  cd ..

  # Step 2: Install Gateway dependencies
  echo -e "\n${CYAN}[2/3] Setting up Gateway automation engine...${NC}"
  cd gateway
  if [ ! -f .env ]; then
    echo "BACKEND_URL=\"http://localhost:5001\"" > .env
    echo "GATEWAY_TOKEN=\"sendago-gateway-secret-token\"" >> .env
    echo "MIN_SEND_DELAY=3000" >> .env
    echo "MAX_SEND_DELAY=7000" >> .env
  fi
  echo "Installing npm dependencies in gateway..."
  npm install
  echo "Compiling gateway TypeScript..."
  npm run build
  cd ..

  # Step 3: Install Frontend dashboard
  echo -e "\n${CYAN}[3/3] Setting up Frontend dashboard panel...${NC}"
  cd frontend
  echo "Installing npm dependencies in frontend..."
  npm install
  echo "Compiling production static assets (Vite)...${NC}"
  npm run build
  cd ..

  echo -e "\n${GREEN}==========================================================${NC}"
  echo -e "${GREEN}[SUCCESS] SendaGo components built successfully!${NC}"
  echo -e "To start your services, open 3 terminal tabs and execute:"
  echo -e "  - Tab 1 (Backend API): cd backend && npm run dev"
  echo -e "  - Tab 2 (Gateway Node): cd gateway && npm run dev"
  echo -e "  - Tab 3 (Vite Client): cd frontend && npm run dev"
  echo -e "  - Default credentials: admin@sendago.com / admin12345"
  echo -e "${GREEN}==========================================================${NC}"
fi
