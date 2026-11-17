FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY auth.js /usr/share/nginx/html/auth.js
COPY default.conf.template /etc/nginx/templates/default.conf.template
