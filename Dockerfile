# SATWQ // God's Eye — Reality OS
# Production image: one Node process serving dist/ + the /api/* providers.
# Listens on $PORT (platforms like Render inject PORT at runtime;
# the default below applies when no PORT is provided).

FROM node:24-slim

WORKDIR /app

# Install first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the app bundle.
COPY . .
RUN npm run build

ENV PORT=7860
ENV HOST=0.0.0.0
EXPOSE 7860

CMD ["npm", "start"]
