# Imagen del scraper Tourplan (Node + Chromium headless).
# Sirve para: (1) probar containerizado en EC2, (2) base para Lambda (parte 2).
# Se mantiene Node (no Python): Playwright/Chromium corre igual en container.
FROM node:20-bookworm

WORKDIR /app

# 1) Dependencias de Node (capa cacheable)
COPY package*.json ./
RUN npm install

# 2) Chromium + libs del SO (headless). Version-matched con el playwright instalado.
RUN npx playwright install --with-deps chromium

# 3) Salesforce CLI (el worker lo usa para query/update)
RUN npm install -g @salesforce/cli

# 4) Codigo del scraper
COPY . .
# Normaliza fin de linea del entrypoint (por si viene con CRLF de Windows) + permisos
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

# Headless SIEMPRE dentro del container (no hay pantalla)
ENV TP_HEADLESS=true
ENV NODE_ENV=production

ENTRYPOINT ["./docker-entrypoint.sh"]
