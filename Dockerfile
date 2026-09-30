FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY db ./db
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
