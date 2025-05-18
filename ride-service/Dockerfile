FROM node:23-alpine

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]