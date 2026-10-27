# Despliegue en producción (PM2 + Nginx Proxy Manager)

| Servicio | Dominio | Proceso PM2 | Puerto interno |
|---|---|---|---|
| API (NestJS) | https://apiposi.softkilla.es | `posi-api` | 4010 (`PORT` en `.env`) |
| Panel (Next.js) | https://pos.softkilla.es | `posi-dashboard` | 3010 (`ecosystem.config.js`) |

Los certificados SSL los gestiona Nginx Proxy Manager (NPM); las apps solo escuchan HTTP en el servidor.

## 0. Requisitos (una vez)
```bash
node -v            # 18.18 o superior (recomendado 20 LTS o 22 LTS)
npm i -g pm2       # si no está instalado
ss -ltnp | grep -E ':(4010|3010)\b'   # deben estar libres; si no, cambia el puerto
```
PostgreSQL con una base creada para el POS (ej. `restaurant_pos`) y su usuario.

## 1. API — `~/projects/posi_api`
`.env` de producción (no se versiona):
```env
DATABASE_URL="postgresql://USUARIO:CONTRASENA@localhost:5432/restaurant_pos"
JWT_SECRET="<aleatorio largo>"           # openssl rand -hex 32
JWT_REFRESH_SECRET="<otro aleatorio largo>"
PORT=4010
NODE_ENV=production
CORS_ORIGINS=https://pos.softkilla.es
```
Instalar, migrar, compilar y levantar:
```bash
cd ~/projects/posi_api
git pull
npm ci
npx prisma generate
npx prisma migrate deploy      # aplica las migraciones; NUNCA usar migrate dev/reset en producción
npm run build
pm2 start ecosystem.config.js  # la primera vez; luego: pm2 reload posi-api
curl -s http://localhost:4010/health   # {"status":"ok","db":true,...}
```
Primera vez con base vacía: crear restaurante y admin.
```bash
npx prisma db seed                                   # restaurante + datos de ejemplo si está vacía
npm run create-admin -- tu@correo.com "ClaveSegura" "Tu nombre"
```

## 2. Panel — `~/projects/posi_dashboard`
`NEXT_PUBLIC_API_BASE` se incrusta al compilar: debe existir ANTES de `npm run build`.
```bash
cd ~/projects/posi_dashboard
git pull
echo 'NEXT_PUBLIC_API_BASE=https://apiposi.softkilla.es' > .env.production
npm ci
npm run build
pm2 start ecosystem.config.js  # la primera vez; luego: pm2 reload posi-dashboard
curl -sI http://localhost:3010/login | head -1      # HTTP/1.1 200 OK
```

## 3. PM2 al reiniciar el servidor (una vez)
```bash
pm2 save
pm2 startup      # ejecuta el comando sudo que imprime
```

## 4. Nginx Proxy Manager — dos Proxy Hosts
| Campo | API | Panel |
|---|---|---|
| Domain Names | `apiposi.softkilla.es` | `pos.softkilla.es` |
| Scheme | `http` | `http` |
| Forward Hostname / IP | IP del servidor (ver nota) | IP del servidor |
| Forward Port | `4010` | `3010` |
| **Websockets Support** | **activado** (Socket.IO, tiempo real) | activado |
| Block Common Exploits | activado | activado |
| SSL | certificado del dominio, **Force SSL** y HTTP/2 | igual |

Nota: si NPM corre en Docker, `localhost`/`127.0.0.1` es el propio contenedor. Usa la IP LAN del servidor
(`hostname -I`) o `172.17.0.1` (puerta de enlace de Docker). Si usas un Nginx propio entre NPM y las apps,
apunta NPM a ese Nginx y en el `location` añade `proxy_set_header Upgrade $http_upgrade;`,
`proxy_set_header Connection "upgrade";`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
y `proxy_http_version 1.1;`.

## 5. Actualizar después de un `git push`
```bash
# API
cd ~/projects/posi_api && git pull && npm ci && npx prisma generate && npx prisma migrate deploy && npm run build && pm2 reload posi-api
# Panel
cd ~/projects/posi_dashboard && git pull && npm ci && npm run build && pm2 reload posi-dashboard
```

## 6. Comprobar
- https://apiposi.softkilla.es/health → `"status":"ok"`.
- https://pos.softkilla.es → login. En el indicador superior debe decir **“En vivo”** (Socket.IO por wss).
- Impresión térmica (Web Serial/Bluetooth) funciona porque el panel va en https.
- Logs: `pm2 logs posi-api` / `pm2 logs posi-dashboard`. Estado: `pm2 ls`.
- App de meseros: en “Servidor” usar `https://apiposi.softkilla.es`.
