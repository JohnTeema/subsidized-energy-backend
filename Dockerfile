FROM node:20-slim

# Prisma needs openssl; libatomic1 required by some native addons (growatt, anchor)
RUN apt-get update -y && apt-get install -y openssl libatomic1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips postinstall so prisma migrate deploy doesn't run
# before the schema is present or a database is reachable
RUN npm install --ignore-scripts

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]
