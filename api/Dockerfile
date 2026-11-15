# Imagen base oficial de Node sobre Alpine Linux (liviana)
FROM node:22-alpine

WORKDIR /app

# Primero solo las dependencias: si no cambian, Docker reutiliza esta capa (cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Después el código y las migraciones que aplica al arrancar
COPY src ./src
COPY migrations ./migrations

EXPOSE 3000
CMD ["node", "src/index.js"]
