FROM node:20-slim

# Build tools for native addons (bigint, growatt, anchor) + openssl for Prisma TLS
RUN apt-get update -y \
    && apt-get install -y python3 make g++ build-essential openssl libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# prisma/ must be present before npm install so postinstall (prisma generate) can run
COPY prisma ./prisma

RUN npm install

COPY . .
RUN npm run build

# Cap Node heap to stay within Render free tier (512 MB container)
ENV NODE_OPTIONS=--max-old-space-size=384

EXPOSE 3001

CMD ["npm", "start"]
