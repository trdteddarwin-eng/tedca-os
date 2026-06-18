# Tedca OS — single container: Node server + built React app, SQLite on /data volume
FROM node:24-alpine

WORKDIR /os

# build the frontend
COPY app/package.json app/
RUN cd app && npm install --no-audit --no-fund
COPY app app
RUN cd app && npm run build

# server
COPY server/package.json server/
RUN cd server && npm install --no-audit --no-fund
COPY server server

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV APP_DIST=/os/app/dist

EXPOSE 8790
CMD ["node", "server/src/index.js"]
