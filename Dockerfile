FROM node:24-alpine
WORKDIR /tracker
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
EXPOSE 3000
CMD ["node", "server.js"]