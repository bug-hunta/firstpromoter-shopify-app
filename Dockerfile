FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Leave NODE_ENV unset so npm ci installs vite (a devDependency) for the build.
RUN npm ci && npm cache clean --force

COPY . .

# prisma generate reads DATABASE_URL from the schema but does not connect.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npx prisma generate \
  && npm run build

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
