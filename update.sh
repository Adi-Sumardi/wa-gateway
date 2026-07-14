#!/bin/bash

# SendaGo WA Gateway Update Script
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
echo "          SendaGo WhatsApp Gateway - Update System        "
echo "=========================================================="
echo -e "${NC}"

# Step 1: Pull from git repository if available
if [ -d .git ]; then
  echo -e "${CYAN}>>> Pulling latest source code from git repository...${NC}"
  git pull || echo -e "${YELLOW}[Warning] Git pull failed, proceeding with local build updates...${NC}"
else
  echo -e "${YELLOW}>>> Not a git repository or git folder not found. Syncing local source code...${NC}"
fi

# Ask if running in Docker or Manual
echo ""
echo -e "${CYAN}Which deployment environment are you updating?${NC}"
echo "1) Docker Compose"
echo "2) Local Manual Setup"
read -p "Enter choice (1 or 2): " DEPLOY_ENV

if [ "$DEPLOY_ENV" == "1" ]; then
  # ----------------------------------------------------
  # DOCKER UPDATE MODE
  # ----------------------------------------------------
  echo -e "\n${CYAN}>>> Re-building and restarting SendaGo Docker containers...${NC}"
  
  if command -v docker-compose &> /dev/null; then
    docker-compose down
    docker-compose up --build -d
  else
    docker compose down
    docker compose up --build -d
  fi

  echo -e "\n${GREEN}==========================================================${NC}"
  echo -e "${GREEN}[SUCCESS] SendaGo Docker containers successfully updated!${NC}"
  echo -e "${GREEN}==========================================================${NC}"

else
  # ----------------------------------------------------
  # LOCAL MANUAL UPDATE MODE
  # ----------------------------------------------------
  echo -e "\n${CYAN}>>> Initiating Local Manual Code Rebuild...${NC}"
  
  # Step 1: Sync backend
  echo -e "\n${CYAN}[1/3] Syncing and Re-compiling Backend...${NC}"
  cd backend
  npm install
  npx prisma generate
  npx prisma db push
  npm run build
  cd ..

  # Step 2: Sync gateway
  echo -e "\n${CYAN}[2/3] Syncing and Re-compiling Gateway...${NC}"
  cd gateway
  npm install
  npm run build
  cd ..

  # Step 3: Sync frontend
  echo -e "\n${CYAN}[3/3] Syncing and Re-compiling Frontend...${NC}"
  cd frontend
  npm install
  npm run build
  cd ..

  echo -e "\n${GREEN}==========================================================${NC}"
  echo -e "${GREEN}[SUCCESS] SendaGo code packages compiled successfully!${NC}"
  echo -e "Please restart your background process runners (e.g. pm2 restart all, pm2 logs, etc.)${NC}"
  echo -e "${GREEN}==========================================================${NC}"
fi
