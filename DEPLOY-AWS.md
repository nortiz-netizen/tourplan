# Deploy en AWS (Parte 2)

El robot corre HOY en la PC de desarrollo. Para llevarlo a AWS (24/7, sin pantalla),
esto es lo que hay que hacer. La lógica NO cambia — solo dónde y cómo corre.

## Arquitectura (no cambia)

```
Salesforce  ←──(sf CLI, pull cada 60s)──  worker.js  ──(JSON)──→  clonar.js (Playwright)  →  Tourplan
```

El worker pregunta a Salesforce por leads PENDIENTE, arma el JSON y ejecuta el
scraper. Es PULL — no hay nada expuesto a internet, no hace falta C2 ni webhooks.

## Checklist para AWS

1. **Instancia/contenedor** con IP fija (o Elastic IP).
   - La IP fija es OBLIGATORIA: la BD SQL de Tourplan usa whitelist de IPs.
   - Sirve una EC2 chica o un contenedor (ECS/Fargate) con IP estable.

2. **Node 20+ y las dependencias de Playwright**
   - `npm ci` (instala playwright)
   - `npx playwright install --with-deps chromium` (baja Chromium + libs del SO)

3. **Modo headless**
   - En el `.env` del servidor: `TP_HEADLESS=true`
   - clonar.js ya lo soporta: con true usa el Chromium empaquetado + `--no-sandbox`
     `--disable-dev-shm-usage` (requeridos en contenedores).

4. **Credenciales fuera del repo → AWS Secrets Manager**
   - Tourplan (TP_USER/TP_PASS), backend, etc. NO en `.env` versionado.
   - Al arrancar, un script lee los secretos y arma el `.env` en runtime.

5. **Login del sf CLI (conexión a Salesforce)**
   - En la PC está logueado a mano. En AWS: usar un usuario de integración con
     JWT Bearer (Connected App) → `sf org login jwt` con la clave desde Secrets Manager.
   - Alternativa: SFDX auth URL guardada como secreto → `sf org login sfdx-url`.

6. **Correr el worker como servicio**
   - `npm run worker` bajo systemd / PM2 / el entrypoint del contenedor, para que
     reinicie solo si se cae.
   - Un solo worker a la vez (Tourplan no permite 2 sesiones de FITs → el pull de a
     uno ya lo garantiza; NO escalar a varias réplicas).

## Pendientes de negocio (no son de infra)

- Paso 3.5 del scraper (clonar servicios): falta ver el flujo real de Tourplan
  (video de Carlos/Alveiro). Ver notas en el código de `clonar.js` (faseInsertarServicios).
- Cargar la tabla `Plantilla_Tourplan__c` en Salesforce con los file reales por destino.
