FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production UPLOAD_DIR=/data/uploads
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
