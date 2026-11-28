# Lecture 22: image for one API replica (same build for every replica). Dev/lab image: runs the TypeScript
# sources through tsx like `npm start`; a production image would compile first. No secrets are baked in:
# configuration arrives through environment variables at run time.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
USER node
# exec form + `node` as PID 1: SIGTERM reaches the app's own shutdown handler directly (no npm/sh wrapper).
CMD ["node", "--import", "tsx", "src/server.ts"]
