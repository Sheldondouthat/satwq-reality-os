# SATWQ // God's Eye — Reality OS
# Production image: one Node process serving dist/ + the /api/* providers.
# Listens on $PORT bound to 0.0.0.0. Default 80 suits hosts with a fixed
# port convention and no PORT injection (e.g. Back4App Containers);
# platforms that inject PORT at runtime (Render, etc.) override this.
# NODE_OPTIONS caps the heap for small (256 MB) free-tier containers.

FROM node:24-slim

WORKDIR /app

# Install first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the app bundle.
COPY . .
RUN npm run build

ENV PORT=80
ENV HOST=0.0.0.0
ENV NODE_OPTIONS=--max-old-space-size=192
EXPOSE 80

CMD ["npm", "start"]
