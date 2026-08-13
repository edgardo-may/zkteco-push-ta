# ZKTeco Attendance Push Connector

Servicio independiente en **Node.js + TypeScript** que implementa el protocolo **ZKTeco Attendance Push / TA Push (ADMS)**. Diseñado para recibir marcajes de asistencia en tiempo real de terminales biométricas **ZKTeco SpeedFace y SenseFace**, procesarlas con filtros de duplicados (idempotencia) y registrarlas directamente en Supabase de forma multi-tenant.

---

## 1. Arquitectura del Sistema

La arquitectura de comunicación se estructura de la siguiente manera:

```text
ZKTeco SpeedFace / SenseFace (Física)
          ↓ (Protocolo TA Push / HTTP / HTTPS)
ZKTeco TA Push Connector (Express + Node.js + TS) [Bypassa RLS usando Service Role Key]
          ↓ (Supabase JS SDK)
Supabase (Base de datos PostgreSQL en la Nube)
          ↑ (Supabase JS SDK con RLS habilitado)
React Frontend (Dashboard Administrativo)
```

### Flujo de Comunicación ADMS:
1. **Handshake (`GET /iclock/cdata`)**: La terminal se conecta, se valida que esté registrada en la tabla `devices` y autorizada por el tenant en `dispositivos`. El servidor responde con los parámetros de configuración.
2. **Heartbeat (`GET /iclock/getrequest`)**: El dispositivo consulta periódicamente si hay comandos pendientes en la tabla `device_commands`.
3. **Logs de Asistencia (`POST /iclock/cdata?table=ATTLOG`)**: El dispositivo sube los marcajes en lotes de texto plano. El conector los parsea, descarta registros ya guardados (idempotencia) y los registra en `attendance_logs`.
4. **Respuesta a Comandos (`POST /iclock/devicecmd`)**: La terminal reporta el estado de ejecución del comando recibido, y el conector marca el comando como ejecutado en `device_commands`.

---

## 2. Requisitos Previos

- **Node.js**: Versión 18 o superior.
- **Base de datos**: Proyecto de Supabase activo con las tablas `devices`, `dispositivos`, `attendance_logs` y `device_commands` creadas.
- **Acceso a red**: El conector debe ser accesible por las terminales biométricas mediante HTTP o HTTPS.

---

## 3. Instalación

1. Navega al directorio del conector:
   ```bash
   cd zkteco-ta-push
   ```
2. Instala las dependencias:
   ```bash
   npm install
   ```

---

## 4. Variables de Entorno

Crea un archivo `.env` en la raíz de la carpeta `zkteco-ta-push` (puedes basarte en `.env.example`):

```env
# Puerto de escucha del servidor (Nginx redirige 443 -> 3000)
PORT=3000

# URL de tu proyecto de Supabase (Settings -> API)
SUPABASE_URL=https://tu-proyecto.supabase.co

# LLave de acceso service_role de Supabase (Requerido para bypass de RLS en escrituras del backend)
SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key-secreta

# Secreto opcional para validar comunicación del biométrico (si se configura clave de comunicación)
ZK_PUSH_SECRET=
```

> [!WARNING]
> NUNCA subas el archivo `.env` a sistemas de control de versiones (Git). Ya está excluido en el archivo `.gitignore` del proyecto.

---

## 5. Desarrollo Local y Pruebas

Para arrancar el conector en modo desarrollo con recarga automática:

```bash
npm run dev
```

El servidor iniciará en el puerto especificado (por defecto `3000`).

### Pruebas Automatizadas
Para ejecutar la suite de pruebas unitarias e integración (que simulan el protocolo físico completo mediante mocks de la base de datos):

```bash
npm test
```

---

## 6. Configuración de ngrok / Cloudflare Tunnel (Desarrollo Local)

Las terminales físicas requieren comunicarse con un dominio accesible. Si estás desarrollando en tu máquina local, debes exponer tu puerto local a internet:

### Opción A: ngrok
1. Ejecuta ngrok apuntando al puerto de tu servidor local:
   ```bash
   ngrok http 3000
   ```
2. Copia la URL HTTPS generada (ej. `https://a1b2-cd34.ngrok-free.app`). Esta será la dirección que colocarás en tu biométrico.

### Opción B: Cloudflare Tunnel
1. Ejecuta el túnel rápido de Cloudflare:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
2. Copia la URL HTTPS provista por Cloudflare.

---

## 7. Configuración del Dispositivo ZKTeco (SpeedFace / SenseFace)

Para conectar tu dispositivo SpeedFace o SenseFace al conector:

1. Entra al menú del dispositivo biométrico.
2. Ve a **Red** (Network) -> **Configuración de Servidor ADMS** (o **Servidor Cloud** / **ADMS**).
3. Configura los siguientes campos:
   - **Habilitar Servidor Cloud / ADMS**: `Sí` (ON)
   - **Dirección del Servidor**: La IP de tu VPS, dominio de producción o URL de ngrok/Cloudflare (ej. `a1b2-cd34.ngrok-free.app` - **nota**: no incluyas `https://` o `http://` en este campo en la terminal, pon solo el dominio/host).
   - **Puerto del Servidor**: `80` (si es HTTP) o `443` (si es HTTPS / túnel seguro).
   - **Habilitar HTTPS**: Activa esta casilla si tu servidor o túnel usa HTTPS.
   - **Ruta de Servidor / Server Path**: `/iclock`
4. Guarda los cambios y reinicia la terminal si es necesario.

---

## 8. Flujo de Administración en React

Para dar de alta y verificar un biométrico:

1. **Registrar Dispositivo**:
   - Entra al dashboard de **Signum-Clock** -> **Biométricos** -> **Dispositivos**.
   - Haz clic en **Registrar Nueva Terminal**.
   - Rellena el **Nombre Descriptivo**, **Número de Serie (SN)** exacto del dispositivo (viene en la etiqueta física o menú de información), la **Ubicación**, **Dirección IP** (opcional) y **Zona Horaria** de la terminal.
   - Guarda el registro.
2. **Obtener URL para el dispositivo**:
   - Una vez registrado, haz clic sobre el dispositivo para abrir el modal de **Detalle**.
   - En la pestaña **Ficha Técnica & Red**, verás una tarjeta azul con los parámetros exactos calculados dinámicamente que debes ingresar en el dispositivo físico.
3. **Verificar Conexión**:
   - Cuando el dispositivo se conecte con éxito por primera vez, verás el estado como **Activa / Online**.
   - La columna **Última Actividad** se actualizará automáticamente con la fecha y hora de la última petición recibida del biométrico.

---

## 9. Despliegue en Producción (Google Cloud VM Ubuntu)

El servicio debe desplegarse en la ruta `/opt/zkteco-ta-push` de tu VM Ubuntu y configurarse para ejecutarse de manera continua.

### Opción A: PM2 (Recomendada para Producción)
PM2 mantendrá el servicio ejecutándose continuamente en segundo plano y lo reiniciará si el proceso se cae o se reinicia la máquina:

1. Clona el proyecto o muévelo al directorio `/opt/zkteco-ta-push` de la máquina.
2. Navega al directorio e instala dependencias:
   ```bash
   cd /opt/zkteco-ta-push
   npm install --omit=dev
   ```
3. Compila el código TypeScript a JavaScript:
   ```bash
   npm run build
   ```
4. Configura las variables de producción en el archivo `.env`.
5. Arranca el servicio con PM2:
   ```bash
   pm2 start dist/server.js --name "zkteco-ta-push"
   ```
6. Configura PM2 para que inicie automáticamente al encender la VM:
   ```bash
   pm2 startup systemd
   pm2 save
   ```

### Opción B: Docker
Construye y corre la imagen de Docker utilizando las variables de entorno configuradas:

```bash
# Construir la imagen
docker build -t zkteco-ta-push .

# Ejecutar el contenedor expuesto en el puerto 3000
docker run -d \
  -p 3000:3000 \
  -e SUPABASE_URL="https://tu-proyecto.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="tu-key" \
  --name zkteco-connector \
  zkteco-ta-push
```

---

## 10. Monitoreo y Logs del Conector

El conector genera salidas estructuradas en consola para facilitar el diagnóstico. Los logs principales que verás son:

- `[SERVER INIT]`: Arranque inicial del conector Express.
- `[DEVICE CONNECT]`: Cuando un dispositivo realiza el handshake inicial.
- `[DEVICE IDENTIFIED]`: Cuando el dispositivo es verificado y asociado correctamente a su tenant.
- `[DEVICE UNKNOWN]`: Cuando se rechaza una conexión porque el SN no está registrado o no tiene tenant asignado.
- `[HEARTBEAT]`: Petición de estado periódico enviada por el dispositivo.
- `[ATTENDANCE RECEIVED]`: Recepción de trama de marcación desde la terminal.
- `[ATTENDANCE SAVED]`: Marcación guardada con éxito en Supabase tras pasar filtros de empleado activo y duplicados.
- `[ATTENDANCE DUPLICATE]`: Marcación ignorada porque ya existía en la base de datos (idempotencia).
- `[COMMAND QUEUED]`: Comando enviado desde el frontend en espera.
- `[COMMAND SENT]`: Comando entregado al dispositivo al hacer su consulta periódica.
- `[COMMAND SUCCESS]`: El dispositivo confirma la ejecución correcta del comando.
- `[COMMAND ERROR]`: El dispositivo reportó una falla al ejecutar el comando enviado.
- `[DEVICE ERROR]`: Errores de validación generales.

### Comandos ADMS Compatibles:
Puedes emitir comandos remotos desde la cola `device_commands`. Los comandos reales soportados son:
- `REBOOT`: Fuerza un reinicio del dispositivo físico.
- `INFO`: Solicita la información técnica (firmware, espacio libre, versión) del terminal.
- `CLEAR_ATTENDANCE_LOGS`: Borra los registros de asistencia almacenados en la memoria interna del dispositivo.

### Ejemplo de Log de Éxito:
```text
[2026-08-13T05:45:19.008Z] [DEVICE IDENTIFIED] Device SN: ZKTEST123 authorized and identified for tenant: tenant_company_a from IP: ::1
[2026-08-13T05:45:19.009Z] [DEVICE CONNECT] Device SN: ZKTEST123 initialized connection | Meta: {"ip":"::1","name":"SpeedFace Main Entrance","timezone":"America/Mexico_City"}
[2026-08-13T05:45:19.043Z] [HEARTBEAT] Heartbeat received from device SN: ZKTEST123
[2026-08-13T05:45:19.102Z] [ATTENDANCE SAVED] Saved log: user EMP201 at 2026-08-13T05:00:00.000Z status: check_in for device: ZKTEST123
[2026-08-13T05:45:19.110Z] [ATTENDANCE DUPLICATE] Skipped 1 duplicate logs for device ZKTEST123
```

---

## 11. Troubleshooting (Resolución de Problemas)

1. **El biométrico no se conecta (Estatus permanece offline)**:
   - Revisa que el puerto esté abierto en el firewall de tu servidor (ej. 3000 o 80/443 si usas proxy inverso).
   - Verifica que el dispositivo biométrico tenga salida a internet (haz ping desde el menú de red del biométrico).
   - Asegúrate de haber escrito el número de serie (SN) exactamente igual en la base de datos y en la terminal.
2. **Error `UNAUTHORIZED: Device not registered` en logs**:
   - Significa que el dispositivo biométrico con el SN enviado no está dado de alta en la tabla `devices` de Supabase. Regístralo en la pantalla de administración de React.
3. **Error `UNAUTHORIZED: No tenant mapping found`**:
   - Significa que el dispositivo con el SN indicado existe en `devices`, pero no está vinculado a ningún cliente en la tabla `dispositivos`.
4. **Los marcajes no se registran (Duplicados o Rechazados)**:
   - Si el conector detecta que un marcaje para el mismo usuario (`user_id` / `clave_empleado`), dispositivo (`device_serial`) y marca de tiempo (`timestamp`) ya existe en `attendance_logs`, omitirá la inserción para evitar duplicidad de registros (`[ATTENDANCE DUPLICATE]`).
   - Si el conector detecta que el ID biométrico no está asignado a ningún colaborador activo de la empresa en `device_employee_assignments`, lo rechazará (`[DEVICE ERROR] Log rejected: Employee ZK-PIN...`). Asegúrate de que el empleado esté asignado a ese biométrico con su respectivo ID en la tabla de asignaciones y en estado activo.

---

## 12. Sincronización Automática de Colaboradores

El conector incluye un mecanismo de sincronización de colaboradores en tiempo real hacia las terminales físicas a través del flujo de comandos ADMS.

### Flujo de Estados de Sincronización:
1. **PENDING**: Se crea o modifica una asignación en `device_employee_assignments` (con `activo = true` para dar de alta/modificar o `activo = false` para dar de baja). El trigger de Postgres encola el comando correspondiente en `device_commands`.
2. **SYNCING**: El biométrico hace su consulta periódica (`GET /iclock/getrequest`), el conector le despacha el comando y marca el estado de la asignación como `SYNCING`, registrando la hora en `last_attempt_at`.
3. **SYNCED**: El biométrico ejecuta el comando y reporta éxito (`POST /iclock/devicecmd` con `Return=0`). El conector actualiza el estado a `SYNCED` y registra la marca temporal en `last_synced_at`.
4. **ERROR**: Si el biométrico reporta un código de fallo (ej. `Return=-1`), la asignación pasa al estado `ERROR`, guardando el error en `last_error` e incrementando el contador de intentos (`retry_count`).

### Comandos de Terminal Generados por Trigger:
- **Alta/Actualización**: `DATA UPDATE USERINFO Pin=<biometric_user_id>\tName=<nombre_empleado>\tPri=0\tCardNo=<tarjeta>`
- **Baja/Desactivación**: `DATA DELETE USERINFO Pin=<biometric_user_id>`
